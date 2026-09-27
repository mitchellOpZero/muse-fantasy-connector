# Evals

## Unit + integration tests — 41 passing

`npm test` (vitest). No live network in the suite; providers run against fixtures in `tests/fixtures`.

- `tests/billing.test.ts` (12): subject parsing, tier lookup, per-tool 402 payloads with `payment_url`/`pricing_url`, commissioner outranks pro, unknown tools default free.
- `tests/providers.test.ts` (17): Sleeper parsing (standings sort, roster starters/bench, matchup pairing, trade/waiver labels, trending names), ESPN id validation plus standings/matchup/roster/transaction parsing, Yahoo league key validation, PKCE S256 cross-checked between node crypto and python hashlib, authorize URL shape, token-required reads.
- `tests/transport.test.ts` (6): initialize returns one JSON body with `Accept: application/json` only (no `text/event-stream`), tools/list exposes exactly the 10 tools, `GET /mcp` is 405, malformed JSON is a clean JSON-RPC parse error, static docs + health serve, `/v1/yahoo/authorize` without config is a clean 501.
- `tests/gating.test.ts` (6): end-to-end 402 over MCP for anonymous `analyze_trade`, commissioner gate for pro callers on `weekly_recap`, entitled subjects pass the gate and fail later on validation, free tools stay free, private ESPN/Yahoo `connect_league` 402s for free callers and passes for pro.

## Live E2E — 2026-09-27, all green

Local server (`npm run build && npm start`), real MCP calls against live APIs:

1. `initialize` → 200, single JSON body, server `fantasy-football` 0.1.0.
2. `connect_league` ESPN `1446375` → **BakaBois**, 12 teams, week 3, in-season. Live.
3. `get_standings` → 12 real rows (Zula 2-0, 279.98 pts leads).
4. `list_transactions` → 200, empty list (correct for this league/week).
5. `analyze_trade` anonymous → 402 `payment_required`, `required_tier: pro`, with `payment_url` and `pricing_url`. No credential leak in output.
6. `connect_league` ESPN with private cookies, anonymous → 402 `required_tier: pro`.

Sleeper live state endpoint verified separately: 2026 season, week 3. Full Sleeper league flow is fixture-tested; a live public Sleeper league id was not exercised in this eval.

## Not yet evaluated

- Live Yahoo OAuth round trip (needs an approved Yahoo app with a registered redirect URI). Auth contract reconciled 2026-09-27: Yahoo's current docs require OAuth 2.0 authorization code flow (OAuth 1.0a is legacy); the implementation matches the current contract.
- Stripe webhook (501 stub by design until checkout is wired).
- Free-tier one-league counting (needs durable per-user storage; documented in SUBMISSION.md).
