/**
 * The 10 fantasy tools. Free tier: connect_league, list_my_teams, get_roster,
 * get_matchup, get_standings, list_transactions. Premium (402-gated):
 * analyze_trade, waiver_targets, start_sit_advice (Pro) and weekly_recap
 * (Commissioner).
 *
 * The connector is stateless: every tool takes the league coordinates
 * directly. `connect_league` is the discovery/validation step that returns
 * the canonical coordinates to reuse.
 *
 * Read-only by design: no tool can set lineups, propose trades, or change
 * anything on the provider. Advice tools return heuristic analysis and say
 * so; they are not projection-model grade.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConnectorConfig } from './config.js';
import { paymentRequiredText, requireTier, requireTierFor, subjectFromHeaders, type Tier } from './billing.js';
import { MemoryEntitlementStore, type EntitlementStore } from './entitlements.js';
import { createSleeperProvider, sleeperTrendingAdds } from './providers/sleeper.js';
import { createEspnProvider } from './providers/espn.js';
import { createYahooProvider } from './providers/yahoo.js';
import {
  ProviderError,
  hasPrivateCredential,
  type LeagueInput,
  type LeagueProvider,
  type Platform,
  type PlayerEntry,
} from './providers/types.js';
import type { FetchImpl } from './providers/http.js';

const platformSchema = z.enum(['sleeper', 'espn', 'yahoo']);
const credentialSchema = z
  .object({
    espn_swid: z.string().optional().describe('ESPN private league: swid cookie. From the Secure Credentials Store only.'),
    espn_s2: z.string().optional().describe('ESPN private league: espn_s2 cookie. From the Secure Credentials Store only.'),
    yahoo_access_token: z.string().optional().describe('Yahoo private league: OAuth access token. From the Secure Credentials Store only.'),
  })
  .optional();

const leagueArgs = {
  platform: platformSchema.describe('sleeper | espn | yahoo'),
  league_id: z
    .string()
    .describe('Sleeper: numeric league id. ESPN: numeric league id. Yahoo: league key like "nfl.l.12345".'),
  season: z.number().int().optional().describe('Season year; defaults to the current season.'),
  credential: credentialSchema,
};

export interface ToolDeps {
  fetchImpl?: FetchImpl;
  getConfig?: () => ConnectorConfig;
  /** Override request headers (tests). Defaults to the live request's headers. */
  headers?: Record<string, string | string[] | undefined>;
  /** Entitlement backend (tests/dev). Defaults to a process-local memory store. */
  entitlements?: EntitlementStore;
}

type Ctx = {
  providers: Record<Platform, LeagueProvider>;
  cfg: ConnectorConfig;
  headers: Record<string, string | string[] | undefined>;
  entitlements: EntitlementStore;
};

/** Process-local fallback when the host does not inject an entitlement store. */
const defaultEntitlements = new MemoryEntitlementStore();

function textResult(text: string, structured?: unknown) {
  const base = { content: [{ type: 'text' as const, text }] };
  return structured === undefined ? base : { ...base, structuredContent: structured as Record<string, unknown> };
}

function errorResult(message: string, code: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
    structuredContent: { error: code, message, ...(extra ?? {}) },
  };
}

function providerErrorResult(err: unknown) {
  if (err instanceof ProviderError) {
    return errorResult(`[${err.code}] ${err.message}`, err.code, { status: err.status ?? null });
  }
  return errorResult(`Unexpected error: ${(err as Error).message}`, 'internal_error');
}

async function paymentError(tool: string, ctx: Ctx) {
  const subject = subjectFromHeaders(ctx.headers);
  const gate = await requireTier(ctx.cfg, ctx.entitlements, subject, tool);
  if (gate.ok) return null;
  return gateResult(gate);
}

async function paymentErrorForTier(required: Tier, tool: string, ctx: Ctx) {
  const subject = subjectFromHeaders(ctx.headers);
  const gate = await requireTierFor(ctx.cfg, ctx.entitlements, subject, required, tool);
  if (gate.ok) return null;
  return gateResult(gate);
}

function gateResult(gate: Extract<Awaited<ReturnType<typeof requireTier>>, { ok: false }>) {
  return {
    content: [{ type: 'text' as const, text: paymentRequiredText(gate.payment) }],
    isError: true,
    structuredContent: { ...gate.payment },
  };
}

function inputOf(args: Record<string, unknown>): LeagueInput {
  return {
    platform: args.platform as Platform,
    league_id: args.league_id as string,
    season: args.season as number | undefined,
    week: args.week as number | undefined,
    team_id: args.team_id as string | undefined,
    credential: args.credential as LeagueInput['credential'],
  };
}

function lines(title: string, rows: string[]): string {
  return `${title}\n${rows.map((r) => `- ${r}`).join('\n')}`;
}

function fmtPts(n: number | null): string {
  return n == null ? '—' : n.toFixed(1);
}

export function registerFantasyTools(server: McpServer, deps: ToolDeps = {}): void {
  const cfg = deps.getConfig ? deps.getConfig() : (undefined as never as ConnectorConfig);
  const providers: Record<Platform, LeagueProvider> = {
    sleeper: createSleeperProvider({ fetchImpl: deps.fetchImpl }),
    espn: createEspnProvider({ fetchImpl: deps.fetchImpl }),
    yahoo: createYahooProvider({ fetchImpl: deps.fetchImpl }),
  };
  // Headers are per-request; server.ts stashes them on the McpServer instance
  // before dispatch (see REQUEST_HEADERS). Tests pass them via ToolDeps.
  const ctx = (): Ctx => ({
    providers,
    cfg,
    headers: deps.headers ?? ((server as unknown as { __reqHeaders?: Ctx['headers'] }).__reqHeaders ?? {}),
    entitlements: deps.entitlements ?? defaultEntitlements,
  });

  server.registerTool(
    'connect_league',
    {
      title: 'Connect a fantasy league',
      description:
        'Validate league coordinates and return the canonical connection descriptor (league name, season, team count, current week, whether it is private). ' +
        'Public Sleeper and ESPN leagues need no auth — just the league id. Private ESPN leagues need swid/espn_s2 cookies; Yahoo leagues always need OAuth. ' +
        'Credentials must come from Muse\'s Secure Credentials Store, never typed raw. ' +
        'Free tier. Read-only: this cannot change anything in your league.',
      inputSchema: { ...leagueArgs },
    },
    async (args) => {
      const c = ctx();
      const input = inputOf(args);
      // Private leagues need Pro: any ESPN call with swid/espn_s2, and all
      // Yahoo leagues (Yahoo always requires an OAuth token).
      const needsPro = input.platform === 'yahoo' || hasPrivateCredential(input);
      if (needsPro) {
        const gate = await paymentErrorForTier('pro', 'connect_league', c);
        if (gate) return gate;
      }
      try {
        const info = await c.providers[input.platform].getLeague(input);
        const text =
          `Connected: **${info.name}** (${info.platform}, ${info.season}) — ${info.team_count} teams, ` +
          `week ${info.current_week ?? '?'}, status ${info.status}${info.is_private ? ', PRIVATE' : ''}.\n` +
          `Reuse these coordinates: platform="${info.platform}" league_id="${info.league_id}" season=${info.season}.`;
        return textResult(text, { connection: info });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'list_my_teams',
    {
      title: 'List teams in a league',
      description:
        'List every team in the league (name, record, points). For public leagues this lists all teams — tell Muse which one is yours. ' +
        'Free tier. Read-only.',
      inputSchema: { ...leagueArgs },
    },
    async (args) => {
      const c = ctx();
      try {
        const teams = await c.providers[inputOf(args).platform].getTeams(inputOf(args));
        const text = lines(
          `${teams.length} teams:`,
          teams.map((t) => `**${t.name}** (id ${t.team_id}) — ${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}, ${t.points_for.toFixed(1)} PF`),
        );
        return textResult(text, { teams });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_roster',
    {
      title: 'Get a team roster',
      description:
        'Starters and bench for a team in a given week, with points scored and projected points where the platform provides them. ' +
        'Free tier. Read-only: this cannot set your lineup.',
      inputSchema: {
        ...leagueArgs,
        team_id: z.string().describe('Sleeper: roster_id. ESPN: team id. Yahoo: team key.'),
        week: z.number().int().positive().optional().describe('Week number; defaults to the current week.'),
      },
    },
    async (args) => {
      const c = ctx();
      try {
        const roster = await c.providers[inputOf(args).platform].getRoster(inputOf(args));
        const fmt = (p: PlayerEntry) =>
          `${p.name} (${p.position}${p.nfl_team ? ', ' + p.nfl_team : ''}) [${p.slot}] — ${fmtPts(p.points)} pts` +
          (p.projected_points != null ? ` (proj ${fmtPts(p.projected_points)})` : '') +
          (p.injury_status ? ` — ${p.injury_status}` : '');
        const text =
          `**${roster.team_name}** — week ${roster.week} starters:\n` +
          roster.starters.map((p) => `- ${fmt(p)}`).join('\n') +
          (roster.bench.length ? `\nBench:\n${roster.bench.map((p) => `- ${fmt(p)}`).join('\n')}` : '');
        return textResult(text, { roster });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_matchup',
    {
      title: 'Get weekly matchups',
      description:
        'Every matchup for a week: both teams, points scored, projections where available. Defaults to the current week. ' +
        'Free tier. Read-only.',
      inputSchema: {
        ...leagueArgs,
        week: z.number().int().positive().optional().describe('Week number; defaults to the current week.'),
      },
    },
    async (args) => {
      const c = ctx();
      try {
        const matchups = await c.providers[inputOf(args).platform].getMatchups(inputOf(args));
        if (!matchups.length) return textResult('No matchups found for that week.', { matchups });
        const text = lines(
          `Week ${matchups[0].week} matchups:`,
          matchups.map(
            (m) =>
              `**${m.home.team_name}** (${fmtPts(m.home.points)}) vs **${m.away.team_name}** (${fmtPts(m.away.points)})`,
          ),
        );
        return textResult(text, { matchups });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_standings',
    {
      title: 'Get league standings',
      description: 'Standings sorted by wins then points for, with rank, record, and points. Free tier. Read-only.',
      inputSchema: { ...leagueArgs },
    },
    async (args) => {
      const c = ctx();
      try {
        const rows = await c.providers[inputOf(args).platform].getStandings(inputOf(args));
        const text = lines(
          'Standings:',
          rows.map(
            (t) => `${t.rank}. **${t.name}** — ${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}, ${t.points_for.toFixed(1)} PF`,
          ),
        );
        return textResult(text, { standings: rows });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List recent transactions',
      description:
        'Recent trades, waiver claims, and free-agent adds for a week (defaults to current week). This is how trade alerts work: ' +
        'call it on a schedule and diff against the last check. Free tier. Read-only.',
      inputSchema: {
        ...leagueArgs,
        week: z.number().int().positive().optional().describe('Week number; defaults to the current week.'),
        type: z.enum(['trade', 'waiver', 'free_agent', 'all']).optional().describe('Filter by type; default all.'),
      },
    },
    async (args) => {
      const c = ctx();
      try {
        const all = await c.providers[inputOf(args).platform].getTransactions(inputOf(args));
        const filter = (args.type as string) ?? 'all';
        const txns = filter === 'all' ? all : all.filter((t) => t.type === filter);
        if (!txns.length) return textResult(`No ${filter === 'all' ? '' : filter + ' '}transactions found.`, { transactions: [] });
        const text = lines(
          `Transactions (${txns.length}):`,
          txns.map((t) => `**[${t.type}]** ${t.headline}${t.detail ? ` — ${t.detail}` : ''}`),
        );
        return textResult(text, { transactions: txns });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  const premium = (name: string, tier: Tier, blurb: string) =>
    `Requires the ${tier === 'commissioner' ? 'Commissioner' : 'Pro'} tier — ${blurb}`;

  server.registerTool(
    'analyze_trade',
    {
      title: 'Analyze a trade',
      description: premium(
        'analyze_trade',
        'pro',
        'heuristic trade fairness analysis from rosters and recent scoring. ' +
          'Heuristic only, not projection-model grade. Read-only: it cannot propose or accept trades.',
      ),
      inputSchema: {
        ...leagueArgs,
        my_team_id: z.string().describe('Your team id.'),
        other_team_id: z.string().describe('Trade partner team id.'),
        players_in: z.array(z.string()).describe('Player names (or ids) you would receive.'),
        players_out: z.array(z.string()).describe('Player names (or ids) you would give up.'),
        week: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const c = ctx();
      const gate = await paymentError('analyze_trade', c);
      if (gate) return gate;
      try {
        const p = c.providers[inputOf(args).platform];
        const [mine, theirs] = await Promise.all([
          p.getRoster({ ...inputOf(args), team_id: args.my_team_id as string }),
          p.getRoster({ ...inputOf(args), team_id: args.other_team_id as string }),
        ]);
        const all = [...mine.starters, ...mine.bench, ...theirs.starters, ...theirs.bench];
        const find = (q: string): PlayerEntry | undefined => {
          const needle = q.trim().toLowerCase();
          return all.find(
            (e) => e.name.toLowerCase() === needle || (e.player_id && e.player_id === q.trim()),
          );
        };
        const inPlayers = (args.players_in as string[]).map(find);
        const outPlayers = (args.players_out as string[]).map(find);
        const missing = [...(args.players_in as string[]).filter((_, i) => !inPlayers[i]),
          ...(args.players_out as string[]).filter((_, i) => !outPlayers[i])];
        const score = (list: (PlayerEntry | undefined)[]) =>
          list.reduce((s, e) => s + (e?.points ?? e?.projected_points ?? 0), 0);
        const inScore = score(inPlayers);
        const outScore = score(outPlayers);
        const verdict =
          inScore > outScore * 1.15 ? 'looks in your favor on recent scoring'
          : outScore > inScore * 1.15 ? 'looks against you on recent scoring'
          : 'roughly even on recent scoring';
        const text =
          `Trade analysis (**heuristic** — based on points scored / projections, not a projection model):\n` +
          `You receive: ${inPlayers.map((e, i) => (e ? `${e.name} (${fmtPts(e.points ?? e.projected_points)})` : `?? ${(args.players_in as string[])[i]}`)).join(', ') || '—'}\n` +
          `You give: ${outPlayers.map((e, i) => (e ? `${e.name} (${fmtPts(e.points ?? e.projected_points)})` : `?? ${(args.players_out as string[])[i]}`)).join(', ') || '—'}\n` +
          `Scoring edge: ${inScore.toFixed(1)} vs ${outScore.toFixed(1)} — ${verdict}.` +
          (missing.length ? `\nCould not resolve: ${missing.join(', ')} — check spelling.` : '') +
          `\nThis does not account for schedule, injuries beyond the listed status, or playoff matchups. It cannot propose or accept the trade.`;
        return textResult(text, {
          analysis: {
            players_in: inPlayers.filter(Boolean),
            players_out: outPlayers.filter(Boolean),
            in_score: inScore,
            out_score: outScore,
            verdict,
            heuristic: true,
          },
        });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'waiver_targets',
    {
      title: 'Find waiver targets',
      description: premium(
        'waiver_targets',
        'pro',
        'trending adds and available players by position, ranked by a simple heuristic. ' +
          'Heuristic only. Read-only: it cannot place waiver claims.',
      ),
      inputSchema: {
        ...leagueArgs,
        my_team_id: z.string().optional().describe('Your team id — used to exclude players you already own (Sleeper).'),
        week: z.number().int().positive().optional(),
        position: z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'D/ST']).optional().describe('Filter by position.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max targets; default 10.'),
      },
    },
    async (args) => {
      const c = ctx();
      const gate = await paymentError('waiver_targets', c);
      if (gate) return gate;
      try {
        const platform = inputOf(args).platform;
        const limit = (args.limit as number) ?? 10;
        const pos = args.position as string | undefined;
        if (platform === 'sleeper') {
          const trending = await sleeperTrendingAdds(deps.fetchImpl);
          const mine = await c.providers.sleeper
            .getRoster({ ...inputOf(args), team_id: (args.my_team_id as string | undefined) ?? '' })
            .catch(() => null);
          const owned = new Set(
            [...(mine?.starters ?? []), ...(mine?.bench ?? [])].map((p) => p.player_id).filter(Boolean),
          );
          const targets = trending
            .filter((t) => !owned.has(t.player_id))
            .filter((t) => !pos || t.position === pos)
            .slice(0, limit);
          const text = lines(
            `Waiver targets (Sleeper trending adds, last 24h${pos ? `, ${pos}` : ''}):`,
            targets.map((t, i) => `${i + 1}. **${t.name}** (${t.position}, ${t.nfl_team ?? 'FA'}) — ${t.trend_count} adds`),
          );
          return textResult(text, { targets, heuristic: true });
        }
        if (platform === 'espn') {
          // Public ESPN has no free-agent listing endpoint; use this week's
          // waiver/free-agent transactions as the observable proxy.
          const txns = await c.providers.espn.getTransactions(inputOf(args));
          const adds = txns.filter((t) => t.type === 'waiver' || t.type === 'free_agent').slice(0, limit);
          const text =
            `Waiver targets (ESPN public leagues expose no free-agent list, so this ranks this week's most-added players from transaction activity):\n` +
            (adds.length
              ? adds.map((t, i) => `${i + 1}. ${t.headline}${t.detail ? ` — ${t.detail}` : ''}`).join('\n')
              : 'No waiver/free-agent activity this week.') +
            `\nHeuristic only.`;
          return textResult(text, { targets: adds, heuristic: true, note: 'proxy-from-transactions' });
        }
        return errorResult(
          'waiver_targets for Yahoo needs a private league connection (Pro tier includes private leagues).',
          'auth_required',
        );
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'start_sit_advice',
    {
      title: 'Start/sit advice',
      description: premium(
        'start_sit_advice',
        'pro',
        'lineup suggestions from projections and recent scoring. ' +
          'Heuristic only, not a guarantee. Read-only: it cannot set your lineup.',
      ),
      inputSchema: {
        ...leagueArgs,
        team_id: z.string(),
        week: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      const c = ctx();
      const gate = await paymentError('start_sit_advice', c);
      if (gate) return gate;
      try {
        const roster = await c.providers[inputOf(args).platform].getRoster(inputOf(args));
        const scoreOf = (p: PlayerEntry) => p.projected_points ?? p.points ?? 0;
        const byPos = new Map<string, PlayerEntry[]>();
        for (const p of [...roster.starters, ...roster.bench]) {
          const arr = byPos.get(p.position) ?? [];
          arr.push(p);
          byPos.set(p.position, arr);
        }
        const suggestions: string[] = [];
        for (const [pos, group] of byPos) {
          const sorted = [...group].sort((a, b) => scoreOf(b) - scoreOf(a));
          const starters = roster.starters.filter((p) => p.position === pos);
          for (const s of starters) {
            const better = sorted.find((p) => !p.is_starter && scoreOf(p) > scoreOf(s) * 1.1);
            if (better) {
              suggestions.push(
                `Consider starting **${better.name}** (${fmtPts(scoreOf(better))} proj) over **${s.name}** (${fmtPts(scoreOf(s))} proj) at ${pos}.`,
              );
            }
          }
          void sorted;
        }
        const text =
          `Start/sit for **${roster.team_name}**, week ${roster.week} (**heuristic** — projections where available, else recent scoring; not a guarantee):\n` +
          (suggestions.length ? suggestions.map((s) => `- ${s}`).join('\n')
            : '- Your current starters already grade out best by the available numbers. No changes suggested.') +
          `\nThis cannot set your lineup — make the change in your league app.`;
        return textResult(text, { suggestions, heuristic: true, roster_week: roster.week });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );

  server.registerTool(
    'weekly_recap',
    {
      title: 'Weekly league recap',
      description: premium(
        'weekly_recap',
        'commissioner',
        'commissioner-style week in review: biggest blowout, closest game, top scorer, transaction highlights, power ranking. ' +
          'Built for the "runs your league for you" tier.',
      ),
      inputSchema: {
        ...leagueArgs,
        week: z.number().int().positive().optional().describe('Week number; defaults to the current week.'),
      },
    },
    async (args) => {
      const c = ctx();
      const gate = await paymentError('weekly_recap', c);
      if (gate) return gate;
      try {
        const p = c.providers[inputOf(args).platform];
        const week = inputOf(args).week;
        const [matchups, standings, txns] = await Promise.all([
          p.getMatchups({ ...inputOf(args), week }),
          p.getStandings(inputOf(args)),
          p.getTransactions({ ...inputOf(args), week }),
        ]);
        if (!matchups.length) return textResult('No matchups found for that week.', { week });
        const w = matchups[0].week;
        const withScores = matchups.filter((m) => m.home.points != null && m.away.points != null);
        const diff = (m: (typeof matchups)[number]) => Math.abs((m.home.points ?? 0) - (m.away.points ?? 0));
        const blowout = withScores.length ? [...withScores].sort((a, b) => diff(b) - diff(a))[0] : null;
        const nailbiter = withScores.length ? [...withScores].sort((a, b) => diff(a) - diff(b))[0] : null;
        const allSides = matchups.flatMap((m) => [m.home, m.away]).filter((s) => s.points != null);
        const top = allSides.length ? [...allSides].sort((a, b) => (b.points ?? 0) - (a.points ?? 0))[0] : null;
        const trades = txns.filter((t) => t.type === 'trade');
        const winnerOf = (m: (typeof matchups)[number]) =>
          (m.home.points ?? -1) >= (m.away.points ?? -1) ? m.home.team_name : m.away.team_name;
        const text =
          `**Week ${w} recap**\n` +
          (top ? `- Top scorer: **${top.team_name}** (${fmtPts(top.points)})\n` : '') +
          (blowout ? `- Biggest blowout: **${winnerOf(blowout)}** won by ${diff(blowout).toFixed(1)}\n` : '') +
          (nailbiter && nailbiter !== blowout ? `- Closest game: **${nailbiter.home.team_name}** vs **${nailbiter.away.team_name}** (decided by ${diff(nailbiter).toFixed(1)})\n` : '') +
          (trades.length ? `- Trades: ${trades.map((t) => t.headline).join('; ')}\n` : `- No trades this week.\n`) +
          `- Power ranking (by record, then points):\n` +
          standings.slice(0, 5).map((t, i) => `  ${i + 1}. ${t.name} (${t.wins}-${t.losses})`).join('\n');
        return textResult(text, {
          recap: { week: w, top_scorer: top, blowout, nailbiter, trades: trades.length, power_ranking: standings.map((t) => t.team_id) },
        });
      } catch (err) {
        return providerErrorResult(err);
      }
    },
  );
}
