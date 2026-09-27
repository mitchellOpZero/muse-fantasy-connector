/**
 * Transport contract tests against the real express app:
 * POST-only Streamable HTTP, single JSON body (no SSE), GET -> 405,
 * Accept-header normalization, static docs, health.
 */
import { describe, expect, it } from 'vitest';
import { app } from '../src/server.js';

const BASE = 'http://127.0.0.1';

async function post(body: unknown, headers: Record<string, string> = {}) {
  // supertest-style via app.handle: use the app as a fetch handler through
  // a real ephemeral listener so transport behavior is realistic.
  return new Promise<{ status: number; headers: Headers; text: string }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        resolve({ status: res.status, headers: res.headers, text });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

async function get(path: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      try {
        const res = await fetch(`${BASE.replace('127.0.0.1', `127.0.0.1:${port}`)}${path}`);
        resolve({ status: res.status, text: await res.text() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '1.0.0' } },
};

describe('MCP transport', () => {
  it('initialize returns a single JSON body (no SSE), even with Accept: application/json only', async () => {
    const { status, headers, text } = await post(init);
    expect(status).toBe(200);
    const ct = headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
    expect(ct).not.toContain('text/event-stream');
    const body = JSON.parse(text);
    expect(body.result.serverInfo.name).toBe('fantasy-football');
    // Single JSON object, not an SSE stream of chunks.
    expect(text.trim().startsWith('{')).toBe(true);
  });

  it('tools/list exposes exactly the 10 fantasy tools', async () => {
    const { text } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = JSON.parse(text);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      ['analyze_trade', 'connect_league', 'get_matchup', 'get_roster', 'get_standings', 'list_my_teams', 'list_transactions', 'start_sit_advice', 'waiver_targets', 'weekly_recap'].sort(),
    );
    expect(names).toHaveLength(10);
  });

  it('GET /mcp returns 405, not a hang', async () => {
    const { status, text } = await get('/mcp');
    expect(status).toBe(405);
    expect(JSON.parse(text).error.code).toBe(-32000);
  });

  it('malformed JSON returns a JSON-RPC parse error, not a stack trace', async () => {
    const raw = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', async () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
          });
          resolve({ status: res.status, text: await res.text() });
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
    expect(raw.status).toBe(400);
    const body = JSON.parse(raw.text);
    expect(body.error.code).toBe(-32700);
    expect(raw.text).not.toContain('at ');
  });

  it('static docs and health are served', async () => {
    for (const p of ['/muse.md', '/llms.txt', '/terms', '/healthz']) {
      const { status, text } = await get(p);
      expect(status, p).toBe(200);
      expect(text.length).toBeGreaterThan(50);
    }
    const { text } = await get('/healthz');
    expect(JSON.parse(text)).toMatchObject({ ok: true, service: 'fantasy-football' });
  });

  it('yahoo authorize without config is a clean 501, not a crash', async () => {
    const { status, text } = await get('/v1/yahoo/authorize');
    expect(status).toBe(501);
    expect(JSON.parse(text).error).toBe('not_configured');
  });
});
