import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  paymentRequiredText,
  requireTier,
  subjectFromHeaders,
  tierForSubject,
  TOOL_TIERS,
} from '../src/billing.js';

const cfg = loadConfig({
  ...process.env,
  PAYMENT_URL: 'https://pay.example.com/sub',
  PRICING_URL: 'https://example.com/pricing',
  PREMIUM_SUBJECTS: 'coach@example.com',
  COMMISSIONER_SUBJECTS: 'commish@example.com',
} as NodeJS.ProcessEnv);

describe('subjectFromHeaders', () => {
  it('reads Bearer tokens', () => {
    expect(subjectFromHeaders({ authorization: 'Bearer Coach@Example.com' })).toBe('coach@example.com');
  });
  it('reads x-muse-subject', () => {
    expect(subjectFromHeaders({ 'x-muse-subject': 'Commish@Example.com' })).toBe('commish@example.com');
  });
  it('returns null when anonymous', () => {
    expect(subjectFromHeaders({})).toBeNull();
  });
});

describe('tierForSubject', () => {
  it('anonymous is free', () => expect(tierForSubject(cfg, null)).toBe('free'));
  it('unknown subject is free', () => expect(tierForSubject(cfg, 'nobody@example.com')).toBe('free'));
  it('premium list is pro', () => expect(tierForSubject(cfg, 'coach@example.com')).toBe('pro'));
  it('commissioner list outranks premium', () => expect(tierForSubject(cfg, 'commish@example.com')).toBe('commissioner'));
});

describe('requireTier', () => {
  it('free tools pass for anonymous', () => {
    for (const tool of ['connect_league', 'list_my_teams', 'get_roster', 'get_matchup', 'get_standings', 'list_transactions']) {
      expect(TOOL_TIERS[tool]).toBe('free');
      expect(requireTier(cfg, null, tool).ok).toBe(true);
    }
  });
  it('premium tools 402 for anonymous', () => {
    for (const [tool, tier] of [['analyze_trade', 'pro'], ['waiver_targets', 'pro'], ['start_sit_advice', 'pro'], ['weekly_recap', 'commissioner']] as const) {
      expect(TOOL_TIERS[tool]).toBe(tier);
      const gate = requireTier(cfg, null, tool);
      expect(gate.ok).toBe(false);
      if (!gate.ok) {
        expect(gate.payment.http_status).toBe(402);
        expect(gate.payment.code).toBe('payment_required');
        expect(gate.payment.tool).toBe(tool);
        expect(gate.payment.required_tier).toBe(tier);
        expect(gate.payment.payment_url).toBe('https://pay.example.com/sub');
        expect(gate.payment.pricing_url).toBe('https://example.com/pricing');
        expect(paymentRequiredText(gate.payment)).toContain('402 Payment Required');
        expect(paymentRequiredText(gate.payment)).toContain('https://pay.example.com/sub');
      }
    }
  });
  it('pro subject passes pro tools but not commissioner tools', () => {
    expect(requireTier(cfg, 'coach@example.com', 'analyze_trade').ok).toBe(true);
    const gate = requireTier(cfg, 'coach@example.com', 'weekly_recap');
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.payment.required_tier).toBe('commissioner');
  });
  it('commissioner subject passes everything', () => {
    for (const tool of Object.keys(TOOL_TIERS)) {
      expect(requireTier(cfg, 'commish@example.com', tool).ok).toBe(true);
    }
  });
  it('unknown tools default to free', () => {
    expect(requireTier(cfg, null, 'nonexistent_tool').ok).toBe(true);
  });
});
