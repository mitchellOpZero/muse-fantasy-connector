/**
 * Subscription tiers and the x402-style 402 gate.
 *
 * FREE  — 1 league: roster / matchup / standings / transactions views.
 * PRO   — unlimited leagues + premium tools (analyze_trade, waiver_targets,
 *         start_sit_advice) + private leagues.
 * COMMISSIONER — everything in Pro + weekly_recap / power rankings /
 *         trade review / draft kit ("runs your league for you").
 *
 * This module is a scaffold backed by env config (PREMIUM_SUBJECTS /
 * COMMISSIONER_SUBJECTS). Production should sync subjects from Stripe
 * webhooks into durable storage; see connectors/muse/security.md.
 * The 402 payload shape is generic so Stripe Payment Links or x402 can back
 * it without changing the contract.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectorConfig } from './config.js';
import type { EntitlementStore } from './entitlements.js';

export type Tier = 'free' | 'pro' | 'commissioner';

/** Minimum tier required per tool. Keys must match the registered MCP tool names. */
export const TOOL_TIERS: Record<string, Tier> = {
  connect_league: 'free',
  list_my_teams: 'free',
  get_roster: 'free',
  get_matchup: 'free',
  get_standings: 'free',
  list_transactions: 'free',
  analyze_trade: 'pro',
  waiver_targets: 'pro',
  start_sit_advice: 'pro',
  weekly_recap: 'commissioner',
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, commissioner: 2 };

export interface PaymentRequired {
  /** Mirrors the HTTP status a REST version of this gate would return. */
  http_status: 402;
  code: 'payment_required';
  tool: string;
  required_tier: Tier;
  current_tier: Tier;
  message: string;
  /** Generic payment/subscription URL — backed by Stripe Payment Links or x402. */
  payment_url: string;
  pricing_url: string;
}

/**
 * Resolve the caller's subject (stable user id) from request headers.
 * Muse sends either `Authorization: Bearer <subject>` or `x-muse-subject`.
 * Returns null for anonymous callers (Free tier).
 */
export function subjectFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers['authorization'];
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  if (bearer) {
    const m = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (m) return m[1].trim().toLowerCase();
  }
  const sub = headers['x-muse-subject'];
  const s = Array.isArray(sub) ? sub[0] : sub;
  return s ? s.trim().toLowerCase() : null;
}

export function tierForSubject(cfg: ConnectorConfig, subject: string | null): Tier {
  if (!subject) return 'free';
  if (cfg.commissionerSubjects.has(subject)) return 'commissioner';
  if (cfg.premiumSubjects.has(subject)) return 'pro';
  return 'free';
}

/**
 * Resolve the caller's tier: webhook-synced entitlements first (covers
 * paying customers), then the static env lists, then Free.
 */
export async function resolveTier(
  cfg: ConnectorConfig,
  store: EntitlementStore,
  subject: string | null,
): Promise<Tier> {
  if (!subject) return 'free';
  try {
    const stored = await store.getTier(subject);
    if (stored === 'commissioner' || stored === 'pro') return stored;
  } catch {
    // The entitlement backend must never break the gate; fall through to env.
  }
  return tierForSubject(cfg, subject);
}

export type GateResult = { ok: true; tier: Tier; subject: string | null } | { ok: false; payment: PaymentRequired };

/**
 * Check whether `subject` may call `tool`. On failure returns the 402-style
 * payload the MCP tool handler surfaces as an error result.
 */
export async function requireTier(
  cfg: ConnectorConfig,
  store: EntitlementStore,
  subject: string | null,
  tool: string,
): Promise<GateResult> {
  return requireTierFor(cfg, store, subject, TOOL_TIERS[tool] ?? 'free', tool);
}

/**
 * Same as requireTier but with an explicit required tier (for conditional
 * gates such as private-league access, where the tier depends on the call,
 * not the tool name).
 */
export async function requireTierFor(
  cfg: ConnectorConfig,
  store: EntitlementStore,
  subject: string | null,
  required: Tier,
  tool: string,
): Promise<GateResult> {
  const current = await resolveTier(cfg, store, subject);
  if (TIER_RANK[current] >= TIER_RANK[required]) {
    return { ok: true, tier: current, subject };
  }
  const label = required === 'commissioner' ? 'Commissioner' : 'Pro';
  const baseUrl = required === 'commissioner' ? cfg.commissionerPaymentUrl : cfg.proPaymentUrl;
  return {
    ok: false,
    payment: {
      http_status: 402,
      code: 'payment_required',
      tool,
      required_tier: required,
      current_tier: current,
      message:
        `"${tool}" requires the ${label} tier (you are on ` +
        `${current === 'free' ? 'Free' : current}). Subscribe to unlock it — ` +
        `the connector cannot and will not charge you itself.`,
      payment_url: withClientRef(baseUrl, subject),
      pricing_url: cfg.pricingUrl,
    },
  };
}

/** Build the human-readable text for a 402 tool error. */
export function paymentRequiredText(p: PaymentRequired): string {
  return (
    `402 Payment Required — "${p.tool}" needs the ${p.required_tier} tier.\n` +
    `${p.message}\nSubscribe: ${p.payment_url}\nPricing: ${p.pricing_url}`
  );
}

// ---------------------------------------------------------------------------
// Stripe webhook support
// ---------------------------------------------------------------------------

/**
 * Stripe silently drops a client_reference_id containing anything outside
 * [A-Za-z0-9_-], so sanitize the subject before it rides on the payment
 * link. Returns '' when nothing usable survives (caller then omits the
 * parameter instead of sending a value Stripe would discard).
 */
export function sanitizeClientRef(subject: string | null): string {
  if (!subject) return '';
  return subject.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
}

/**
 * Append the subject as Stripe's client_reference_id so the
 * checkout.session.completed webhook can map the payment back to the Muse
 * user who hit the 402. Anonymous callers get the bare link.
 */
export function withClientRef(baseUrl: string, subject: string | null): string {
  const ref = sanitizeClientRef(subject);
  if (!ref) return baseUrl;
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}client_reference_id=${encodeURIComponent(ref)}`;
}

interface StripeSigParts {
  timestamp: number;
  signatures: string[];
}

/** Parse a `t=...,v1=...` Stripe-Signature header. Null when malformed. */
function parseStripeSignature(header: string): StripeSigParts | null {
  let timestamp = NaN;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify a Stripe webhook signature against the RAW request body.
 * Rejects malformed headers, stale timestamps (replay protection), and
 * signature mismatches. Uses constant-time comparison.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret) return false;
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header) return false;
  const parts = parseStripeSignature(header);
  if (!parts) return false;
  if (Math.abs(nowSec - parts.timestamp) > toleranceSec) return false;
  const expected = createHmac('sha256', secret)
    .update(`${parts.timestamp}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return parts.signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, 'utf8');
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
  });
}

/**
 * Map a checkout amount to a tier. Each tier has its own payment link at a
 * fixed price, so amount+currency identifies the tier without a Stripe API
 * call. Amounts are env-configurable (cents) for test mode or price changes.
 */
export function tierFromAmount(
  amountCents: number | null | undefined,
  currency: string | null | undefined,
  cfg: ConnectorConfig,
): Tier | null {
  if (typeof amountCents !== 'number' || (currency ?? '').toLowerCase() !== 'usd') return null;
  if (amountCents === cfg.stripeProAmountCents) return 'pro';
  if (amountCents === cfg.stripeCommissionerAmountCents) return 'commissioner';
  return null;
}

export interface CheckoutCompletedInfo {
  eventId: string;
  livemode: boolean;
  /** Sanitized Muse subject from client_reference_id; null when unmappable. */
  subject: string | null;
  tier: Tier | null;
  subscriptionId: string | null;
  customerId: string | null;
  email: string | null;
  amountCents: number | null;
}

/** Normalize a checkout.session.completed event. Null when not parseable. */
export function parseCheckoutCompleted(event: unknown, cfg: ConnectorConfig): CheckoutCompletedInfo | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { id?: unknown; livemode?: unknown; data?: { object?: Record<string, unknown> } };
  const obj = e.data?.object;
  if (typeof e.id !== 'string' || !obj) return null;
  const rawRef = typeof obj.client_reference_id === 'string' ? obj.client_reference_id : null;
  const subject = sanitizeClientRef(rawRef) || null;
  const details = obj.customer_details as { email?: unknown } | undefined;
  const email =
    (details && typeof details.email === 'string' && details.email) ||
    (typeof obj.customer_email === 'string' ? obj.customer_email : null);
  return {
    eventId: e.id,
    livemode: e.livemode === true,
    subject,
    tier: tierFromAmount(
      typeof obj.amount_total === 'number' ? obj.amount_total : null,
      typeof obj.currency === 'string' ? obj.currency : null,
      cfg,
    ),
    subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : null,
    customerId: typeof obj.customer === 'string' ? obj.customer : null,
    email: typeof email === 'string' ? email : null,
    amountCents: typeof obj.amount_total === 'number' ? obj.amount_total : null,
  };
}

export interface SubscriptionEventInfo {
  eventId: string;
  type: string;
  subscriptionId: string;
  status: string;
  livemode: boolean;
}

/** Normalize customer.subscription.* events. Null when not parseable. */
export function parseSubscriptionEvent(event: unknown): SubscriptionEventInfo | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: Record<string, unknown> } };
  const obj = e.data?.object;
  if (typeof e.id !== 'string' || typeof e.type !== 'string' || !obj) return null;
  if (typeof obj.id !== 'string') return null;
  return {
    eventId: e.id,
    type: e.type,
    subscriptionId: obj.id,
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    livemode: e.livemode === true,
  };
}
