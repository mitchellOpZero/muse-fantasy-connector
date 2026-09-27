/**
 * Sleeper provider — fully public, no auth. https://api.sleeper.app
 *
 * Endpoints used:
 *   GET /v1/state/nfl
 *   GET /v1/league/{id}
 *   GET /v1/league/{id}/users
 *   GET /v1/league/{id}/rosters
 *   GET /v1/league/{id}/matchups/{week}
 *   GET /v1/league/{id}/transactions/{round}/{week}   (round 1 = regular season)
 *   GET /v1/players/nfl/trending/add?limit=25&lookback_hours=24
 *   GET /v1/players/nfl   (lazy, cached; ~10MB player map for name resolution)
 */
import { fetchJson, type FetchImpl } from './http.js';
import {
  ProviderError,
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

const BASE = 'https://api.sleeper.app/v1';

interface SleeperState { week: number; display_week: number; season: string; season_type: string }
interface SleeperLeague { name: string; season: string; total_rosters: number; status: string }
interface SleeperUser { user_id: string; display_name: string }
interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  starters: string[];
  players: string[] | null;
  settings: { wins: number; losses: number; ties: number; fpts: number; fpts_decimal?: number };
  metadata?: { team_name?: string } | null;
}
interface SleeperMatchup {
  matchup_id: number;
  roster_id: number;
  starters: string[];
  players: string[] | null;
  points: number | null;
  players_points?: Record<string, number>;
}
interface SleeperTxn {
  transaction_id: string;
  type: 'trade' | 'waiver' | 'free_agent';
  week: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: Array<{ season: string; round: number; roster_id: number; previous_owner_id: number; owner_id: number }>;
  created: number;
  status: string;
}
interface SleeperPlayer { full_name?: string; position?: string; team?: string; injury_status?: string }

export interface SleeperDeps {
  fetchImpl?: FetchImpl;
}

export function createSleeperProvider(deps: SleeperDeps = {}): LeagueProvider {
  const f: FetchImpl = deps.fetchImpl ?? fetch;
  // Lazy player-name map. Big (~10MB) — fetched once, cached in memory.
  let playersPromise: Promise<Record<string, SleeperPlayer>> | null = null;
  const players = (): Promise<Record<string, SleeperPlayer>> => {
    if (!playersPromise) playersPromise = fetchJson<Record<string, SleeperPlayer>>(`${BASE}/players/nfl`, f);
    return playersPromise;
  };
  const nameOf = async (playerId: string): Promise<SleeperPlayer> => {
    try {
      const map = await players();
      return map[playerId] ?? {};
    } catch {
      return {};
    }
  };

  const get = <T>(path: string): Promise<T> => fetchJson<T>(`${BASE}${path}`, f);

  function checkId(input: LeagueInput): string {
    if (!/^\d{4,}$/.test(input.league_id)) {
      throw new ProviderError('invalid_league_id', 'Sleeper league id must be numeric (e.g. "1048912804323000320").');
    }
    return input.league_id;
  }

  async function state(): Promise<SleeperState> {
    return get<SleeperState>('/state/nfl');
  }

  async function rosters(input: LeagueInput): Promise<{ list: SleeperRoster[]; users: Map<string, SleeperUser> }> {
    const id = checkId(input);
    const [list, users] = await Promise.all([
      get<SleeperRoster[]>(`/league/${id}/rosters`),
      get<SleeperUser[]>(`/league/${id}/users`),
    ]);
    return { list, users: new Map(users.map((u) => [u.user_id, u])) };
  }

  function teamName(r: SleeperRoster, users: Map<string, SleeperUser>): string {
    const meta = r.metadata?.team_name?.trim();
    if (meta) return meta;
    const owner = r.owner_id ? users.get(r.owner_id) : undefined;
    if (owner?.display_name) return owner.display_name;
    return `Team ${r.roster_id}`;
  }

  function teamSummary(r: SleeperRoster, users: Map<string, SleeperUser>): TeamSummary {
    const s = r.settings;
    const points = s.fpts + (s.fpts_decimal ?? 0) / 100;
    return {
      team_id: String(r.roster_id),
      name: teamName(r, users),
      owners: r.owner_id && users.get(r.owner_id)?.display_name ? [users.get(r.owner_id)!.display_name] : [],
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
      points_for: Math.round(points * 100) / 100,
      points_against: null,
    };
  }

  return {
    platform: 'sleeper',

    async getLeague(input: LeagueInput): Promise<LeagueInfo> {
      const id = checkId(input);
      const [league, st] = await Promise.all([get<SleeperLeague>(`/league/${id}`), state().catch(() => null)]);
      return {
        platform: 'sleeper',
        league_id: id,
        season: Number(league.season),
        name: league.name,
        team_count: league.total_rosters,
        current_week: st?.week ?? null,
        status: league.status,
        is_private: false,
      };
    },

    async getTeams(input: LeagueInput): Promise<TeamSummary[]> {
      const { list, users } = await rosters(input);
      return list.map((r) => teamSummary(r, users));
    },

    async getRoster(input: LeagueInput): Promise<Roster> {
      if (!input.team_id) throw new ProviderError('invalid_league_id', 'get_roster needs team_id (Sleeper roster_id).');
      const st = await state().catch(() => null);
      const week = input.week ?? st?.display_week ?? st?.week ?? 1;
      const { list, users } = await rosters(input);
      const r = list.find((x) => String(x.roster_id) === input.team_id);
      if (!r) throw new ProviderError('not_found', `No Sleeper roster ${input.team_id} in league ${input.league_id}.`);
      const matchups = await get<SleeperMatchup[]>(`/league/${checkId(input)}/matchups/${week}`).catch(() => []);
      const mine = matchups.find((m) => m.roster_id === r.roster_id);
      const pointsByPlayer = new Map<string, number>();
      if (mine?.players_points) {
        for (const [pid, pts] of Object.entries(mine.players_points)) pointsByPlayer.set(pid, pts);
      }
      const starterSet = new Set(r.starters);
      const allIds = [...new Set([...(r.players ?? []), ...r.starters])];
      const entries: PlayerEntry[] = [];
      for (const pid of allIds) {
        const p = await nameOf(pid);
        entries.push({
          player_id: pid,
          name: p.full_name ?? `Player ${pid}`,
          position: p.position ?? '?',
          nfl_team: p.team ?? null,
          slot: starterSet.has(pid) ? 'starter' : 'bench',
          is_starter: starterSet.has(pid),
          points: pointsByPlayer.get(pid) ?? null,
          projected_points: null,
          injury_status: p.injury_status ?? null,
        });
      }
      return {
        team_id: String(r.roster_id),
        team_name: teamName(r, users),
        week,
        starters: entries.filter((e) => e.is_starter),
        bench: entries.filter((e) => !e.is_starter),
      };
    },

    async getMatchups(input: LeagueInput): Promise<Matchup[]> {
      const id = checkId(input);
      const st = await state().catch(() => null);
      const week = input.week ?? st?.display_week ?? st?.week ?? 1;
      const { list, users } = await rosters(input);
      const names = new Map(list.map((r) => [r.roster_id, teamName(r, users)]));
      const rows = await get<SleeperMatchup[]>(`/league/${id}/matchups/${week}`);
      const byMatchup = new Map<number, SleeperMatchup[]>();
      for (const row of rows) {
        const arr = byMatchup.get(row.matchup_id) ?? [];
        arr.push(row);
        byMatchup.set(row.matchup_id, arr);
      }
      const out: Matchup[] = [];
      for (const [mid, sides] of byMatchup) {
        if (sides.length !== 2) continue;
        const [a, b] = sides;
        out.push({
          matchup_id: String(mid),
          week,
          home: { team_id: String(a.roster_id), team_name: names.get(a.roster_id) ?? `Team ${a.roster_id}`, points: a.points, projected_points: null },
          away: { team_id: String(b.roster_id), team_name: names.get(b.roster_id) ?? `Team ${b.roster_id}`, points: b.points, projected_points: null },
        });
      }
      return out;
    },

    async getStandings(input: LeagueInput): Promise<StandingRow[]> {
      const { list, users } = await rosters(input);
      const rows = list.map((r) => teamSummary(r, users));
      rows.sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
      return rows.map((t, i) => ({ ...t, rank: i + 1 }));
    },

    async getTransactions(input: LeagueInput): Promise<Transaction[]> {
      const id = checkId(input);
      const st = await state().catch(() => null);
      const week = input.week ?? st?.display_week ?? st?.week ?? 1;
      const txns = await get<SleeperTxn[]>(`/league/${id}/transactions/1/${week}`);
      const pmap = await players().catch(() => ({} as Record<string, SleeperPlayer>));
      const pname = (pid: string) => pmap[pid]?.full_name ?? `Player ${pid}`;
      return txns
        .filter((t) => t.status === 'complete')
        .map((t) => {
          const adds = Object.keys(t.adds ?? {}).map(pname);
          const drops = Object.keys(t.drops ?? {}).map(pname);
          const picks = (t.draft_picks ?? []).map((p) => `${p.season} R${p.round}`).join(', ');
          let headline = '';
          let detail = '';
          if (t.type === 'trade') {
            headline = `Trade involving ${t.roster_ids.length} teams`;
            const parts: string[] = [];
            if (adds.length) parts.push(`added: ${adds.join(', ')}`);
            if (drops.length) parts.push(`dropped: ${drops.join(', ')}`);
            if (picks) parts.push(`picks: ${picks}`);
            detail = parts.join(' | ');
          } else if (t.type === 'waiver') {
            headline = `Waiver claim: ${adds.join(', ') || '—'}`;
            detail = drops.length ? `dropped: ${drops.join(', ')}` : '';
          } else {
            headline = `Free agent add: ${adds.join(', ') || '—'}`;
            detail = drops.length ? `dropped: ${drops.join(', ')}` : '';
          }
          return {
            id: t.transaction_id,
            week: t.week,
            type: t.type,
            headline,
            detail,
            timestamp: t.created ? new Date(t.created * 1000).toISOString() : null,
          };
        });
    },
  };
}

/** Trending waiver adds (last 24h) with names resolved. Used by waiver_targets. */
export async function sleeperTrendingAdds(
  fetchImpl: FetchImpl = fetch,
  limit = 25,
): Promise<Array<{ player_id: string; name: string; position: string; nfl_team: string | null; trend_count: number }>> {
  const trending = await fetchJson<Array<{ player_id: string; count: number }>>(
    `${BASE}/players/nfl/trending/add?limit=${limit}&lookback_hours=24`,
    fetchImpl,
  );
  const map = await fetchJson<Record<string, SleeperPlayer>>(`${BASE}/players/nfl`, fetchImpl).catch(
    () => ({} as Record<string, SleeperPlayer>),
  );
  return trending.map((t) => {
    const p = map[t.player_id] ?? {};
    return {
      player_id: t.player_id,
      name: p.full_name ?? `Player ${t.player_id}`,
      position: p.position ?? '?',
      nfl_team: p.team ?? null,
      trend_count: t.count,
    };
  });
}
