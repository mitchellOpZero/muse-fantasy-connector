/**
 * Fantasy Football Connector for Meta Muse.
 *
 * Public HTTPS MCP server, Streamable HTTP, POST-only with a single JSON
 * body per response (no Server-Sent Events — Muse's egress proxy hangs on
 * SSE). Stateless: a fresh MCP server + transport is created per POST.
 *
 * Routes:
 *   POST /mcp                  JSON-RPC (initialize, tools/list, tools/call)
 *   GET/DELETE /mcp            405 (stateless by design)
 *   GET  /v1/yahoo/authorize   Yahoo OAuth PKCE start (or setup_required)
 *   POST /v1/yahoo/callback    Yahoo OAuth code exchange (server-side only)
 *   GET  /healthz              liveness
 *   GET  /muse.md /llms.txt    what Muse reads to learn the connector
 *   GET  /terms                Terms of Service
 *   GET  /privacy              Privacy Policy
 *   GET  /icon.png             512x512 connector icon
 *   GET  /                     brief landing page
 *   POST /v1/billing/webhook   Stripe webhook: verifies signature, syncs
 *                                subject -> tier entitlements (KV in prod)
 *   GET  /v1/billing/events    Admin: recent billing events (Bearer <BILLING_ADMIN_SECRET>)
 *   GET  /v1/billing/status    Public: webhook/store configuration status
 */
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { registerFantasyTools } from './fantasy.js';
import {
  parseCheckoutCompleted,
  parseSubscriptionEvent,
  verifyStripeSignature,
} from './billing.js';
import { createEntitlementStore } from './entitlements.js';
import {
  newCodeVerifier,
  yahooAuthorizeUrl,
  yahooExchangeCode,
} from './providers/yahoo.js';
import { ProviderError } from './providers/types.js';

const dirName = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8102);
const SERVER_VERSION = '0.1.0';
const SERVER_NAME = 'fantasy-football';

const cfg = loadConfig();

/** Webhook-synced subject -> tier entitlements (KV in prod, memory locally). */
const entitlements = createEntitlementStore();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

// Stripe webhook MUST see the raw body for signature verification, so it is
// registered before the global JSON parser with its own raw-body parser.
app.post(
  '/v1/billing/webhook',
  express.raw({ type: 'application/json', limit: '64kb' }),
  (req: Request, res: Response) => {
    void handleBillingWebhook(req, res);
  },
);

app.use(express.json({ limit: '64kb' }));

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === 'object' && 'type' in err) {
    const type = (err as { type?: string }).type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: invalid JSON' }, id: null });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null });
      return;
    }
  }
  next(err);
});

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Mcp-Protocol-Version, MCP-Protocol-Version, Authorization, X-Muse-Subject',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Muse calls from a small set of Meta egress addresses, so this is generous:
// it only exists to stop a runaway client.
function makeRateLimit(): RequestHandler {
  const windowMs = 60_000;
  const max = cfg.rateLimitPerMin;
  const hits = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (now > entry.resetAt) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000).toString());
      res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down.' });
      return;
    }
    next();
  };
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    // No bodies, no query args, no headers in the log: tool args can carry
    // league ids and (in the worst case) mishandled credential material.
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// The MCP spec wants Accept to list both application/json and text/event-stream,
// and the SDK enforces that. Muse's egress proxy has been seen sending only
// `Accept: application/json` and hanging on SSE. We always answer with a single
// JSON body (enableJsonResponse), so normalize rather than reject a real caller.
function normalizeAcceptHeader(req: Request) {
  const raw = req.headers.accept;
  const current = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  const hasJson = current.includes('application/json');
  const hasSse = current.includes('text/event-stream');
  if (!hasJson || !hasSse) {
    const parts = [current, !hasJson ? 'application/json' : '', !hasSse ? 'text/event-stream' : ''].filter(Boolean);
    req.headers.accept = parts.join(', ');
  }
}

const INSTRUCTIONS =
  'Fantasy football manager for Sleeper, ESPN, and Yahoo leagues. ' +
  'Free tools read public leagues with no auth: connect_league validates a league, list_my_teams / get_roster / get_matchup / get_standings / list_transactions read it. ' +
  'Private ESPN leagues need swid+espn_s2 cookies and Yahoo leagues need an OAuth token — both must come from Muse\'s Secure Credentials Store, never typed raw, never stored here. ' +
  'Premium tools (analyze_trade, waiver_targets, start_sit_advice) need the Pro tier and weekly_recap needs the Commissioner tier; without one they return a 402 payment_required error with a subscribe URL — the connector never charges anyone itself. ' +
  'Advice tools are heuristic, not projection-model grade, and every tool is read-only: nothing here can set lineups, propose trades, or change a league.';

app.post('/mcp', makeRateLimit(), async (req: Request, res: Response) => {
  try {
    normalizeAcceptHeader(req);
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
    // Stash per-request headers so tool handlers can resolve the caller's
    // subscription tier without any session state.
    (server as unknown as { __reqHeaders: unknown }).__reqHeaders = req.headers;
    registerFantasyTools(server, { getConfig: () => cfg, entitlements });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session management
      enableJsonResponse: true, // single JSON body, no SSE (required by Muse's egress proxy)
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[/mcp] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// GET/DELETE are not supported in stateless mode; a clean 405 (rather than a
// hang or reset) tells callers and reviewers the host is up on purpose.
for (const method of ['get', 'delete'] as const) {
  app[method]('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. POST JSON-RPC requests to this endpoint.' },
      id: null,
    });
  });
}

// ---- Yahoo OAuth PKCE (private Yahoo leagues; Pro tier includes them) ----
app.get('/v1/yahoo/authorize', (_req: Request, res: Response) => {
  try {
    // The caller keeps the verifier; Muse holds it in the user's session and
    // returns it to /v1/yahoo/callback. The connector never stores it.
    const verifier = newCodeVerifier();
    const url = yahooAuthorizeUrl(cfg.yahoo, verifier);
    res.json({ authorization_url: url, code_verifier: verifier, note: 'Keep the code_verifier; POST it to /v1/yahoo/callback with the code Yahoo returns.' });
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'not_configured') {
      res.status(501).json({ error: 'not_configured', message: err.message });
      return;
    }
    throw err;
  }
});

app.post('/v1/yahoo/callback', async (req: Request, res: Response) => {
  const { code, code_verifier: verifier } = req.body ?? {};
  if (typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
    res.status(400).json({ error: 'bad_request', message: 'Body must be { code, code_verifier }.' });
    return;
  }
  try {
    const tokens = await yahooExchangeCode(cfg.yahoo, code, verifier);
    // Tokens go back to the caller (Muse), which stores them in the user's
    // Secure Credentials Store. The connector retains nothing.
    res.json({
      token_type: 'Bearer',
      expires_in: tokens.expires_in ?? null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      note: 'Store these in the Secure Credentials Store. The connector does not retain them.',
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      res.status(err.code === 'not_configured' ? 501 : 502).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }
});

// ---- Stripe billing webhook ----
// Verifies the Stripe signature, then syncs subject -> tier entitlements:
//   checkout.session.completed -> grant tier (mapped via client_reference_id,
//     which the 402 payment_url appends to the Stripe payment link)
//   customer.subscription.deleted -> revoke tier
//   customer.subscription.updated  -> audit-logged; grants are idempotent
// Test-mode events are logged but never grant entitlements.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function handleCheckoutCompleted(event: unknown): Promise<void> {
  const info = parseCheckoutCompleted(event, cfg);
  if (!info) return;
  const now = new Date().toISOString();
  if (!info.livemode) {
    await entitlements.recordEvent({
      id: info.eventId,
      type: 'checkout.session.completed',
      subject: info.subject,
      tier: info.tier,
      email: info.email,
      subscriptionId: info.subscriptionId,
      livemode: false,
      createdAt: now,
      note: 'test-mode event; no entitlement granted',
    });
    return;
  }
  if (info.subject && (info.tier === 'pro' || info.tier === 'commissioner')) {
    await entitlements.setEntitlement(info.subject, {
      tier: info.tier,
      subscriptionId: info.subscriptionId,
      customerId: info.customerId,
      updatedAt: now,
    });
  }
  await entitlements.recordEvent({
    id: info.eventId,
    type: 'checkout.session.completed',
    subject: info.subject,
    tier: info.tier,
    email: info.email,
    subscriptionId: info.subscriptionId,
    livemode: true,
    createdAt: now,
    ...(info.subject ? {} : { note: 'no client_reference_id; needs manual subject mapping' }),
  });
  console.log(
    `[billing] checkout completed: subject=${info.subject ?? 'UNMAPPED'} tier=${info.tier ?? 'unknown'} sub=${info.subscriptionId ?? 'none'}`,
  );
}

async function handleSubscriptionEnded(event: unknown): Promise<void> {
  const info = parseSubscriptionEvent(event);
  if (!info || !info.livemode) return;
  const now = new Date().toISOString();
  const subject = await entitlements.subjectForSubscription(info.subscriptionId);
  if (subject) await entitlements.removeEntitlement(subject);
  await entitlements.recordEvent({
    id: info.eventId,
    type: info.type,
    subject,
    tier: null,
    email: null,
    subscriptionId: info.subscriptionId,
    livemode: true,
    createdAt: now,
  });
  console.log(`[billing] subscription ended: subject=${subject ?? 'unknown'} sub=${info.subscriptionId}`);
}

async function handleBillingWebhook(req: Request, res: Response): Promise<void> {
  const secret = cfg.stripeWebhookSecret;
  if (!secret) {
    res.status(501).json({
      error: 'not_configured',
      message:
        'STRIPE_WEBHOOK_SECRET is not set. Tiers resolve from PREMIUM_SUBJECTS / COMMISSIONER_SUBJECTS env config. See PRICING.md.',
    });
    return;
  }
  const raw = req.body as unknown;
  if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) {
    res.status(400).json({ error: 'invalid_signature', message: 'Stripe signature verification failed.' });
    return;
  }
  let event: unknown;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid_json', message: 'Webhook body is not valid JSON.' });
    return;
  }
  const type = (event as { type?: unknown }).type;
  const eventId = (event as { id?: unknown }).id;
  if (typeof type !== 'string' || typeof eventId !== 'string') {
    res.status(400).json({ error: 'invalid_event', message: 'Not a Stripe event object.' });
    return;
  }
  try {
    if (await entitlements.seenEvent(eventId)) {
      res.json({ received: true, deduped: true });
      return;
    }
    if (type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event);
    } else if (type === 'customer.subscription.deleted') {
      await handleSubscriptionEnded(event);
    } else if (type === 'customer.subscription.updated') {
      const info = parseSubscriptionEvent(event);
      if (info?.livemode) {
        await entitlements.recordEvent({
          id: info.eventId,
          type: info.type,
          subject: await entitlements.subjectForSubscription(info.subscriptionId),
          tier: null,
          email: null,
          subscriptionId: info.subscriptionId,
          livemode: true,
          createdAt: new Date().toISOString(),
          note: `status=${info.status}`,
        });
      }
    } else if (type === 'invoice.payment_failed' || type === 'customer.subscription.created') {
      // Robustness events: never change tiers on their own. Failed payments
      // are retried by Stripe (revocation comes from subscription.deleted);
      // created is a backstop record (the grant comes from
      // checkout.session.completed). Both land in the audit log.
      const obj = (event as { data?: { object?: Record<string, unknown> } }).data?.object;
      const subId =
        obj && typeof obj.subscription === 'string'
          ? obj.subscription
          : obj && typeof obj.id === 'string'
            ? obj.id
            : null;
      if ((event as { livemode?: unknown }).livemode === true) {
        await entitlements.recordEvent({
          id: eventId,
          type,
          subject: subId ? await entitlements.subjectForSubscription(subId) : null,
          tier: null,
          email: null,
          subscriptionId: subId,
          livemode: true,
          createdAt: new Date().toISOString(),
          note:
            type === 'invoice.payment_failed'
              ? 'payment failed; Stripe retries automatically'
              : 'subscription created; entitlement granted via checkout.session.completed',
        });
      }
    }
    // Unknown event types are acknowledged and ignored.
    await entitlements.markEventSeen(eventId);
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook handler error:', err);
    res.status(500).json({ error: 'handler_error', message: 'Webhook processing failed; Stripe will retry.' });
  }
}

// Admin: recent billing events for the payment watcher. Never expose emails
// or subjects without the admin secret.
app.get('/v1/billing/events', (req: Request, res: Response) => {
  const secret = cfg.billingAdminSecret;
  const auth = req.headers.authorization;
  const token =
    typeof auth === 'string' && /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
  if (!secret) {
    res.status(501).json({ error: 'not_configured', message: 'BILLING_ADMIN_SECRET is not set.' });
    return;
  }
  if (!token || !safeEqual(token, secret)) {
    res.status(401).json({ error: 'unauthorized', message: 'Valid admin bearer token required.' });
    return;
  }
  const since = typeof req.query.since === 'string' ? req.query.since : '1970-01-01T00:00:00.000Z';
  entitlements
    .recentEvents(since, 100)
    .then((events) => res.json({ events }))
    .catch((err) => {
      console.error('[billing] events endpoint error:', err);
      res.status(500).json({ error: 'store_error', message: 'Could not read billing events.' });
    });
});

// Public: webhook/store configuration status (no secrets, no PII).
app.get('/v1/billing/status', (_req: Request, res: Response) => {
  res.json({
    webhook_configured: Boolean(cfg.stripeWebhookSecret),
    store: process.env.KV_REST_API_URL ? 'kv' : 'memory',
    version: SERVER_VERSION,
  });
});

// OpenAI plugin domain-verification challenge: serves the exact token from
// the Plugins dashboard as plain text. Set OPENAI_APPS_CHALLENGE in env
// after starting the OpenAI submission; unset -> 404 (route inert).
app.get('/.well-known/openai-apps-challenge', (_req: Request, res: Response) => {
  const token = process.env.OPENAI_APPS_CHALLENGE;
  if (!token) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(token);
});

// ---- static docs ----
const staticDir = path.join(dirName, 'static');
const serve = (file: string, type: string) => async (_req: Request, res: Response) => {
  try {
    const text = await readFile(path.join(staticDir, file));
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(text);
  } catch (err) {
    console.error(`[static] failed to read ${file}:`, err);
    res.status(500).send('Internal server error');
  }
};
app.get('/muse.md', serve('muse.md', 'text/markdown; charset=utf-8'));
app.get('/llms.txt', serve('llms.txt', 'text/plain; charset=utf-8'));
app.get('/terms', serve('terms.html', 'text/html; charset=utf-8'));
app.get('/privacy', serve('privacy.html', 'text/html; charset=utf-8'));
app.get('/pricing', serve('pricing.html', 'text/html; charset=utf-8'));
app.get('/icon.png', serve('icon.png', 'image/png'));
app.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(
    `<!doctype html><html><head><meta charset="utf-8"><title>${cfg.serviceName} — Muse connector</title></head>` +
      `<body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px">` +
      `<h1>${cfg.serviceName}</h1>` +
      `<p>Manage fantasy football teams (Sleeper, ESPN, Yahoo) from Meta Muse. Public HTTPS MCP server, POST-only, no auth needed for public leagues.</p>` +
      `<ul><li>MCP endpoint: <code>POST /mcp</code></li>` +
      `<li><a href="/muse.md">Connector brief (muse.md)</a></li>` +
      `<li><a href="/llms.txt">Tool contract (llms.txt)</a></li>` +
      `<li><a href="/terms">Terms of Service</a></li>` +
      `<li><a href="/privacy">Privacy Policy</a></li>` +
      `<li><a href="/healthz">Health</a></li></ul>` +
      `<p>Source: <a href="https://github.com/mitchellOpZero/muse-fantasy-connector">mitchellOpZero/muse-fantasy-connector</a> (Apache-2.0)</p>` +
      `</body></html>`,
  );
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true, service: SERVER_NAME, version: SERVER_VERSION });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[unhandled]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'internal_server_error' });
  }
});

export { app };

// Default export: Vercel resolves this module itself as the function entry
// for the / route (its launcher validates the entry module's default
// export). Delegating to the Express app keeps every entry shape valid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function handler(req: any, res: any): void {
  app(req, res);
}

async function main() {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`${SERVER_NAME} ${SERVER_VERSION} listening on 127.0.0.1:${PORT}`);
  });
}

if (!process.env.VITEST && !process.env.VERCEL) {
  // Local dev / self-host only. On Vercel the platform invokes the exported
  // handler per request; binding a port here would crash concurrent
  // invocations (EADDRINUSE -> process.exit(1) -> 500s).
  main().catch((err) => {
    console.error('fatal startup error:', err);
    process.exit(1);
  });
}
