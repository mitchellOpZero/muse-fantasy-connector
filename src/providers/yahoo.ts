/**
 * Yahoo provider — private leagues only, OAuth2 with PKCE.
 *
 * Yahoo's Fantasy API requires a registered app (https://sports.yahoo.com/developer/,
 * request the Fantasy API with read-only `fspt-r` scope). The OAuth dance lives
 * on plain HTTP routes (see server.ts):
 *   GET  /v1/yahoo/authorize  -> { authorization_url } (or setup_required)
 *   POST /v1/yahoo/callback   -> exchanges code for tokens (server-side only)
 *
 * Tools take `credential.yahoo_access_token` (from Muse's Secure Credentials
 * Store). Tokens are never stored server-side, never logged, never echoed.
 *
 * Fantasy API: https://fantasysports.yahooapis.com/fantasy/v2/...
 * League key format: `nfl.l.12345` (game code `nfl`, `.l.`, numeric league id).
 */
import { createHash, randomBytes } from 'node:crypto';
import { fetchJson, type FetchImpl } from './http.js';
import {
  ProviderError,
  type LeagueInfo,
  type LeagueInput,
  type LeagueProvider,
  type Matchup,
  type Roster,
  type StandingRow,
  type TeamSummary,
  type Transaction,
} from './types.js';

const AUTH_BASE = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const FANTASY_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

export interface YahooAppConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export interface YahooDeps {
  fetchImpl?: FetchImpl;
  app?: YahooAppConfig;
}

/** league_key must look like `nfl.l.12345`. */
export function checkYahooLeagueKey(value: string): string {
  if (!/^[a-z]+\.l\.\d+$/.test(value)) {
    throw new ProviderError(
      'invalid_league_id',
      'Yahoo league id must be a league key like "nfl.l.12345" (find it in your Yahoo Fantasy league URL).',
    );
  }
  return value;
}

/** PKCE helpers for the authorize/callback HTTP routes. */
export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function yahooAuthorizeUrl(app: YahooAppConfig, verifier: string): string {
  if (!app.clientId || !app.redirectUri) {
    throw new ProviderError(
      'not_configured',
      'Yahoo OAuth is not configured on this connector (YAHOO_CLIENT_ID / YAHOO_REDIRECT_URI). ' +
        'The connector owner must register a Yahoo app first — see INSTALL.md.',
    );
  }
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: 'fspt-r',
    code_challenge: codeChallengeS256(verifier),
    code_challenge_method: 'S256',
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

export async function yahooExchangeCode(
  app: YahooAppConfig,
  code: string,
  verifier: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  if (!app.clientId || !app.clientSecret || !app.redirectUri) {
    throw new ProviderError('not_configured', 'Yahoo OAuth is not configured on this connector.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: app.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64'),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new ProviderError('auth_required', `Yahoo token exchange failed (${res.status}).`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
}

/** Yahoo's JSON nests everything in single-key objects inside arrays; unwrap defensively. */
function y(obj: unknown): Record<string, unknown> | null {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
}
function yarr(obj: unknown): unknown[] {
  return Array.isArray(obj) ? obj : [];
}
function first<T>(arr: unknown[], key: string): T | undefined {
  for (const item of arr) {
    const o = y(item);
    if (o && key in o) return o[key] as T;
  }
  return undefined;
}

export function createYahooProvider(deps: YahooDeps = {}): LeagueProvider {
  const f: FetchImpl = deps.fetchImpl ?? fetch;

  function authed(cred: LeagueInput['credential']): Record<string, string> {
    const token = cred?.yahoo_access_token;
    if (!token) {
      throw new ProviderError(
        'auth_required',
        'Yahoo leagues are private: pass credential.yahoo_access_token from the Secure Credentials Store. ' +
          'Complete the Yahoo OAuth flow first (see INSTALL.md).',
      );
    }
    return { authorization: `Bearer ${token}` };
  }

  async function api<T>(path: string, input: LeagueInput): Promise<T> {
    const key = checkYahooLeagueKey(input.league_id);
    return fetchJson<T>(`${FANTASY_BASE}/${path.replace('{key}', key)};format=json`, f, {
      headers: authed(input.credential),
    });
  }

  function leagueNode(doc: unknown): Record<string, unknown> | null {
    const fc = y(y(doc)?.['fantasy_content']);
    const leagueArr = yarr(fc?.['league']);
    return first<Record<string, unknown>>(leagueArr, 'league') ?? y(leagueArr[0]) ?? null;
  }

  function teamsOf(doc: unknown): Array<Record<string, unknown>> {
    const league = leagueNode(doc);
    const teamsArr = yarr(y(league?.['teams'])?.['team']);
    const out: Array<Record<string, unknown>> = [];
    for (const item of teamsArr) {
      const t = first<Record<string, unknown>>(yarr(item), 'team');
      if (t) out.push(t);
    }
    return out;
  }

  function teamSummary(t: Record<string, unknown>): TeamSummary {
    const teamId = first<string>(yarr(t['team_id']), 'team_id') ?? String(t['team_id'] ?? '');
    const name = first<string>(yarr(t['name']), 'name') ?? (t['name'] as string) ?? `Team ${teamId}`;
    const rec = first<Record<string, unknown>>(yarr(t['team_standings']), 'team_standings')
      ?? first<Record<string, unknown>>(yarr(t['standings']), 'standings');
    const outcome = first<Record<string, unknown>>(yarr(rec?.['outcome_totals']), 'outcome_totals');
    const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);
    return {
      team_id: String(teamId),
      name,
      abbreviation: null,
      owners: [],
      wins: num(first<string>(yarr(outcome?.['wins']), 'wins') ?? outcome?.['wins']),
      losses: num(first<string>(yarr(outcome?.['losses']), 'losses') ?? outcome?.['losses']),
      ties: num(first<string>(yarr(outcome?.['ties']), 'ties') ?? outcome?.['ties']),
      points_for: Number(first<string>(yarr(t['points_for']), 'points_for') ?? 0) || 0,
      points_against: null,
    };
  }

  return {
    platform: 'yahoo',

    async getLeague(input: LeagueInput): Promise<LeagueInfo> {
      const doc = await api<unknown>('league/{key}', input);
      const league = leagueNode(doc);
      const name = first<string>(yarr(league?.['name']), 'name') ?? (league?.['name'] as string) ?? input.league_id;
      const season = Number(first<string>(yarr(league?.['season']), 'season') ?? league?.['season'] ?? new Date().getUTCFullYear());
      const numTeams = Number(first<string>(yarr(league?.['num_teams']), 'num_teams') ?? league?.['num_teams'] ?? 0);
      const week = Number(first<string>(yarr(league?.['current_week']), 'current_week') ?? league?.['current_week'] ?? NaN);
      return {
        platform: 'yahoo',
        league_id: checkYahooLeagueKey(input.league_id),
        season,
        name,
        team_count: numTeams,
        current_week: Number.isFinite(week) ? week : null,
        status: 'in-season',
        is_private: true,
      };
    },

    async getTeams(input: LeagueInput): Promise<TeamSummary[]> {
      const doc = await api<unknown>('league/{key}/teams', input);
      return teamsOf(doc).map(teamSummary);
    },

    async getRoster(input: LeagueInput): Promise<Roster> {
      if (!input.team_id) throw new ProviderError('invalid_league_id', 'get_roster needs team_id (Yahoo team key).');
      const week = input.week;
      const doc = await api<unknown>(
        week ? `team/${input.team_id}/roster;week=${week}` : `team/${input.team_id}/roster`,
        input,
      );
      const fc = y(y(doc)?.['fantasy_content']);
      const teamArr = yarr(fc?.['team']);
      const team = first<Record<string, unknown>>(teamArr, 'team') ?? y(teamArr[0]);
      const rosterArr = yarr(y(team?.['roster'])?.['0']);
      const rosterNode = y(rosterArr.find((x) => y(x)?.['roster'])) ?? y(team?.['roster']);
      const players = yarr(rosterNode?.['players']);
      const starters: Roster['starters'] = [];
      const bench: Roster['bench'] = [];
      for (const item of players) {
        const p = first<Record<string, unknown>>(yarr(item), 'player') ?? y(item);
        if (!p) continue;
        const name = first<string>(yarr(p['name']), 'full') ?? (y(p['name'])?.['full'] as string) ?? 'Unknown';
        const pos = first<string>(yarr(p['display_position']), 'display_position') ?? '?';
        const slot = first<string>(yarr(p['selected_position']), 'selected_position') ?? '?';
        const entry = {
          player_id: null,
          name,
          position: pos,
          nfl_team: (first<string>(yarr(p['editorial_team_abbr']), 'editorial_team_abbr') ?? null) as string | null,
          slot,
          is_starter: slot !== 'BN' && slot !== 'IR',
          points: null,
          projected_points: null,
          injury_status: (first<string>(yarr(p['injury_note']), 'injury_note') ?? null) as string | null,
        };
        (entry.is_starter ? starters : bench).push(entry);
      }
      return {
        team_id: input.team_id,
        team_name: (first<string>(yarr(team?.['name']), 'name') as string) ?? input.team_id,
        week: week ?? 0,
        starters,
        bench,
      };
    },

    async getMatchups(input: LeagueInput): Promise<Matchup[]> {
      const week = input.week;
      const doc = await api<unknown>(
        week ? 'league/{key}/scoreboard;week=' + week : 'league/{key}/scoreboard',
        input,
      );
      const fc = y(y(doc)?.['fantasy_content']);
      const leagueArr = yarr(fc?.['league']);
      const league = first<Record<string, unknown>>(leagueArr, 'league') ?? y(leagueArr[0]);
      const board = first<Record<string, unknown>>(yarr(league?.['scoreboard']), 'scoreboard');
      const inner = y(board?.['0']) ?? board;
      const matchupItems = yarr(inner?.['matchups']);
      const out: Matchup[] = [];
      for (const item of matchupItems) {
        const m = first<Record<string, unknown>>(yarr(item), 'matchup') ?? y(item);
        if (!m) continue;
        const w = Number(first<string>(yarr(m['week']), 'week') ?? NaN);
        const teamItems = yarr(y(m['teams'])?.['team']);
        const sides: Array<{ id: string; name: string; points: number | null }> = [];
        for (const ti of teamItems) {
          const t = first<Record<string, unknown>>(yarr(ti), 'team') ?? y(ti);
          if (!t) continue;
          const flat = yarr(t);
          const rec: Record<string, unknown> = {};
          for (const f of flat) {
            const o = y(f);
            if (o) for (const k of Object.keys(o)) rec[k] = o[k];
          }
          const id = String(first<string>(yarr(rec['team_key']), 'team_key') ?? rec['team_key'] ?? '');
          const name = String(first<string>(yarr(rec['name']), 'name') ?? rec['name'] ?? id);
          const ptsNode = first<Record<string, unknown>>(yarr(rec['team_points']), 'team_points');
          const total = Number(first<string>(yarr(ptsNode?.['total']), 'total') ?? NaN);
          sides.push({ id, name, points: Number.isFinite(total) ? total : null });
        }
        if (sides.length !== 2) continue;
        out.push({
          matchup_id: `${Number.isFinite(w) ? w : week ?? 0}-${sides[0].id}-vs-${sides[1].id}`,
          week: Number.isFinite(w) ? w : (week ?? 0),
          home: { team_id: sides[0].id, team_name: sides[0].name, points: sides[0].points, projected_points: null },
          away: { team_id: sides[1].id, team_name: sides[1].name, points: sides[1].points, projected_points: null },
        });
      }
      return out;
    },

    async getStandings(input: LeagueInput): Promise<StandingRow[]> {
      const doc = await api<unknown>('league/{key}/standings', input);
      const rows = teamsOf(doc).map(teamSummary);
      rows.sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
      return rows.map((t, i) => ({ ...t, rank: i + 1 }));
    },

    async getTransactions(input: LeagueInput): Promise<Transaction[]> {
      const doc = await api<unknown>('league/{key}/transactions', input);
      const fc = y(y(doc)?.['fantasy_content']);
      const leagueArr = yarr(fc?.['league']);
      const league = first<Record<string, unknown>>(leagueArr, 'league') ?? y(leagueArr[0]);
      const txns = yarr(y(league?.['transactions'])?.['transaction']);
      const out: Transaction[] = [];
      for (const item of txns.slice(0, 50)) {
        const t = first<Record<string, unknown>>(yarr(item), 'transaction') ?? y(item);
        if (!t) continue;
        const type = first<string>(yarr(t['type']), 'type') ?? 'other';
        const week = Number(first<string>(yarr(t['week']), 'week') ?? NaN);
        const ts = Number(first<string>(yarr(t['timestamp']), 'timestamp') ?? NaN);
        out.push({
          id: String(first<string>(yarr(t['transaction_id']), 'transaction_id') ?? `yahoo-txn-${out.length}`),
          week: Number.isFinite(week) ? week : null,
          type: type === 'trade' ? 'trade' : type === 'waiver' ? 'waiver' : type === 'free_agent' ? 'free_agent' : 'other',
          headline: `${type} transaction`,
          detail: '',
          timestamp: Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null,
        });
      }
      return out;
    },
  };
}
