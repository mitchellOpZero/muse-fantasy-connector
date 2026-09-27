# Security model

## Read-only by design

No tool can change anything on Sleeper, ESPN, or Yahoo. There is no code path that sets a lineup, submits a waiver claim, or proposes or accepts a trade. The providers only issue GET requests.

## Credentials

- Public Sleeper and ESPN leagues need no authentication at all.
- Private ESPN leagues use `swid` + `espn_s2` cookies; Yahoo uses an OAuth 2.0 access token with read-only `fspt-r` scope. Both arrive per request from Muse's Secure Credentials Store and are passed to the tool as arguments.
- The server is stateless: credentials are used for the single upstream call and never written to disk, never cached, never logged.
- Request logging records only method, path, status, and timing. No headers, bodies, or query strings are logged.
- The Yahoo OAuth `state` parameter is a signed random token bound to the client id; the token exchange is server-to-server.

## Transport

- Public HTTPS only. POST-only MCP endpoint; `GET` and `DELETE` on `/mcp` return 405.
- 64 KB request body cap, per-IP rate limiting, CORS restricted to the documented origins.
- Single JSON response per request (`enableJsonResponse`); no Server-Sent Events, so nothing hangs on proxies that buffer streams.

## Billing

- Tier checks compare a subject identifier from the request against a server-side list. Subjects are opaque strings (Muse user ids or emails), not passwords.
- The connector never sees card numbers and never charges anyone: premium tools return `402 Payment Required` with a `payment_url`, and checkout happens on the payment provider.
- The Stripe webhook endpoint is a documented 501 stub until checkout is wired; it accepts nothing.

## Supply chain

- Dependencies are pinned via `package-lock.json`. `npm run typecheck` (strict) and `npm test` (41 tests) run on every change.
- No analytics SDKs, no tracking cookies, no third-party scripts. The static pages (`/terms`, `/privacy`) are plain HTML.

## Disclosure

Found a vulnerability? Open a private security advisory at https://github.com/mitchellOpZero/muse-fantasy-connector/security/advisories.
