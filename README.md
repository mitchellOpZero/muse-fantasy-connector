# Fantasy Football Connector for Muse

Manage every fantasy team you own from one place. Sleeper, ESPN, and Yahoo. Rosters, matchups, standings, transactions, trade analysis, waiver targets, start/sit help, and weekly recaps, all inside Muse.

Built on patterns proven in [BakaBois](https://github.com/mitchellOpZero/bakaboisv4) and the public Muse connector template.

## What it does

**Free, no login:** connect any public Sleeper or ESPN league and read rosters, matchups, standings, and transactions. `connect_league`, `list_my_teams`, `get_roster`, `get_matchup`, `get_standings`, `list_transactions`.

**Pro:** trade analyzer, waiver targets, start/sit advice, plus private leagues (ESPN with your cookies, Yahoo with OAuth). Tools: `analyze_trade`, `waiver_targets`, `start_sit_advice`.

**Commissioner:** AI weekly recap for your league. Tool: `weekly_recap`.

The connector is read only. It cannot set lineups, claim players, or propose or accept trades.

## Run it yourself

```bash
npm install
npm run typecheck
npm test
npm run build
npm start            # serves on PORT (default 8102)
```

POST-only MCP endpoint at `/mcp`. Health at `/healthz`. Docs at `/muse.md`, `/llms.txt`, `/terms`, `/privacy`.

Deploy anywhere Node runs. `vercel.json` and `api/index.ts` are included for Vercel; `Dockerfile` for containers.

## Configuration

Copy `.env.example` to `.env`. Nothing is required to boot: every optional piece (Yahoo app, paid tiers, Stripe) degrades to an honest "not configured" instead of crashing.

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Public base URL, used in docs links |
| `PAYMENT_URL` / `PRICING_URL` | Where the 402 paywall points |
| `PREMIUM_SUBJECTS` / `COMMISSIONER_SUBJECTS` | Comma separated subject ids holding paid tiers (scaffold; production should sync from Stripe webhooks) |
| `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` / `YAHOO_REDIRECT_URI` | Yahoo OAuth app, private Yahoo leagues only |
| `RATE_LIMIT_PER_MIN` | Per IP rate limit on `/mcp` |

## Paid tiers

See [PRICING.md](PRICING.md). Enforcement is a 402 style gate inside each tool: the tool returns `payment_required` with `payment_url` and `pricing_url`, never a charge. Stripe webhook is a documented 501 stub until checkout is wired.

## Privacy and terms

[PRIVACY.md](PRIVACY.md) and the hosted `/privacy` page. Terms at `/terms`. The connector is stateless: credentials arrive per request from Muse's Secure Credentials Store, are used once, and are never stored or logged.

## Repo layout

```
src/            MCP server, billing, tools, providers (sleeper/espn/yahoo)
api/index.ts    Vercel adapter
tests/          41 tests: billing, providers (fixtures), transport, gating
connectors/muse/  Muse directory submission pack
.claude-plugin/   Claude Code plugin manifest
skills/           Claude skill for fantasy management
```

## Status

Tests: 41 passing. Live E2E verified 2026-09-27 against the real BakaBois ESPN league (1446375): connect, standings, transactions, and the 402 paywall all green.

Yahoo: OAuth 2.0 + PKCE is implemented and fixture tested. Live Yahoo needs an approved Yahoo app with a registered redirect URI; not yet verified end to end.

## License

MIT. Not affiliated with Sleeper, ESPN, or Yahoo.
