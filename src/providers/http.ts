/** Small fetch wrapper: timeouts, UA, JSON errors as ProviderError. */
import { ProviderError } from './types.js';

export type FetchImpl = typeof fetch;

const DEFAULT_UA = 'MuseFantasyConnector/0.1 (+https://github.com/mitchellOpZero/muse-fantasy-connector)';

export async function fetchJson<T>(
  url: string,
  fetchImpl: FetchImpl = fetch,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 12000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': DEFAULT_UA,
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 404) throw new ProviderError('not_found', `Upstream returned 404 for ${shortUrl(url)}`, 404);
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        'private_league',
        'Upstream refused access (401/403). This league looks private — connect with credentials from the Secure Credentials Store.',
        res.status,
      );
    }
    if (!res.ok) throw new ProviderError('upstream_error', `Upstream error ${res.status} for ${shortUrl(url)}`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError('upstream_error', `Upstream timed out after ${timeoutMs}ms: ${shortUrl(url)}`);
    }
    throw new ProviderError('upstream_error', `Upstream request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}
