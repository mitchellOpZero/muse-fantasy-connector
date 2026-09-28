import { describe, expect, it } from 'vitest';
import { MemoryEntitlementStore, type BillingEventRecord } from '../src/entitlements.js';

const rec = (tier: 'pro' | 'commissioner', subscriptionId: string | null = 'sub_1') => ({
  tier,
  subscriptionId,
  customerId: 'cus_1',
  updatedAt: new Date().toISOString(),
});

const evt = (id: string, subject: string | null = 'u1'): BillingEventRecord => ({
  id,
  type: 'checkout.session.completed',
  subject,
  tier: 'pro',
  email: 'u1@example.com',
  subscriptionId: 'sub_1',
  livemode: true,
  createdAt: new Date().toISOString(),
});

describe('MemoryEntitlementStore', () => {
  it('round-trips entitlements and the subscription index', async () => {
    const s = new MemoryEntitlementStore();
    expect(await s.getTier('u1')).toBeNull();
    await s.setEntitlement('u1', rec('pro'));
    expect(await s.getTier('u1')).toBe('pro');
    expect(await s.subjectForSubscription('sub_1')).toBe('u1');
    await s.removeEntitlement('u1');
    expect(await s.getTier('u1')).toBeNull();
    expect(await s.subjectForSubscription('sub_1')).toBeNull();
  });
  it('replaces the subscription index when the subscription changes', async () => {
    const s = new MemoryEntitlementStore();
    await s.setEntitlement('u1', rec('pro', 'sub_old'));
    await s.setEntitlement('u1', rec('commissioner', 'sub_new'));
    expect(await s.getTier('u1')).toBe('commissioner');
    expect(await s.subjectForSubscription('sub_old')).toBeNull();
    expect(await s.subjectForSubscription('sub_new')).toBe('u1');
  });
  it('dedups webhook events', async () => {
    const s = new MemoryEntitlementStore();
    expect(await s.seenEvent('evt_1')).toBe(false);
    await s.markEventSeen('evt_1');
    expect(await s.seenEvent('evt_1')).toBe(true);
  });
  it('records events and filters by since', async () => {
    const s = new MemoryEntitlementStore();
    await s.recordEvent(evt('evt_1'));
    await s.recordEvent({ ...evt('evt_2', null), note: 'unmapped' });
    const all = await s.recentEvents('1970-01-01T00:00:00.000Z');
    expect(all).toHaveLength(2);
    const none = await s.recentEvents('2999-01-01T00:00:00.000Z');
    expect(none).toHaveLength(0);
  });
});
