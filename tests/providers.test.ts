import { describe, expect, it } from 'vitest';
import { createSleeperProvider, sleeperTrendingAdds } from '../src/providers/sleeper.js';
import { checkEspnLeagueId, createEspnProvider } from '../src/providers/espn.js';
import {
  checkYahooLeagueKey,
  codeChallengeS256,
  createYahooProvider,
  newCodeVerifier,
  yahooAuthorizeUrl,
} from '../src/providers/yahoo.js';
import { ProviderError } from '../src/providers/types.js';
import { fixtureFetch } from './helpers.js';

const sleeper = () => createSleeperProvider({ fetchImpl: fixtureFetch() });
const espn = () => createEspnProvider({ fetchImpl: fixtureFetch() });

describe('sleeper provider (fixtures)', () => {
  it('rejects non-numeric league ids without network', async () => {
    await expect(sleeper().getLeague({ platform: 'sleeper', league_id: 'abc' })).rejects.toMatchObject({
      code: 'invalid_league_id',
    });
  });

  it('getLeague parses name/season/teams/week', async () => {
    const info = await sleeper().getLeague({ platform: 'sleeper', league_id: '1234567890123456789' });
    expect(info).toMatchObject({ name: 'Test Sleeper League', season: 2026, team_count: 2, current_week: 3, is_private: false });
  });

  it('getStandings sorts by wins then points', async () => {
    const rows = await sleeper().getStandings({ platform: 'sleeper', league_id: '1234567890123456789' });
    expect(rows.map((r) => r.team_id)).toEqual(['1', '2']);
    expect(rows[0]).toMatchObject({ rank: 1, name: 'Alices Avengers', wins: 2, losses: 1 });
    expect(rows[1].name).toBe('Bob'); // falls back to owner display name
  });

  it('getRoster splits starters/bench with points', async () => {
    const roster = await sleeper().getRoster({ platform: 'sleeper', league_id: '1234567890123456789', team_id: '1' });
    expect(roster.team_name).toBe('Alices Avengers');
    expect(roster.week).toBe(3);
    expect(roster.starters.map((p) => p.name)).toEqual(['Josh Allen', 'Jahmyr Gibbs']);
    expect(roster.starters[0].points).toBe(28.4);
    expect(roster.bench.map((p) => p.name)).toEqual(['Puka Nacua', 'Bench Warmer']);
  });

  it('getMatchups pairs both sides', async () => {
    const matchups = await sleeper().getMatchups({ platform: 'sleeper', league_id: '1234567890123456789' });
    expect(matchups).toHaveLength(1);
    expect(matchups[0]).toMatchObject({
      matchup_id: '1',
      week: 3,
      home: { team_name: 'Alices Avengers', points: 46 },
      away: { team_name: 'Bob', points: 31.3 },
    });
  });

  it('getTransactions labels trades and waivers', async () => {
    const txns = await sleeper().getTransactions({ platform: 'sleeper', league_id: '1234567890123456789' });
    expect(txns.map((t) => t.type)).toEqual(['trade', 'waiver']);
    expect(txns[0].headline).toContain('Trade');
    expect(txns[0].detail).toContain('Puka Nacua');
    expect(txns[1].headline).toContain('Rookie Sensation');
  });

  it('sleeperTrendingAdds resolves names', async () => {
    const trending = await sleeperTrendingAdds(fixtureFetch(), 10);
    expect(trending[0]).toMatchObject({ name: 'Rookie Sensation', position: 'WR', trend_count: 1842 });
  });
});

describe('espn provider (fixtures)', () => {
  it('validates league ids like bakabois identity.ts', () => {
    expect(checkEspnLeagueId('1446375')).toBe('1446375');
    expect(() => checkEspnLeagueId('abc')).toThrowError(ProviderError);
    expect(() => checkEspnLeagueId('0')).toThrowError(ProviderError);
    expect(() => checkEspnLeagueId('99999999999999999999')).toThrowError(ProviderError);
  });

  it('getLeague parses name/teams/current week', async () => {
    const info = await espn().getLeague({ platform: 'espn', league_id: '1446375', season: 2026 });
    expect(info).toMatchObject({ name: 'BakaBois Test', season: 2026, team_count: 2, current_week: 3 });
  });

  it('getStandings ranks by wins then points for', async () => {
    const rows = await espn().getStandings({ platform: 'espn', league_id: '1446375', season: 2026 });
    expect(rows.map((r) => r.name)).toEqual(['Alpha Avengers', 'Beta Bandits']);
    expect(rows[0]).toMatchObject({ rank: 1, wins: 2, points_for: 301.5 });
  });

  it('getMatchups filters to the requested week', async () => {
    const matchups = await espn().getMatchups({ platform: 'espn', league_id: '1446375', season: 2026, week: 3 });
    expect(matchups).toHaveLength(1);
    expect(matchups[0].home).toMatchObject({ team_name: 'Alpha Avengers', points: 132.25 });
    expect(matchups[0].away).toMatchObject({ team_name: 'Beta Bandits', points: 118.5 });
  });

  it('getRoster resolves slots, points, and projections', async () => {
    const roster = await espn().getRoster({ platform: 'espn', league_id: '1446375', season: 2026, team_id: '1', week: 3 });
    expect(roster.team_name).toBe('Alpha Avengers');
    expect(roster.starters).toHaveLength(1);
    expect(roster.starters[0]).toMatchObject({ name: 'Josh Allen', position: 'QB', slot: 'QB', points: 24.6, projected_points: 23.1 });
    expect(roster.bench[0].is_starter).toBe(false);
  });

  it('getTransactions classifies waiver moves', async () => {
    const txns = await espn().getTransactions({ platform: 'espn', league_id: '1446375', season: 2026 });
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('waiver');
    expect(txns[0].week).toBe(3);
  });
});

describe('yahoo provider', () => {
  it('validates league keys', () => {
    expect(checkYahooLeagueKey('nfl.l.12345')).toBe('nfl.l.12345');
    expect(() => checkYahooLeagueKey('12345')).toThrowError(ProviderError);
    expect(() => checkYahooLeagueKey('nfl.l.abc')).toThrowError(ProviderError);
  });

  it('PKCE S256 challenge is correct (cross-checked node crypto vs python hashlib)', () => {
    // Both implementations agree on this digest for the RFC 7636 Appendix B verifier.
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(newCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('authorize url requires app config, then builds the Yahoo URL', () => {
    expect(() => yahooAuthorizeUrl({}, newCodeVerifier())).toThrowError(/not configured/i);
    const url = yahooAuthorizeUrl(
      { clientId: 'cid', redirectUri: 'https://x.example/cb' },
      'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(url).toContain('https://api.login.yahoo.com/oauth2/request_auth');
    expect(url).toContain('scope=fspt-r');
    expect(url).toContain('code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('league reads require an access token', async () => {
    const y = createYahooProvider({ fetchImpl: fixtureFetch() });
    await expect(y.getLeague({ platform: 'yahoo', league_id: 'nfl.l.12345' })).rejects.toMatchObject({
      code: 'auth_required',
    });
  });
});
