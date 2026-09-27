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
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { registerFantasyTools } from './fantasy.js';
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

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
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
    registerFantasyTools(server, { getConfig: () => cfg });
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

// ---- Stripe webhook scaffold ----
// Production billing syncs here: verify the webhook signature with
// STRIPE_WEBHOOK_SECRET, then upsert the subject->tier mapping in durable
// storage. Until wired, this is a documented stub.
app.post('/v1/billing/webhook', (req: Request, res: Response) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    res.status(501).json({
      error: 'not_configured',
      message:
        'Billing webhook is not wired yet. Tiers are currently resolved from PREMIUM_SUBJECTS / COMMISSIONER_SUBJECTS env config. See PRICING.md.',
    });
    return;
  }
  // TODO: verify stripe signature, upsert subscription -> subject tier.
  console.log('[billing] webhook received; handler not implemented');
  res.status(501).json({ error: 'not_implemented', message: 'Webhook handler scaffold only.' });
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

async function main() {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`${SERVER_NAME} ${SERVER_VERSION} listening on 127.0.0.1:${PORT}`);
  });
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error('fatal startup error:', err);
    process.exit(1);
  });
}
