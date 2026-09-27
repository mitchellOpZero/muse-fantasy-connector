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
import type { ConnectorConfig } from './config.js';

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

export type GateResult = { ok: true; tier: Tier; subject: string | null } | { ok: false; payment: PaymentRequired };

/**
 * Check whether `subject` may call `tool`. On failure returns the 402-style
 * payload the MCP tool handler surfaces as an error result.
 */
export function requireTier(cfg: ConnectorConfig, subject: string | null, tool: string): GateResult {
  return requireTierFor(cfg, subject, TOOL_TIERS[tool] ?? 'free', tool);
}

/**
 * Same as requireTier but with an explicit required tier (for conditional
 * gates such as private-league access, where the tier depends on the call,
 * not the tool name).
 */
export function requireTierFor(
  cfg: ConnectorConfig,
  subject: string | null,
  required: Tier,
  tool: string,
): GateResult {
  const current = tierForSubject(cfg, subject);
  if (TIER_RANK[current] >= TIER_RANK[required]) {
    return { ok: true, tier: current, subject };
  }
  const label = required === 'commissioner' ? 'Commissioner' : 'Pro';
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
      payment_url: cfg.paymentUrl,
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
