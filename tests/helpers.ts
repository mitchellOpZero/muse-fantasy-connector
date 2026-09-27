import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchImpl } from '../src/providers/http.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

function load(rel: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, 'fixtures', rel), 'utf-8'));
}

/** Fixture-backed fetch: no live network in provider unit tests. */
export function fixtureFetch(): FetchImpl {
  return (async (url: unknown, _init?: unknown) => {
    const u = String(url);
    let body: unknown = null;
    if (u.includes('api.sleeper.app')) {
      if (u.includes('/state/nfl')) body = load('sleeper/state.json');
      else if (u.includes('/trending/add')) body = load('sleeper/trending.json');
      else if (u.includes('/players/nfl')) body = load('sleeper/players.json');
      else if (u.includes('/users')) body = load('sleeper/users.json');
      else if (u.includes('/rosters')) body = load('sleeper/rosters.json');
      else if (u.includes('/matchups/')) body = load('sleeper/matchups.json');
      else if (u.includes('/transactions/')) body = load('sleeper/transactions.json');
      else if (/\/league\/\d+$/.test(u)) body = load('sleeper/league.json');
    } else if (u.includes('fantasy.espn.com')) {
      if (u.includes('view=mBoxscore')) body = load('espn/boxscore.json');
      else body = load('espn/league.json');
    }
    if (body === null) {
      return new Response(JSON.stringify({ error: 'no fixture' }), { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchImpl;
}
