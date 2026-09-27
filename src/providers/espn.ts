/**
 * ESPN provider — public leagues need no auth; private leagues need the
 * `swid` + `espn_s2` cookies, supplied per call from Muse's Secure
 * Credentials Store (never typed in chat, never stored server-side).
 *
 * Base: https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl
 *   league:   /seasons/{season}/segments/0/leagues/{id}?view=mSettings&view=mTeam&view=mStandings
 *   matchups: &view=mMatchupScore&scoringPeriodId={week}
 *   boxscore: ?view=mBoxscore&view=mRoster&scoringPeriodId={week}
 *   txns:     ?view=mTransactions
 */
import { fetchJson, type FetchImpl } from './http.js';
import {
  ProviderError,
  hasPrivateCredential,
  type CredentialBundle,
  type LeagueInfo,
  type LeagueInput,
  type LeagueProvider,
  type Matchup,
  type PlayerEntry,
  type Roster,
  type StandingRow,
  type TeamSummary,
  type Transaction,
} from './types.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const MAX_POSTGRES_BIGINT = BigInt('9223372036854775807');

interface EspnTeam {
  id: number;
  location?: string;
  nickname?: string;
  abbrev?: string;
  owners?: string[];
  logo?: string;
  record?: { overall?: { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number } };
  roster?: { entries?: EspnRosterEntry[] };
}
interface EspnRosterEntry {
  lineupSlotId: number;
  playerPoolEntry?: {
    appliedStatTotal?: number;
    player?: {
      id: number;
      fullName?: string;
      defaultPositionId?: number;
      proTeamId?: number;
      injuryStatus?: string;
      stats?: Array<{ seasonId: number; scoringPeriodId: number; statSourceId: number; appliedTotal?: number }>;
    };
  };
}
interface EspnGame {
  id: number;
  matchupPeriodId: number;
  home?: { teamId: number; totalPoints?: number };
  away?: { teamId: number; totalPoints?: number };
}
interface EspnLeague {
  id: number;
  seasonId: number;
  name?: string;
  status?: { currentMatchupPeriod?: number; isActive?: boolean };
  settings?: { name?: string };
  teams?: EspnTeam[];
  schedule?: EspnGame[];
  transactions?: EspnTxn[];
}
interface EspnTxn {
  id?: string;
  type?: string;
  scoringPeriodId?: number;
  proposedDate?: number;
  executionType?: string;
  items?: Array<{ playerId?: number; type?: string; fromTeamId?: number; toTeamId?: number }>;
}

const POSITION_IDS: Record<number, string> = {
  1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST',
};
// ESPN lineupSlotId: 0 QB, 2 RB, 4 WR, 6 TE, 16 DST, 17 K, 20 Bench, 21 IR, 23 Flex
const SLOT_IDS: Record<number, string> = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K',
  20: 'Bench', 21: 'IR', 23: 'Flex', 8: 'Bench', 7: 'Bench',
};
const PRO_TEAMS: Record<number, string> = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};

export interface EspnDeps {
  fetchImpl?: FetchImpl;
}

export function checkEspnLeagueId(value: string): string {
  if (!/^\d+$/.test(value)) throw new ProviderError('invalid_league_id', 'ESPN league id must be numeric.');
  const n = BigInt(value);
  if (n <= BigInt(0) || n > MAX_POSTGRES_BIGINT) {
    throw new ProviderError('invalid_league_id', 'ESPN league id is out of range.');
  }
  return n.toString();
}

export function createEspnProvider(deps: EspnDeps = {}): LeagueProvider {
  const f: FetchImpl = deps.fetchImpl ?? fetch;

  function cookieHeader(cred: CredentialBundle | undefined): Record<string, string> {
    if (cred?.espn_swid && cred?.espn_s2) {
      return { cookie: `swid=${cred.espn_swid}; espn_s2=${cred.espn_s2}` };
    }
    return {};
  }

  async function getLeaguePayload(input: LeagueInput, views: string, extra = ''): Promise<EspnLeague> {
    const id = checkEspnLeagueId(input.league_id);
    const season = input.season ?? new Date().getUTCFullYear();
    const url =
      season < 2018
        ? `${BASE}/leagueHistory/${id}?seasonId=${season}&${views}${extra}`
        : `${BASE}/seasons/${season}/segments/0/leagues/${id}?${views}${extra}`;
    const payload = await fetchJson<unknown>(url, f, { headers: cookieHeader(input.credential) });
    const league = (Array.isArray(payload) && payload.length === 1 ? payload[0] : payload) as EspnLeague;
    if (!league || typeof league !== 'object' || league.id !== Number(id) || league.seasonId !== season) {
      throw new ProviderError('not_found', `ESPN league ${id} not found for season ${season}.`);
    }
    return league;
  }

  function teamName(t: EspnTeam): string {
    const full = `${t.location ?? ''} ${t.nickname ?? ''}`.trim();
    return full || t.abbrev || `Team ${t.id}`;
  }

  function summarize(t: EspnTeam): TeamSummary {
    const o = t.record?.overall;
    return {
      team_id: String(t.id),
      name: teamName(t),
      abbreviation: t.abbrev ?? null,
      owners: t.owners ?? [],
      wins: o?.wins ?? 0,
      losses: o?.losses ?? 0,
      ties: o?.ties ?? 0,
      points_for: o?.pointsFor ?? 0,
      points_against: o?.pointsAgainst ?? null,
    };
  }

  /** Projected points for a scoring period: statSourceId 1 = projected. */
  function projectedFor(entry: EspnRosterEntry, season: number, week: number): number | null {
    const stats = entry.playerPoolEntry?.player?.stats ?? [];
    const row = stats.find(
      (s) => s.seasonId === season && s.scoringPeriodId === week && s.statSourceId === 1,
    );
    return typeof row?.appliedTotal === 'number' ? Math.round(row.appliedTotal * 100) / 100 : null;
  }

  function toPlayerEntry(e: EspnRosterEntry, season: number, week: number): PlayerEntry {
    const p = e.playerPoolEntry?.player;
    const slot = SLOT_IDS[e.lineupSlotId] ?? `slot-${e.lineupSlotId}`;
    const isStarter = e.lineupSlotId !== 20 && e.lineupSlotId !== 21 && slot !== 'Bench';
    return {
      player_id: p?.id != null ? String(p.id) : null,
      name: p?.fullName ?? 'Unknown player',
      position: p?.defaultPositionId != null ? (POSITION_IDS[p.defaultPositionId] ?? '?') : '?',
      nfl_team: p?.proTeamId != null ? (PRO_TEAMS[p.proTeamId] ?? null) : null,
      slot,
      is_starter: isStarter,
      points:
        typeof e.playerPoolEntry?.appliedStatTotal === 'number'
          ? Math.round(e.playerPoolEntry.appliedStatTotal * 100) / 100
          : null,
      projected_points: projectedFor(e, season, week),
      injury_status: p?.injuryStatus ?? null,
    };
  }

  return {
    platform: 'espn',

    async getLeague(input: LeagueInput): Promise<LeagueInfo> {
      const league = await getLeaguePayload(input, 'view=mSettings&view=mTeam');
      const season = input.season ?? new Date().getUTCFullYear();
      return {
        platform: 'espn',
        league_id: checkEspnLeagueId(input.league_id),
        season,
        name: league.settings?.name ?? league.name ?? `ESPN league ${input.league_id}`,
        team_count: league.teams?.length ?? 0,
        current_week: league.status?.currentMatchupPeriod ?? null,
        status: league.status?.isActive ? 'in-season' : 'offseason',
        is_private: hasPrivateCredential(input),
      };
    },

    async getTeams(input: LeagueInput): Promise<TeamSummary[]> {
      const league = await getLeaguePayload(input, 'view=mTeam');
      return (league.teams ?? []).map(summarize);
    },

    async getRoster(input: LeagueInput): Promise<Roster> {
      if (!input.team_id) throw new ProviderError('invalid_league_id', 'get_roster needs team_id (ESPN team id).');
      const season = input.season ?? new Date().getUTCFullYear();
      const meta = await getLeaguePayload(input, 'view=mSettings');
      const week = input.week ?? meta.status?.currentMatchupPeriod ?? 1;
      // Roster with per-week scoring needs the boxscore view.
      const box = await getLeaguePayload(input, `view=mBoxscore&view=mRoster&view=mTeam&scoringPeriodId=${week}`);
      const team = (box.teams ?? []).find((t) => String(t.id) === input.team_id);
      if (!team) throw new ProviderError('not_found', `No ESPN team ${input.team_id} in league ${input.league_id}.`);
      const entries = (team.roster?.entries ?? []).map((e) => toPlayerEntry(e, season, week));
      return {
        team_id: String(team.id),
        team_name: teamName(team),
        week,
        starters: entries.filter((e) => e.is_starter),
        bench: entries.filter((e) => !e.is_starter),
      };
    },

    async getMatchups(input: LeagueInput): Promise<Matchup[]> {
      const league = await getLeaguePayload(input, 'view=mTeam&view=mSettings');
      const week = input.week ?? league.status?.currentMatchupPeriod ?? 1;
      const withScores = await getLeaguePayload(
        input,
        `view=mMatchupScore&view=mTeam&scoringPeriodId=${week}`,
      );
      const names = new Map((withScores.teams ?? []).map((t) => [t.id, teamName(t)]));
      const games = (withScores.schedule ?? []).filter((g) => g.matchupPeriodId === week);
      return games.map((g) => {
        const homeId = g.home?.teamId ?? -1;
        const awayId = g.away?.teamId ?? -1;
        return {
          matchup_id: String(g.id),
          week,
          home: {
            team_id: String(homeId),
            team_name: names.get(homeId) ?? `Team ${homeId}`,
            points: g.home?.totalPoints ?? null,
            projected_points: null,
          },
          away: {
            team_id: String(awayId),
            team_name: names.get(awayId) ?? `Team ${awayId}`,
            points: g.away?.totalPoints ?? null,
            projected_points: null,
          },
        };
      });
    },

    async getStandings(input: LeagueInput): Promise<StandingRow[]> {
      const league = await getLeaguePayload(input, 'view=mTeam&view=mStandings');
      const rows = (league.teams ?? []).map(summarize);
      rows.sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
      return rows.map((t, i) => ({ ...t, rank: i + 1 }));
    },

    async getTransactions(input: LeagueInput): Promise<Transaction[]> {
      const league = await getLeaguePayload(input, 'view=mTeam&view=mSettings');
      const week = input.week ?? league.status?.currentMatchupPeriod ?? 1;
      const payload = await getLeaguePayload(input, `view=mTransactions&view=mTeam&scoringPeriodId=${week}`);
      const names = new Map((payload.teams ?? []).map((t) => [t.id, teamName(t)]));
      const txns = payload.transactions ?? [];
      return txns.slice(0, 50).map((t, i) => {
        const kind = (t.type ?? '').toUpperCase();
        const type = kind.includes('TRADE') ? 'trade' : kind.includes('WAIVER') ? 'waiver' : kind.includes('FREE') ? 'free_agent' : 'other';
        const items = (t.items ?? [])
          .map((it) => {
            const team = it.toTeamId != null ? names.get(it.toTeamId) ?? `team ${it.toTeamId}` : 'free agency';
            return `player ${it.playerId ?? '?'} → ${team}`;
          })
          .join('; ');
        return {
          id: t.id ?? `espn-txn-${i}`,
          week: t.scoringPeriodId ?? week,
          type,
          headline: `${type.replace('_', ' ')} (${t.executionType ?? 'executed'})`,
          detail: items,
          timestamp: t.proposedDate ? new Date(t.proposedDate).toISOString() : null,
        };
      });
    },
  };
}
