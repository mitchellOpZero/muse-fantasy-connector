#!/usr/bin/env node
/**
 * End-to-end test for FantasyPlug PAID features against production.
 *
 * Grants PRO and COMMISSIONER tiers to throwaway test subjects via
 * cryptographically-signed (fake) Stripe webhook events, exercises every
 * paid MCP tool against REAL league data, verifies the output content
 * (not just "not 402"), then revokes everything.
 *
 * No real payment is involved: events are constructed locally and signed
 * with the live webhook secret, exactly as Stripe would sign them.
 *
 * Run:  STRIPE_WEBHOOK_SECRET=whsec_... node e2e/paid-features.mjs
 *   or: STRIPE_WEBHOOK_SECRET=whsec_... E2E_BASE_URL=https://... node e2e/paid-features.mjs
 *
 * Exit 0 = all checks passed, 1 = at least one failed.
 */

import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.E2E_BASE_URL ?? 'https://muse-fantasy-connector.vercel.app';
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('FATAL: STRIPE_WEBHOOK_SECRET env var is required (never commit it).');
  process.exit(2);
}

const LEAGUE = { platform: 'espn', league_id: '1446375' }; // public BakaBois league
const PRO_SUBJECT = 'e2e-pro-subject';
const COMM_SUBJECT = 'e2e-comm-subject';
const RUN = Date.now().toString(36);
const PRO_SUB_ID = `sub_e2e_pro_${RUN}`;
const COMM_SUB_ID = `sub_e2e_comm_${RUN}`;

const results = [];
function check(name, ok, evidence = '') {
  results.push({ name, ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${evidence ? ' — ' + evidence : ''}`);
}

/** POST with retries on connection flakes (up to 4 attempts). */
async function req(path, { body, headers = {}, timeoutMs = 60000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, {
        method: 'POST',
        body,
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return { status: -1, text: `CONN_FAIL: ${lastErr?.message ?? lastErr}` };
}

function stripeSig(raw) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET)
    .update(`${t}.${raw.toString('utf8')}`, 'utf8')
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

async function webhookEvent(evt) {
  const raw = Buffer.from(JSON.stringify(evt));
  return req('/v1/billing/webhook', {
    body: raw,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': stripeSig(raw) },
  });
}

async function mcpTool(name, args, subject) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const r = await req('/mcp', {
    body,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(subject ? { 'X-Muse-Subject': subject } : {}),
    },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    /* non-JSON body */
  }
  return { ...r, parsed };
}

const is402 = (r) =>
  r.status === 200 &&
  r.parsed?.result?.structuredContent?.code === 'payment_required';
const resultText = (r) => r.parsed?.result?.content?.[0]?.text ?? '';
const structured = (r) => r.parsed?.result?.structuredContent ?? null;

function checkoutEvent({ subject, amountCents, subscriptionId }) {
  const eid = `evt_e2e_${RUN}_${randomUUID().slice(0, 8)}`;
  return {
    id: eid,
    type: 'checkout.session.completed',
    livemode: true,
    data: {
      object: {
        id: `cs_${eid}`,
        client_reference_id: subject,
        amount_total: amountCents,
        currency: 'usd',
        customer: `cus_${eid}`,
        customer_email: `${subject}@example.com`,
        customer_details: { email: `${subject}@example.com` },
        subscription: subscriptionId,
      },
    },
  };
}

function deleteEvent(subscriptionId) {
  const eid = `evt_e2e_${RUN}_${randomUUID().slice(0, 8)}`;
  return {
    id: eid,
    type: 'customer.subscription.deleted',
    livemode: true,
    data: { object: { id: subscriptionId, status: 'canceled' } },
  };
}

const grantedSubs = new Set();
async function grant(subject, amountCents, subscriptionId) {
  const r = await webhookEvent(checkoutEvent({ subject, amountCents, subscriptionId }));
  const ok = r.status === 200 && r.text.includes('"received":true');
  if (ok) grantedSubs.add(subscriptionId);
  return ok;
}
async function revoke(subscriptionId) {
  const r = await webhookEvent(deleteEvent(subscriptionId));
  grantedSubs.delete(subscriptionId);
  return r.status === 200 && r.text.includes('"received":true');
}

async function main() {
  console.log(`Target: ${BASE}\n`);

  // ---- 0. Sanity: anonymous caller is 402 on a paid tool ----
  {
    const r = await mcpTool('analyze_trade', { ...LEAGUE, my_team_id: '1', other_team_id: '3', players_in: ['x'], players_out: ['y'] }, null);
    check('sanity: anonymous analyze_trade is 402', is402(r), `http ${r.status}`);
  }

  // ---- 1. Grant PRO + COMMISSIONER ----
  check('grant PRO via signed webhook', await grant(PRO_SUBJECT, 800, PRO_SUB_ID));
  check('grant COMMISSIONER via signed webhook', await grant(COMM_SUBJECT, 2500, COMM_SUB_ID));

  // ---- 2. Real team/player data for the paid-tool calls ----
  const teamsRes = await mcpTool('list_my_teams', LEAGUE, null);
  const teams = teamsRes.parsed?.result?.structuredContent?.teams ?? [];
  check('test data: list_my_teams returns 12 teams', teams.length === 12, `${teams.length} teams`);
  const [teamA, teamB] = teams;
  const rosterA = await mcpTool('get_roster', { ...LEAGUE, team_id: teamA.team_id }, null);
  const rosterB = await mcpTool('get_roster', { ...LEAGUE, team_id: teamB.team_id }, null);
  const startersA = rosterA.parsed?.result?.structuredContent?.roster?.starters ?? [];
  const startersB = rosterB.parsed?.result?.structuredContent?.roster?.starters ?? [];
  const playerA = startersA[0]?.name;
  const playerB = startersB[0]?.name;
  check('test data: real player names from both rosters', !!(playerA && playerB), `${playerA} / ${playerB}`);

  // ---- 3. analyze_trade (PRO): real players, verify content ----
  {
    const r = await mcpTool(
      'analyze_trade',
      { ...LEAGUE, my_team_id: teamA.team_id, other_team_id: teamB.team_id, players_in: [playerA], players_out: [playerB] },
      PRO_SUBJECT,
    );
    const t = resultText(r);
    const s = structured(r);
    const ok =
      !is402(r) &&
      t.includes(playerA) &&
      t.includes(playerB) &&
      t.includes('Scoring edge:') &&
      typeof s?.analysis?.in_score === 'number';
    check('analyze_trade returns real verdict', ok, t.slice(0, 160).replace(/\n/g, ' '));
  }

  // ---- 4. waiver_targets (PRO, ESPN): verify structured list ----
  {
    const r = await mcpTool('waiver_targets', { ...LEAGUE, limit: 5 }, PRO_SUBJECT);
    const s = structured(r);
    const ok = !is402(r) && Array.isArray(s?.targets);
    check('waiver_targets returns structured targets', ok, `${s?.targets?.length ?? '?'} targets`);
  }

  // ---- 5. start_sit_advice (PRO): real team, verify structure ----
  {
    const r = await mcpTool('start_sit_advice', { ...LEAGUE, team_id: teamA.team_id }, PRO_SUBJECT);
    const t = resultText(r);
    const s = structured(r);
    const ok = !is402(r) && Array.isArray(s?.suggestions) && t.includes(teamA.name);
    check('start_sit_advice returns suggestions', ok, `${s?.suggestions?.length ?? '?'} suggestions for ${teamA.name}`);
  }

  // ---- 6. weekly_recap (COMMISSIONER): latest fully-played week ----
  // Find the latest week with real scores (weeks in progress show 0s).
  let recapWeek = 0;
  for (let w = 18; w >= 1; w--) {
    const mr = await mcpTool('get_matchup', { ...LEAGUE, week: w }, null);
    const ms = mr.parsed?.result?.structuredContent?.matchups ?? [];
    if (ms.some((m) => (m.home?.points ?? 0) > 0 || (m.away?.points ?? 0) > 0)) {
      recapWeek = w;
      break;
    }
  }
  check('test data: found a played week', recapWeek > 0, `week ${recapWeek}`);
  {
    const r = await mcpTool('weekly_recap', { ...LEAGUE, week: recapWeek }, COMM_SUBJECT);
    const t = resultText(r);
    const topLine = t.split('\n').find((l) => l.includes('Top scorer:'))?.trim() ?? '';
    const ok =
      !is402(r) &&
      t.includes('Top scorer:') &&
      t.includes('Power ranking') &&
      !/\(0\.0\)/.test(topLine); // real scores, not placeholder zeros
    check('weekly_recap names top scorer + power ranking', ok, topLine);
  }

  // ---- 7. Tier hierarchy: commissioner can use pro tools ----
  {
    const r = await mcpTool(
      'analyze_trade',
      { ...LEAGUE, my_team_id: teamA.team_id, other_team_id: teamB.team_id, players_in: [playerA], players_out: [playerB] },
      COMM_SUBJECT,
    );
    check('commissioner passes pro tier gate', !is402(r), `http ${r.status}`);
  }

  // ---- 8. Revoke both, verify 402s return ----
  check('revoke PRO subscription', await revoke(PRO_SUB_ID));
  check('revoke COMMISSIONER subscription', await revoke(COMM_SUB_ID));
  {
    const r1 = await mcpTool('analyze_trade', { ...LEAGUE, my_team_id: '1', other_team_id: '3', players_in: ['x'], players_out: ['y'] }, PRO_SUBJECT);
    check('PRO subject is 402 after revoke', is402(r1), `http ${r1.status}`);
    const r2 = await mcpTool('weekly_recap', { ...LEAGUE, week: recapWeek }, COMM_SUBJECT);
    check('COMMISSIONER subject is 402 after revoke', is402(r2), `http ${r2.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failed:', failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  // Best-effort cleanup: never leave a test subject entitled.
  for (const subId of [...grantedSubs]) {
    try {
      await revoke(subId);
      console.log(`cleanup: revoked ${subId}`);
    } catch {
      console.log(`cleanup FAILED for ${subId} — revoke manually`);
    }
  }
}
