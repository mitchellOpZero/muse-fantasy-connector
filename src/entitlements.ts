/**
 * Subject -> tier entitlement storage.
 *
 * The Stripe webhook (server.ts) writes here when a checkout completes or a
 * subscription ends; the MCP tier gate (billing.ts) reads here on every gated
 * tool call. Two backends:
 *
 *   MemoryEntitlementStore — local dev and tests. Dies with the process.
 *   KvEntitlementStore     — production on Vercel. Backed by Vercel KV
 *                            (Upstash Redis) via KV_REST_API_URL / TOKEN.
 *
 * No customer PII is stored: subjects are opaque Muse-issued user ids, and
 * only the Stripe subscription/customer ids needed for revoke-by-webhook.
 */
import { createClient, type VercelKV } from '@vercel/kv';
import type { Tier } from './billing.js';

export interface EntitlementRecord {
  tier: 'pro' | 'commissioner';
  subscriptionId: string | null;
  customerId: string | null;
  updatedAt: string; // ISO
}

export interface BillingEventRecord {
  /** Stripe event id (evt_...) or a synthetic id for admin actions. */
  id: string;
  /** e.g. checkout.session.completed, customer.subscription.deleted */
  type: string;
  /** Sanitized Muse subject, or null when the payment could not be mapped. */
  subject: string | null;
  tier: Tier | null;
  /** Customer email when Stripe provided one (admin endpoint only). */
  email: string | null;
  subscriptionId: string | null;
  livemode: boolean;
  createdAt: string; // ISO
  note?: string;
}

export interface EntitlementStore {
  getTier(subject: string): Promise<Tier | null>;
  setEntitlement(subject: string, rec: EntitlementRecord): Promise<void>;
  removeEntitlement(subject: string): Promise<void>;
  subjectForSubscription(subscriptionId: string): Promise<string | null>;
  seenEvent(eventId: string): Promise<boolean>;
  markEventSeen(eventId: string): Promise<void>;
  recordEvent(evt: BillingEventRecord): Promise<void>;
  recentEvents(sinceIso: string, limit?: number): Promise<BillingEventRecord[]>;
}

export class MemoryEntitlementStore implements EntitlementStore {
  private tiers = new Map<string, EntitlementRecord>();
  private subIndex = new Map<string, string>();
  private seen = new Set<string>();
  private events: BillingEventRecord[] = [];

  async getTier(subject: string): Promise<Tier | null> {
    return this.tiers.get(subject)?.tier ?? null;
  }
  async setEntitlement(subject: string, rec: EntitlementRecord): Promise<void> {
    const prev = this.tiers.get(subject);
    if (prev?.subscriptionId && prev.subscriptionId !== rec.subscriptionId) {
      this.subIndex.delete(prev.subscriptionId);
    }
    this.tiers.set(subject, rec);
    if (rec.subscriptionId) this.subIndex.set(rec.subscriptionId, subject);
  }
  async removeEntitlement(subject: string): Promise<void> {
    const prev = this.tiers.get(subject);
    if (prev?.subscriptionId) this.subIndex.delete(prev.subscriptionId);
    this.tiers.delete(subject);
  }
  async subjectForSubscription(subscriptionId: string): Promise<string | null> {
    return this.subIndex.get(subscriptionId) ?? null;
  }
  async seenEvent(eventId: string): Promise<boolean> {
    return this.seen.has(eventId);
  }
  async markEventSeen(eventId: string): Promise<void> {
    this.seen.add(eventId);
  }
  async recordEvent(evt: BillingEventRecord): Promise<void> {
    this.events.push(evt);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }
  async recentEvents(sinceIso: string, limit = 50): Promise<BillingEventRecord[]> {
    return this.events.filter((e) => e.createdAt >= sinceIso).slice(-limit);
  }
}

const TIER_KEY = (s: string) => `fp:tier:${s}`;
const SUB_KEY = (id: string) => `fp:sub:${id}`;
const SEEN_KEY = (id: string) => `fp:seen:${id}`;
const EVENTS_KEY = 'fp:events';
const MAX_EVENTS = 200;

/**
 * Production store. Reads are served through a short in-process cache so a
 * KV round trip does not happen on every gated tool call; writes invalidate
 * the cache entry in the writing instance (cross-instance staleness <= TTL).
 */
export class KvEntitlementStore implements EntitlementStore {
  private kv: VercelKV;
  private cache = new Map<string, { tier: Tier | null; expires: number }>();
  private cacheTtlMs: number;

  constructor(url?: string, token?: string, cacheTtlMs = 30_000) {
    this.kv = createClient({
      url: url ?? process.env.KV_REST_API_URL ?? '',
      token: token ?? process.env.KV_REST_API_TOKEN ?? '',
    });
    this.cacheTtlMs = cacheTtlMs;
  }

  async getTier(subject: string): Promise<Tier | null> {
    const hit = this.cache.get(subject);
    if (hit && hit.expires > Date.now()) return hit.tier;
    const rec = await this.kv.get<EntitlementRecord>(TIER_KEY(subject));
    const tier = rec?.tier === 'commissioner' || rec?.tier === 'pro' ? rec.tier : null;
    this.cache.set(subject, { tier, expires: Date.now() + this.cacheTtlMs });
    return tier;
  }

  async setEntitlement(subject: string, rec: EntitlementRecord): Promise<void> {
    const prev = await this.kv.get<EntitlementRecord>(TIER_KEY(subject));
    const multi = this.kv.multi();
    multi.set(TIER_KEY(subject), JSON.stringify(rec));
    if (rec.subscriptionId) multi.set(SUB_KEY(rec.subscriptionId), subject);
    if (prev?.subscriptionId && prev.subscriptionId !== rec.subscriptionId) {
      multi.del(SUB_KEY(prev.subscriptionId));
    }
    await multi.exec();
    this.cache.delete(subject);
  }

  async removeEntitlement(subject: string): Promise<void> {
    const prev = await this.kv.get<EntitlementRecord>(TIER_KEY(subject));
    const multi = this.kv.multi();
    multi.del(TIER_KEY(subject));
    if (prev?.subscriptionId) multi.del(SUB_KEY(prev.subscriptionId));
    await multi.exec();
    this.cache.delete(subject);
  }

  async subjectForSubscription(subscriptionId: string): Promise<string | null> {
    return (await this.kv.get<string>(SUB_KEY(subscriptionId))) ?? null;
  }

  async seenEvent(eventId: string): Promise<boolean> {
    return (await this.kv.exists(SEEN_KEY(eventId))) === 1;
  }

  async markEventSeen(eventId: string): Promise<void> {
    // 24h dedup window; Stripe retries land well inside it.
    await this.kv.set(SEEN_KEY(eventId), '1', { ex: 86_400 });
  }

  async recordEvent(evt: BillingEventRecord): Promise<void> {
    const multi = this.kv.multi();
    multi.lpush(EVENTS_KEY, JSON.stringify(evt));
    multi.ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
    await multi.exec();
  }

  async recentEvents(sinceIso: string, limit = 50): Promise<BillingEventRecord[]> {
    const raw = await this.kv.lrange<string>(EVENTS_KEY, 0, MAX_EVENTS - 1);
    const out: BillingEventRecord[] = [];
    for (const item of raw) {
      try {
        const evt = JSON.parse(item) as BillingEventRecord;
        if (evt.createdAt >= sinceIso) out.push(evt);
      } catch {
        // Skip corrupt entries; the log must never break the admin endpoint.
      }
    }
    return out.slice(0, limit).reverse();
  }
}

/** KV in production (Vercel injects the env vars), memory everywhere else. */
export function createEntitlementStore(): EntitlementStore {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return new KvEntitlementStore();
  }
  return new MemoryEntitlementStore();
}
