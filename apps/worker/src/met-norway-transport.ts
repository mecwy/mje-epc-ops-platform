/** Server-only injected transport. Real activation requires a durable atomic shared gate. */
import { createHash } from 'node:crypto';
import {
  metForecastPoint,
  parseWeatherQuery,
  type WeatherQueryDto,
  type WeatherReferenceDraftDto,
} from '@mje/contracts';
import {
  MetNorwayError,
  parseMetNorwayForecast,
} from './met-norway-provider.js';
export interface MetCacheEntry {
  body: unknown;
  fetchedAt: string;
  expiresAt: string;
  lastModified: string | null;
}
export interface MetCacheLease {
  key: string;
  token: string;
}
export interface MetSharedGate {
  /** Atomically checks provider-wide cooldown and the per-point lease in a trusted org. */
  take(
    key: string,
    now: string,
    signal: AbortSignal,
  ): Promise<
    | { state: 'fresh'; entry: MetCacheEntry }
    | { state: 'leased'; lease: MetCacheLease; entry: MetCacheEntry | null }
    | { state: 'busy'; retryAfterSeconds: number }
  >;
  /** Must reject expired/foreign tokens; HTTP runs outside any DB transaction. */
  commit(
    lease: MetCacheLease,
    entry: MetCacheEntry,
    now: string,
  ): Promise<boolean>;
  release(lease: MetCacheLease): Promise<void>;
  throttle(lease: MetCacheLease, until: string): Promise<void>;
}
export interface MetTransportDependencies {
  userAgent: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => string;
  gate: MetSharedGate;
}
const ENDPOINT = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const MAX_BODY = 2 * 1024 * 1024;
function boundedDelay(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(86400, Math.ceil(v))) : 60;
}
function retryAfter(header: string | null, now: number): number {
  if (header !== null && /^\d+$/.test(header))
    return boundedDelay(Number(header));
  const ms = header === null ? NaN : Date.parse(header);
  return Number.isFinite(ms) ? boundedDelay((ms - now) / 1000) : 60;
}
function httpDate(header: string | null): string | null {
  return header !== null && Number.isFinite(Date.parse(header)) ? header : null;
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new MetNorwayError('CANCELLED');
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new MetNorwayError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      cancelled(signal);
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) throw new MetNorwayError('INVALID_RESPONSE');
      chunks.push(part.value);
    }
    cancelled(signal);
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
}
/** No process Map fallback, client coordinates, force-cache bypass, or default User-Agent. */
export function createMetNorwayTransport(deps: MetTransportDependencies) {
  if (
    !deps.gate ||
    !deps.userAgent ||
    deps.userAgent.length > 300 ||
    /[\r\n]/.test(deps.userAgent) ||
    !/(https:\/\/[^\s)]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(deps.userAgent)
  )
    throw new MetNorwayError('CONFIGURATION_REQUIRED');
  return async (
    input: WeatherQueryDto,
    signal: AbortSignal,
  ): Promise<WeatherReferenceDraftDto> => {
    let lease: MetCacheLease | undefined;
    try {
      cancelled(signal);
      const now = deps.now(),
        q = parseWeatherQuery(input, now);
      if (q.product !== 'forecast') throw new MetNorwayError('NO_HISTORY');
      const point = metForecastPoint(q.point);
      let url = `${ENDPOINT}?lat=${point.lat}&lon=${point.lon}`;
      const key = createHash('sha256').update(url).digest('hex');
      const taken = await deps.gate.take(key, now, signal);
      if (taken.state === 'leased') lease = taken.lease;
      cancelled(signal);
      if (taken.state === 'busy')
        throw new MetNorwayError(
          'RATE_LIMITED',
          boundedDelay(taken.retryAfterSeconds),
        );
      if (taken.state === 'fresh') {
        if (Date.parse(taken.entry.expiresAt) <= Date.parse(now))
          throw new MetNorwayError('UNAVAILABLE');
        return parseMetNorwayForecast(
          taken.entry.body,
          q,
          taken.entry.fetchedAt,
        );
      }
      lease = taken.lease;
      if (lease.key !== key) throw new MetNorwayError('UNAVAILABLE');
      const old = taken.entry;
      const headers: Record<string, string> = {
        'User-Agent': deps.userAgent,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      };
      if (old?.lastModified !== null && old?.lastModified !== undefined)
        headers['If-Modified-Since'] = old.lastModified;
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 2; redirects++) {
        response = await deps.fetch(url, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal,
        });
        cancelled(signal);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location === null ? null : new URL(location, url);
        if (
          !next ||
          next.origin !== 'https://api.met.no' ||
          next.pathname !== new URL(ENDPOINT).pathname ||
          next.username ||
          next.password ||
          next.hash ||
          next.search !== new URL(url).search ||
          redirects === 2
        )
          throw new MetNorwayError('UNAVAILABLE');
        url = next.href;
      }
      if (!response) throw new MetNorwayError('UNAVAILABLE');
      const fetchedAt = deps.now();
      if (response.status === 429) {
        const delay = retryAfter(
          response.headers.get('retry-after'),
          Date.parse(fetchedAt),
        );
        await response.body?.cancel();
        await deps.gate.throttle(
          lease,
          new Date(Date.parse(fetchedAt) + delay * 1000).toISOString(),
        );
        throw new MetNorwayError('RATE_LIMITED', delay);
      }
      if (response.status !== 200 && response.status !== 304) {
        await response.body?.cancel();
        throw new MetNorwayError('UNAVAILABLE');
      }
      const expires = httpDate(response.headers.get('expires'));
      if (expires === null || Date.parse(expires) <= Date.parse(fetchedAt)) {
        await response.body?.cancel();
        throw new MetNorwayError('INVALID_RESPONSE');
      }
      let value: unknown;
      if (response.status === 304) {
        await response.body?.cancel();
        if (!old || !old.lastModified)
          throw new MetNorwayError('INVALID_RESPONSE');
        value = old.body;
      } else {
        if (
          !/^application\/(?:[\w.+-]*\+)?json(?:;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        ) {
          await response.body?.cancel();
          throw new MetNorwayError('INVALID_RESPONSE');
        }
        value = await body(response, signal);
      }
      const draft = parseMetNorwayForecast(value, q, fetchedAt);
      const lastModified =
        httpDate(response.headers.get('last-modified')) ??
        (response.status === 304 ? (old?.lastModified ?? null) : null);
      cancelled(signal);
      if (
        !(await deps.gate.commit(
          lease,
          {
            body: value,
            fetchedAt,
            expiresAt: new Date(expires).toISOString(),
            lastModified,
          },
          deps.now(),
        ))
      )
        throw new MetNorwayError('UNAVAILABLE');
      return draft;
    } catch (e) {
      if (e instanceof MetNorwayError) throw e;
      throw new MetNorwayError(signal.aborted ? 'CANCELLED' : 'UNAVAILABLE');
    } finally {
      if (lease) await deps.gate.release(lease).catch(() => undefined);
    }
  };
}
