# Pricing

Simple tiers. Pay for advice and private leagues, not for reading your teams.

## Free — $0

Everything you need to follow your leagues:

- Connect one public Sleeper or ESPN league
- Rosters, matchups, standings, transactions
- No account, no login, no credit card

## Pro — $8/month

For managers who want an edge:

- Trade analyzer: fair value check before you accept or counter
- Waiver targets: who to pick up this week, ranked
- Start/sit advice: lineup calls with reasoning
- Private leagues: ESPN with your login cookies, Yahoo with OAuth
- Multiple leagues across Sleeper, ESPN, and Yahoo

## Commissioner — $25/month per league

For the person running the show:

- Everything in Pro
- AI weekly recap: results, top performers, power shifts, written for your group chat

## How billing works

The connector never charges you itself. When a tool needs a paid tier, it answers `402 Payment Required` with a link to subscribe. Checkout happens on the payment page, and your tier is checked on every call.

Prices in USD. Cancel anytime; you keep paid features until the end of the billing period.

Checkout and subscription management links are configured at deploy time (`PAYMENT_URL`, `PRO_PAYMENT_URL`, `COMMISSIONER_PAYMENT_URL`). The Stripe webhook verifies each payment and unlocks the buyer's tier automatically; subscription cancellations revoke it at period end.
