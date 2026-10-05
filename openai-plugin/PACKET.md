# FantasyPlug — OpenAI Plugins submission packet

Prepared 2026-10-05. Everything in `openai-plugin/` is ready to ZIP and upload.
Code changes below are written and type-checked locally — **not deployed**.

## What's in the packet

- `openai-plugin/plugin.json` — manifest (Agent Plugins format): listing copy
  (all length limits respected), URLs, capabilities, review test cases
  (5 positive + 3 negative, each pre-run against the live server 2026-10-05
  on public ESPN league 1446375), publication countries + release notes.
- `openai-plugin/mcp.json` — declares the one MCP server:
  `https://muse-fantasy-connector.vercel.app/mcp` (streamable HTTP).
- `openai-plugin/assets/icon.png`, `logo.png` — 512×512 PNG (meets ≥48×48, ≤5 MiB).

To build the ZIP: `cd openai-plugin && zip -r fantasyplug-1.0.0.zip .`

## Code changes (local, NOT deployed)

1. `src/fantasy.ts` — all 10 tools now carry MCP annotations
   (`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
   `openWorldHint: true`). OpenAI reviewers commonly reject on wrong/missing
   annotations; ours are all reads, which the annotations now state.
2. `src/server.ts` — new route `/.well-known/openai-apps-challenge` serving
   the exact token from the `OPENAI_APPS_CHALLENGE` env var as plain text
   (404 while unset). Required for the dashboard's domain-verification step.
3. `src/static/pricing.html` + `GET /pricing` — informational plans page.
   Describes Free/Pro/Commissioner with **no checkout buttons, no Stripe
   links, no upgrade initiation**. Subscriptions are managed on
   operatorzero.ai. OpenAI forbids linking directly to checkout from a
   plugin; the 402 paywall must point here instead of the Stripe links.

## Before submitting — required changes

- [ ] Deploy the code changes above (say the word).
- [ ] In Vercel env, set `PRO_PAYMENT_URL` and `COMMISSIONER_PAYMENT_URL` to
      `https://muse-fantasy-connector.vercel.app/pricing` (replaces the direct
      Stripe checkout links in the 402 payload — required by OpenAI's commerce
      rules; also fine for Meta). Takes effect on next deploy.
- [ ] Confirm `category: "Sports"` exists in the dashboard category list;
      change in `plugin.json` if the exact value differs.
- [ ] `supportURL` is currently `https://operatorzero.ai` (homepage). A
      dedicated support page would be stronger — optional.
- [ ] Replace `demo_recording_url` in `plugin.json` with the real walkthrough
      video URL (record: connect league → roster → matchup → waiver 402).
- [ ] Reviewer premium testing: generate a long random Bearer <redacted> add it to
      `PREMIUM_SUBJECTS` and `COMMISSIONER_SUBJECTS` in Vercel env, and give
      the reviewer the token + instruction to send it as
      `Authorization: Bearer <token>`. (Free tools need no auth; the token
      unlocks the 3 Pro tools + weekly_recap for review.)

## Mitchell-only steps (need your OpenAI sign-in)

1. Sign in at https://platform.openai.com/plugins, pick the org/project.
2. Complete individual or business verification in Organization Settings
   (unverified publisher name = rejection).
3. Upload new plugin → choose your verified developer identity → upload the ZIP.
4. Dashboard → MCPs → Connect: verify the server URL, complete the
   domain-verification challenge (dashboard shows the token — set it as
   `OPENAI_APPS_CHALLENGE` in Vercel env and redeploy), run Scan Tools,
   resolve any findings.
5. Review details: enter the reviewer Bearer <redacted> test cases import from the ZIP;
   confirm the demo video URL.
6. Submit for review → respond to email feedback → on approval, **Publish plugin**
   (approval ≠ publication; you publish manually).

No submission fee. No published review SLA ("timelines may vary").

## Known review risks

- **Commerce:** handled by the /pricing flip above — plugin never initiates
  a purchase; subscriptions live on the website. `commerce: false` in manifest.
- **"Unofficial connector" rule:** the plugin reads Sleeper/ESPN public APIs
  (authorized, ToS-compliant). It doesn't impersonate those services; its
  stated purpose is fantasy team management. Flagged in case a reviewer asks.
- **Yahoo:** advertised in tool schemas but not operational (no Yahoo OAuth
  app wired). Same exposure as the Meta submission — strip or wire before
  either review reaches tool testing.
