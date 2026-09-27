# Fantasy Football Connector — brief for Muse

Manage fantasy football teams from Muse. Public HTTPS MCP server: `POST /mcp`
(Streamable HTTP, single JSON body per response — never SSE; `GET /mcp` returns
405 by design).

## What it does

- **Sleeper** — fully public, no auth. Any public league by numeric league id.
- **ESPN** — public leagues by numeric league id, no auth. Private leagues
  need the `swid` + `espn_s2` cookies.
- **Yahoo** — private leagues only, via OAuth 2.0 + PKCE. Start at
  `GET /v1/yahoo/authorize`, finish at `POST /v1/yahoo/callback`.
- **Trade alerts / check-ins** — the connector is stateless and pollable: call
  `list_transactions` on a schedule (Muse jobs) and diff against the last
  check. See INSTALL.md for the check-in setup.

## Tools (9)

Free (no subscription): `connect_league`, `list_my_teams`, `get_roster`,
`get_matchup`, `get_standings`, `list_transactions`.

Premium, 402-gated: `analyze_trade`, `waiver_targets`, `start_sit_advice`
need **Pro**; `weekly_recap` needs **Commissioner**. Without the tier, the
tool returns an error result with `structuredContent.http_status = 402`,
`code = "payment_required"`, and a `payment_url` — an x402-style payload.
The connector never charges anyone itself; tell the user the tier and the URL.

Every tool is **read-only**. Nothing here can set lineups, propose or accept
trades, add/drop players, or change a league. The advice tools
(`analyze_trade`, `waiver_targets`, `start_sit_advice`) are **heuristic**
(projections / recent scoring where available) — say so, do not present them
as projection-model grade.

## Calling it

Single JSON body per POST, `Accept: application/json` is enough:

```bash
curl -sS --http1.1 -X POST 'https://<host>/mcp' \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"muse","version":"1.0.0"}}}'

curl -sS -X POST 'https://<host>/mcp' \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

curl -sS -X POST 'https://<host>/mcp' \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"connect_league","arguments":{"platform":"sleeper","league_id":"1048912804323000320"}}}'
```

League coordinates:

- Sleeper: numeric league id (digits).
- ESPN: numeric league id. Season defaults to the current year.
- Yahoo: league key like `nfl.l.12345`, plus `credential.yahoo_access_token`.

For private ESPN leagues pass `credential: { "espn_swid": "...", "espn_s2": "..." }`.
Credentials must come from the user's Secure Credentials Store — never ask the
user to paste them raw, never repeat them, never store them here.

## If a call seems to hang

Do not fall back to guessing. Retry once with `Accept: application/json` and a
fresh connection. `GET /mcp` returning 405 means the host is up.

## Subscription tiers

Tiers are resolved from the `Authorization: Bearer <subject>` or
`x-muse-subject` header against the connector's subscription list (env-backed
scaffold; Stripe webhook stub at `POST /v1/billing/webhook`). Anonymous
callers are Free.

- **Free** — 1 league: roster, matchup, standings, transactions views.
- **Pro ($8/mo)** — unlimited leagues, `analyze_trade`, `waiver_targets`,
  `start_sit_advice`, private leagues.
- **Commissioner ($25/mo per league)** — everything in Pro plus
  `weekly_recap` (recaps, power rankings, trade review, draft kit).

Full terms: `/terms`. Pricing: PRICING.md in the repo.
