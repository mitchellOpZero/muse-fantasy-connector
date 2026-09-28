# Muse Directory Submission Pack

Everything needed to list the Fantasy Football Connector in the Muse connector directory.

## Submission checklist

- [x] Public HTTPS MCP endpoint, POST-only Streamable HTTP, single JSON response (`enableJsonResponse`), no SSE
- [x] `GET /mcp` returns 405 (no hang)
- [x] Icon: 512x512 PNG, 133 KB (`icon.png` in this folder and served at `/icon.png`)
- [x] Terms URL: `/terms` (resolvable)
- [x] Privacy URL: `/privacy` (resolvable)
- [x] Documentation: `/muse.md` and `/llms.txt`
- [x] Health check: `/healthz`
- [x] Read-only: no tool mutates provider state
- [x] No secrets in code, repo, logs, or chat
- [x] Private leagues via Muse Secure Credentials Store only

## Form fields (muse.ai/platform)

Fill the directory form with exactly these values. The documentation field takes exactly one URL; multiple URLs fail silently with `invalid_request`.

| Field | Value |
|---|---|
| Name | FantasyPlug |
| Tagline | Manage every fantasy team from one place |
| Description | Sleeper and ESPN in one connector, with Yahoo coming soon. Rosters, matchups, standings, transactions free with no login. Trade analyzer, waiver targets, start/sit advice, and private leagues on Pro. AI weekly recaps for commissioners. Read only, never touches your lineups. |
| MCP endpoint | `https://<your-deploy>/mcp` |
| Documentation URL | `https://<your-deploy>/muse.md` |
| Terms URL | `https://<your-deploy>/terms` |
| Privacy URL | `https://<your-deploy>/privacy` |
| Icon | upload `icon.png` from this folder |
| Category | Sports / Productivity |

Replace `<your-deploy>` with the production domain after Vercel deploy.

## Manual steps (owner only)

1. Deploy to Vercel: `vercel --prod` from the repo root (uses `vercel.json` + `api/index.ts`). Set env vars from `.env.example` in the Vercel dashboard.
2. Wire Stripe: create the $8 Pro and $25 Commissioner products, set `PAYMENT_URL`, and implement `/v1/billing/stripe-webhook` (currently a documented 501 stub) to sync `PREMIUM_SUBJECTS` / `COMMISSIONER_SUBJECTS`.
3. Register the Yahoo OAuth app at https://sports.yahoo.com/developer/ with redirect URI `<your-deploy>/v1/yahoo/callback`, request read-only `fspt-r` scope, set `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` / `YAHOO_REDIRECT_URI`.
4. Custom-install the connector in Muse, verify all 10 tools, then submit the directory form above.

## Known limits

- Free tier is one public league concept; multi-league tracking is a Pro feature enforced at the advice-tool level (advice tools are Pro anyway). Server-side per-user league counting needs durable storage and is on the roadmap.
- Live Yahoo end to end needs the approved Yahoo app above.
