import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  parseCheckoutCompleted,
  parseSubscriptionEvent,
  paymentRequiredText,
  requireTier,
  resolveTier,
  sanitizeClientRef,
  subjectFromHeaders,
  tierForSubject,
  tierFromAmount,
  verifyStripeSignature,
  withClientRef,
  TOOL_TIERS,
} from '../src/billing.js';
import { MemoryEntitlementStore } from '../src/entitlements.js';

const cfg = loadConfig({
  ...process.env,
  PAYMENT_URL: 'https://pay.example.com/sub',
  PRICING_URL: 'https://example.com/pricing',
  PREMIUM_SUBJECTS: 'coach@example.com',
  COMMISSIONER_SUBJECTS: 'commish@example.com',
} as NodeJS.ProcessEnv);

const store = () => new MemoryEntitlementStore();

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

describe('resolveTier', () => {
  it('prefers the webhook-synced entitlement over env lists', async () => {
    const s = store();
    await s.setEntitlement('nobody@example.com', { tier: 'pro', subscriptionId: 'sub_1', customerId: null, updatedAt: new Date().toISOString() });
    expect(await resolveTier(cfg, s, 'nobody@example.com')).toBe('pro');
  });
  it('falls back to env lists', async () => {
    expect(await resolveTier(cfg, store(), 'coach@example.com')).toBe('pro');
  });
  it('survives a broken store', async () => {
    const broken = { getTier: async () => { throw new Error('kv down'); } } as unknown as MemoryEntitlementStore;
    expect(await resolveTier(cfg, broken, 'coach@example.com')).toBe('pro');
  });
});

describe('requireTier', () => {
  it('free tools pass for anonymous', async () => {
    for (const tool of ['connect_league', 'list_my_teams', 'get_roster', 'get_matchup', 'get_standings', 'list_transactions']) {
      expect(TOOL_TIERS[tool]).toBe('free');
      expect((await requireTier(cfg, store(), null, tool)).ok).toBe(true);
    }
  });
  it('premium tools 402 for anonymous', async () => {
    for (const [tool, tier] of [['analyze_trade', 'pro'], ['waiver_targets', 'pro'], ['start_sit_advice', 'pro'], ['weekly_recap', 'commissioner']] as const) {
      expect(TOOL_TIERS[tool]).toBe(tier);
      const gate = await requireTier(cfg, store(), null, tool);
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
  it('pro subject passes pro tools but not commissioner tools', async () => {
    expect((await requireTier(cfg, store(), 'coach@example.com', 'analyze_trade')).ok).toBe(true);
    const gate = await requireTier(cfg, store(), 'coach@example.com', 'weekly_recap');
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.payment.required_tier).toBe('commissioner');
  });
  it('commissioner subject passes everything', async () => {
    for (const tool of Object.keys(TOOL_TIERS)) {
      expect((await requireTier(cfg, store(), 'commish@example.com', tool)).ok).toBe(true);
    }
  });
  it('unknown tools default to free', async () => {
    expect((await requireTier(cfg, store(), null, 'nonexistent_tool')).ok).toBe(true);
  });
  it('webhook-granted pro passes pro tools', async () => {
    const s = store();
    await s.setEntitlement('newfan', { tier: 'pro', subscriptionId: 'sub_9', customerId: null, updatedAt: new Date().toISOString() });
    expect((await requireTier(cfg, s, 'newfan', 'analyze_trade')).ok).toBe(true);
    expect((await requireTier(cfg, s, 'newfan', 'weekly_recap')).ok).toBe(false);
  });
});

describe('client_reference_id on payment URLs', () => {
  it('sanitizeClientRef strips characters Stripe would drop', () => {
    expect(sanitizeClientRef('Coach@Example.com')).toBe('CoachExamplecom');
    expect(sanitizeClientRef('user_123-ABC')).toBe('user_123-ABC');
    expect(sanitizeClientRef('!!!')).toBe('');
    expect(sanitizeClientRef(null)).toBe('');
  });
  it('withClientRef appends the param for known subjects', () => {
    expect(withClientRef('https://pay.example.com/sub', 'coach@example.com')).toBe(
      'https://pay.example.com/sub?client_reference_id=coachexamplecom',
    );
  });
  it('withClientRef uses & when the URL already has a query', () => {
    expect(withClientRef('https://pay.example.com/sub?x=1', 'abc')).toBe(
      'https://pay.example.com/sub?x=1&client_reference_id=abc',
    );
  });
  it('withClientRef leaves the bare link for anonymous or unsanitizable subjects', () => {
    expect(withClientRef('https://pay.example.com/sub', null)).toBe('https://pay.example.com/sub');
    expect(withClientRef('https://pay.example.com/sub', '!!!')).toBe('https://pay.example.com/sub');
  });
  it('402 payment_url carries client_reference_id for identified subjects', async () => {
    const gate = await requireTier(cfg, store(), 'someuser', 'analyze_trade');
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.payment.payment_url).toBe('https://pay.example.com/sub?client_reference_id=someuser');
    }
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from('{"id":"evt_123"}', 'utf8');
  const sign = (payload: Buffer, t: number, key: string) => {
    const v1 = createHmac('sha256', key).update(`${t}.${payload.toString('utf8')}`, 'utf8').digest('hex');
    return `t=${t},v1=${v1}`;
  };

  it('accepts a valid signature', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, sign(body, t, secret), secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    const t = Math.floor(Date.now() / 1000);
    const tampered = Buffer.from('{"id":"evt_999"}', 'utf8');
    expect(verifyStripeSignature(tampered, sign(body, t, secret), secret)).toBe(false);
  });
  it('rejects the wrong secret', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, sign(body, t, 'whsec_wrong'), secret)).toBe(false);
  });
  it('rejects stale timestamps (replay protection)', () => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(body, sign(body, t, secret), secret)).toBe(false);
  });
  it('rejects malformed or missing headers', () => {
    expect(verifyStripeSignature(body, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', secret)).toBe(false);
    expect(verifyStripeSignature(body, 't=abc,v1=deadbeef', secret)).toBe(false);
  });
});

describe('tierFromAmount', () => {
  it('maps the configured amounts', () => {
    expect(tierFromAmount(800, 'usd', cfg)).toBe('pro');
    expect(tierFromAmount(2500, 'usd', cfg)).toBe('commissioner');
  });
  it('rejects other amounts and currencies', () => {
    expect(tierFromAmount(999, 'usd', cfg)).toBeNull();
    expect(tierFromAmount(800, 'eur', cfg)).toBeNull();
    expect(tierFromAmount(null, 'usd', cfg)).toBeNull();
  });
});

describe('parseCheckoutCompleted', () => {
  const base = {
    id: 'evt_1',
    livemode: true,
    data: {
      object: {
        client_reference_id: 'someuser',
        amount_total: 800,
        currency: 'usd',
        subscription: 'sub_123',
        customer: 'cus_123',
        customer_details: { email: 'fan@example.com' },
      },
    },
  };
  it('extracts subject, tier, and ids', () => {
    const info = parseCheckoutCompleted(base, cfg);
    expect(info).toMatchObject({
      eventId: 'evt_1',
      livemode: true,
      subject: 'someuser',
      tier: 'pro',
      subscriptionId: 'sub_123',
      customerId: 'cus_123',
      email: 'fan@example.com',
      amountCents: 800,
    });
  });
  it('returns null subject when client_reference_id is missing', () => {
    const evt = { ...base, data: { object: { ...base.data.object, client_reference_id: null } } };
    const info = parseCheckoutCompleted(evt, cfg);
    expect(info?.subject).toBeNull();
    expect(info?.tier).toBe('pro');
  });
  it('returns null for garbage', () => {
    expect(parseCheckoutCompleted(null, cfg)).toBeNull();
    expect(parseCheckoutCompleted({ id: 1 }, cfg)).toBeNull();
  });
});

describe('parseSubscriptionEvent', () => {
  it('extracts subscription id and status', () => {
    const info = parseSubscriptionEvent({
      id: 'evt_2',
      type: 'customer.subscription.deleted',
      livemode: true,
      data: { object: { id: 'sub_123', status: 'canceled' } },
    });
    expect(info).toMatchObject({ eventId: 'evt_2', subscriptionId: 'sub_123', status: 'canceled', livemode: true });
  });
});
