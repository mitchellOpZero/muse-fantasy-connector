/**
 * Premium gating end-to-end over MCP: premium tools return the x402-style
 * 402 payload for Free callers and proceed for entitled subjects.
 * Env is set before the server module loads (config reads env at import).
 */
import { describe, expect, it } from 'vitest';

process.env.PAYMENT_URL = 'https://pay.example.com/sub';
process.env.PRICING_URL = 'https://example.com/pricing';
process.env.PREMIUM_SUBJECTS = 'coach@example.com';
process.env.COMMISSIONER_SUBJECTS = 'commish@example.com';

const { app } = await import('../src/server.js');

async function toolsCall(name: string, args: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ text: string }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
        });
        resolve({ text: await res.text() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

const badLeague = { platform: 'sleeper', league_id: 'abc' }; // fails validation before any network

describe('premium gating over MCP', () => {
  it('analyze_trade 402s for anonymous callers with payment_url', async () => {
    const { text } = await toolsCall('analyze_trade', { ...badLeague, my_team_id: '1', other_team_id: '2', players_in: [], players_out: [] });
    const body = JSON.parse(text);
    const result = body.result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.http_status).toBe(402);
    expect(result.structuredContent.code).toBe('payment_required');
    expect(result.structuredContent.required_tier).toBe('pro');
    expect(result.structuredContent.payment_url).toBe('https://pay.example.com/sub');
    expect(result.content[0].text).toContain('402 Payment Required');
    expect(result.content[0].text).not.toContain('sk-');
  });

  it('weekly_recap 402s for pro (non-commissioner) callers', async () => {
    const { text } = await toolsCall('weekly_recap', badLeague, { 'x-muse-subject': 'coach@example.com' });
    const result = JSON.parse(text).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.http_status).toBe(402);
    expect(result.structuredContent.required_tier).toBe('commissioner');
  });

  it('entitled subjects pass the gate (then fail on the bad league id, not on billing)', async () => {
    const { text } = await toolsCall(
      'analyze_trade',
      { ...badLeague, my_team_id: '1', other_team_id: '2', players_in: [], players_out: [] },
      { authorization: 'Bearer coach@example.com' },
    );
    const result = JSON.parse(text).result;
    expect(result.isError).toBe(true);
    // Gate passed: the failure is league-id validation, which happens before any network.
    expect(result.structuredContent.error).toBe('invalid_league_id');
    expect(result.structuredContent.http_status).toBeUndefined();
  });

  it('free tools stay free for anonymous callers', async () => {
    const { text } = await toolsCall('connect_league', badLeague);
    const result = JSON.parse(text).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe('invalid_league_id');
    expect(result.structuredContent.http_status).toBeUndefined();
  });

  it('private leagues 402 on connect_league for free callers', async () => {
    const privEspn = { platform: 'espn', league_id: 'abc', credential: { espn_swid: 'x', espn_s2: 'y' } };
    for (const args of [privEspn, { platform: 'yahoo', league_id: 'nfl.l.12345' }]) {
      const { text } = await toolsCall('connect_league', args);
      const result = JSON.parse(text).result;
      expect(result.isError).toBe(true);
      expect(result.structuredContent.http_status).toBe(402);
      expect(result.structuredContent.required_tier).toBe('pro');
      expect(result.structuredContent.tool).toBe('connect_league');
    }
  });

  it('pro callers can connect private leagues (then fail on the bad league id)', async () => {
    const { text } = await toolsCall(
      'connect_league',
      { platform: 'espn', league_id: 'abc', credential: { espn_swid: 'x', espn_s2: 'y' } },
      { 'x-muse-subject': 'coach@example.com' },
    );
    const result = JSON.parse(text).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toBe('invalid_league_id');
    expect(result.structuredContent.http_status).toBeUndefined();
  });
});
