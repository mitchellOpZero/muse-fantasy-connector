# E2E — paid features (production)

`paid-features.mjs` exercises the full billing chain against the **live**
deployment: signed (fake) Stripe webhook events grant PRO / COMMISSIONER to
throwaway subjects, every paid MCP tool is called with real league data and
its output content is verified, then both subscriptions are revoked and the
402 gates are verified to close again.

No real money moves. The webhook events are constructed locally and signed
with the live webhook secret exactly as Stripe would sign them.

## Run

```bash
STRIPE_WEBHOOK_SECRET=whsec_... node e2e/paid-features.mjs
# against another deployment:
STRIPE_WEBHOOK_SECRET=whsec_... E2E_BASE_URL=https://<deploy>.vercel.app node e2e/paid-features.mjs
```

Exit code 0 = all checks passed.

## What it covers

| # | Check |
|---|-------|
| 0 | Anonymous caller gets 402 on `analyze_trade` (sanity) |
| 1 | Signed `checkout.session.completed` (800¢) grants PRO; (2500¢) grants COMMISSIONER |
| 2 | `analyze_trade` with real players from real rosters returns a verdict naming them + scoring edge |
| 3 | `waiver_targets` (ESPN) returns a structured targets list |
| 4 | `start_sit_advice` returns suggestions for a real team |
| 5 | `weekly_recap` (latest week with real scores, found dynamically) names a top scorer and power ranking |
| 6 | Commissioner subject passes the Pro tier gate (hierarchy) |
| 7 | Signed `customer.subscription.deleted` revokes both; both subjects 402 again |

Test subjects are `e2e-pro-subject` / `e2e-comm-subject`. A `finally` block
revokes any still-granted test subscription so nothing stays entitled.

## Notes

- Event ids are unique per run (Stripe dedupes replays).
- Webhook signature: `t=<unix_ts>,v1=<hmac_sha256("<ts>.<raw_body>")>`, 300s tolerance.
- Requests retry up to 4x on connection flakes.
- Never commit `STRIPE_WEBHOOK_SECRET`. Read it from the Stripe dashboard
  (Developers → Webhooks → the endpoint → Signing secret) at run time.
