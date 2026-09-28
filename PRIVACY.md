# Privacy Policy

Effective 2026-09-27. The hosted version of this page lives at `/privacy` on the deployed connector.

## What this connector does

It reads your fantasy football leagues on Sleeper, ESPN, and Yahoo so Muse can show rosters, matchups, standings, transactions, and advice. It is read only. It cannot change lineups, submit waiver claims, or propose or accept trades.

## Data we handle

- **Public leagues:** the league id, season, week, and team id you provide, plus the public league data returned by the provider. No account or login needed.
- **Private leagues:** ESPN `swid` / `espn_s2` cookies or a Yahoo OAuth access token. These arrive per request from Muse's Secure Credentials Store, are used only to call the provider for that request, and are never written to disk, never logged, and never sent anywhere else.
- **Operational:** request method, path, status code, and timing for reliability. No request or response bodies are logged.

## What we do not do

- No persistent storage of league data, credentials, or tokens on the server.
- No sale or sharing of your data with advertisers or data brokers.
- No tracking cookies. No analytics SDKs.

## Subscription status

Tier checks (Free / Pro / Commissioner) read a subject identifier from the request and compare it against a server-side list. No payment details are handled by this connector; checkout happens on the payment provider's page. When you subscribe, the payment provider's webhook stores a tier entitlement keyed by that subject identifier (tier, subscription id, customer id — no card or payment details) in the server's store (Vercel KV in production) so paid tools unlock. It is removed when the subscription ends.

## Retention

League data, credentials, and tokens are never retained: the connector is stateless for those. In-memory caches (Sleeper player map, rate limiter) live only in the running process and are discarded on restart. Paid-tier entitlements persist in the server store until the subscription ends or is cancelled, plus an audit log of billing events (capped at 200 entries).

## Contact

Questions: open an issue at https://github.com/mitchellOpZero/muse-fantasy-connector

This connector is not affiliated with Sleeper, ESPN, or Yahoo.
