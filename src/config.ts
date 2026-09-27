/**
 * Connector configuration. Everything is optional: the connector runs with
 * zero config and degrades with honest "not configured" answers instead of
 * crashing. Nothing secret is required to serve public leagues.
 */
export interface ConnectorConfig {
  serviceName: string;
  publicUrl: string;
  paymentUrl: string;
  proPaymentUrl: string;
  commissionerPaymentUrl: string;
  pricingUrl: string;
  supportEmail: string;
  rateLimitPerMin: number;
  premiumSubjects: Set<string>;
  commissionerSubjects: Set<string>;
  yahoo: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
}

function csv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  return {
    serviceName: env.SERVICE_NAME ?? 'Fantasy Football Connector',
    publicUrl: (env.PUBLIC_URL ?? 'http://127.0.0.1:8102').replace(/\/$/, ''),
    paymentUrl: env.PAYMENT_URL ?? 'https://example.com/subscribe',
    proPaymentUrl:
      env.PRO_PAYMENT_URL ?? env.PAYMENT_URL ?? 'https://example.com/subscribe',
    commissionerPaymentUrl:
      env.COMMISSIONER_PAYMENT_URL ??
      env.PAYMENT_URL ??
      'https://example.com/subscribe',
    pricingUrl:
      env.PRICING_URL ??
      'https://github.com/mitchellOpZero/muse-fantasy-connector/blob/main/PRICING.md',
    supportEmail: env.SUPPORT_EMAIL ?? 'support@example.com',
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN ?? 600),
    premiumSubjects: csv(env.PREMIUM_SUBJECTS),
    commissionerSubjects: csv(env.COMMISSIONER_SUBJECTS),
    yahoo: {
      clientId: env.YAHOO_CLIENT_ID || undefined,
      clientSecret: env.YAHOO_CLIENT_SECRET || undefined,
      redirectUri: env.YAHOO_REDIRECT_URI || undefined,
    },
  };
}
