# Share FantasyPlug with a friend

Two ways to get the connector running in another person's AI setup.
Everything below was verified working on 2026-10-05.

## Option 1 — Hosted (easiest, no install)

The connector is live at `https://muse-fantasy-connector.vercel.app/mcp`.
Point any MCP client at that URL and it works exactly like the submitted build.

**Claude Code** (one command):

```bash
claude mcp add --transport http fantasyplug https://muse-fantasy-connector.vercel.app/mcp
```

**Codex CLI** (one command):

```bash
codex mcp add fantasyplug --url https://muse-fantasy-connector.vercel.app/mcp
```

**Claude Desktop / any other MCP client:** add a streamable-HTTP MCP server
with URL `https://muse-fantasy-connector.vercel.app/mcp`.

Then just ask it: "Connect my Sleeper league `<league_id>`" or
"Connect my ESPN league `<league_id>`".

What works with no login: rosters, matchups, standings, transactions for any
public Sleeper or ESPN league. Private ESPN leagues need the user's
`swid` + `espn_s2` cookies — the assistant collects these through its secure
credential flow; never paste them into chat.

Paid tiers: trade analyzer, waiver targets, and start/sit advice need Pro
($8/mo); the weekly recap needs Commissioner ($25/mo). Calling one without
the tier returns a 402 with a subscribe link — the connector never charges
anyone itself.

Yahoo leagues are not available on the hosted instance yet (Sleeper + ESPN
only). Self-hosters can wire their own Yahoo OAuth app (see below).

## Option 2 — Self-host (run your own copy)

```bash
git clone https://github.com/mitchellOpZero/muse-fantasy-connector
cd muse-fantasy-connector
npm install
cp .env.example .env   # edit values (all optional; missing pieces degrade gracefully)
npm run build
npm start              # serves on http://localhost:8102/mcp
```

Then use `http://localhost:8102/mcp` as the server URL in the Option 1
commands above. `Dockerfile` and `vercel.json` are included for containers
and Vercel deploys.

To enable Yahoo on a self-hosted copy, register a Yahoo OAuth app and set
`YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, and `YAHOO_REDIRECT_URI`.
