/**
 * Normalized cross-platform fantasy types. Providers translate their native
 * payloads into these; tools only speak this dialect.
 */

export type Platform = 'sleeper' | 'espn' | 'yahoo';

export interface CredentialBundle {
  /** ESPN private leagues: the `swid` cookie value. From Muse's Secure Credentials Store only. */
  espn_swid?: string;
  /** ESPN private leagues: the `espn_s2` cookie value. From Muse's Secure Credentials Store only. */
  espn_s2?: string;
  /** Yahoo private leagues: OAuth2 access token. From Muse's Secure Credentials Store only. */
  yahoo_access_token?: string;
}

export interface LeagueInput {
  platform: Platform;
  /** Platform-native league id. Sleeper: numeric id. ESPN: numeric league id. Yahoo: league key like `nfl.l.12345`. */
  league_id: string;
  season?: number;
  week?: number;
  team_id?: string;
  credential?: CredentialBundle;
}

export interface LeagueInfo {
  platform: Platform;
  league_id: string;
  season: number;
  name: string;
  team_count: number;
  current_week: number | null;
  status: string;
  is_private: boolean;
}

export interface TeamSummary {
  team_id: string;
  name: string;
  abbreviation?: string | null;
  owners: string[];
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number | null;
}

export interface StandingRow extends TeamSummary {
  rank: number | null;
}

export interface PlayerEntry {
  player_id: string | null;
  name: string;
  position: string;
  nfl_team: string | null;
  slot: string;
  is_starter: boolean;
  points: number | null;
  projected_points: number | null;
  injury_status: string | null;
}

export interface Roster {
  team_id: string;
  team_name: string;
  week: number;
  starters: PlayerEntry[];
  bench: PlayerEntry[];
}

export interface MatchupSide {
  team_id: string;
  team_name: string;
  points: number | null;
  projected_points: number | null;
}

export interface Matchup {
  matchup_id: string;
  week: number;
  home: MatchupSide;
  away: MatchupSide;
}

export type TransactionType = 'trade' | 'waiver' | 'free_agent' | 'other';

export interface Transaction {
  id: string;
  week: number | null;
  type: TransactionType;
  headline: string;
  detail: string;
  timestamp: string | null;
}

export interface LeagueProvider {
  platform: Platform;
  /** Throws ProviderError on bad id / not found / private-without-auth. */
  getLeague(input: LeagueInput): Promise<LeagueInfo>;
  getTeams(input: LeagueInput): Promise<TeamSummary[]>;
  getRoster(input: LeagueInput): Promise<Roster>;
  getMatchups(input: LeagueInput): Promise<Matchup[]>;
  getStandings(input: LeagueInput): Promise<StandingRow[]>;
  getTransactions(input: LeagueInput): Promise<Transaction[]>;
}

export class ProviderError extends Error {
  readonly code: 'invalid_league_id' | 'not_found' | 'private_league' | 'auth_required' | 'upstream_error' | 'not_configured';
  readonly status?: number;
  constructor(code: ProviderError['code'], message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

/** Never log or echo credential values. This helper exists so a slip is a type error away. */
export function hasPrivateCredential(input: LeagueInput): boolean {
  const c = input.credential;
  if (!c) return false;
  if (input.platform === 'espn') return Boolean(c.espn_swid && c.espn_s2);
  if (input.platform === 'yahoo') return Boolean(c.yahoo_access_token);
  return false;
}
