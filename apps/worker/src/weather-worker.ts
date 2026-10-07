import {
  fetchOpenMeteo,
  WeatherProviderError,
  type OpenMeteoQuery,
  type WeatherProviderDependencies,
} from './weather-provider.js';
import { MetNorwayError } from './met-norway-provider.js';
import { MetGateBusyError } from './met-norway-transport.js';
export interface WeatherWorkerLease {
  requestId: string;
  query: OpenMeteoQuery;
}
export interface WeatherWorkerDependencies<T, L extends WeatherWorkerLease> {
  /** Default is disabled. Production activation/configuration belongs to the shared boot owner. */
  enabled?: boolean;
  jobs: {
    claim: () => Promise<L | null>;
    finish: (lease: L, draft: T) => Promise<boolean>;
    fail: (
      lease: L,
      code:
        | 'DISABLED'
        | 'UNAVAILABLE'
        | 'RATE_LIMITED'
        | 'NO_HISTORY'
        | 'INVALID_RESPONSE',
      retryAfterSeconds?: number,
    ) => Promise<boolean>;
    /** Return a pre-HTTP gate deferral without consuming this claim's supplier-attempt reservation. */
    defer?: (lease: L, retryAfterSeconds: number) => Promise<boolean>;
  };
  provider?: WeatherProviderDependencies<T>;
  /** Provider adapter must settle on AbortSignal before a live runtime closes its pool. */
  execute?: (query: OpenMeteoQuery, signal: AbortSignal) => Promise<T>;
}
export async function runWeatherOnce<T, L extends WeatherWorkerLease>(
  dependencies: WeatherWorkerDependencies<T, L>,
  signal?: AbortSignal,
): Promise<{
  state: 'idle' | 'ready' | 'stale' | 'disabled' | 'unavailable';
  requestId: string | null;
}> {
  if (dependencies.enabled !== true)
    return { state: 'disabled', requestId: null };
  if (!dependencies.execute && !dependencies.provider)
    throw new Error('WEATHER_PROVIDER_REQUIRED');
  const lease = await dependencies.jobs.claim();
  if (!lease) return { state: 'idle', requestId: null };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((e: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectAbort?.(new Error('WEATHER_CANCELLED'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  let operation: Promise<T> | undefined;
  try {
    if (signal?.aborted) throw new Error('WEATHER_CANCELLED');
    operation = dependencies.execute
      ? dependencies.execute(lease.query, controller.signal)
      : fetchOpenMeteo(lease.query, dependencies.provider!, controller.signal);
    const draft = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        rejectAbort = reject;
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('WEATHER_TIMEOUT'));
        }, 8000);
      }),
    ]);
    if (controller.signal.aborted) throw new Error('WEATHER_CANCELLED');
    return {
      state: (await dependencies.jobs.finish(lease, draft)) ? 'ready' : 'stale',
      requestId: lease.requestId,
    };
  } catch (e) {
    if (e instanceof MetGateBusyError) {
      if (!dependencies.jobs.defer)
        throw new Error('WEATHER_DEFER_REQUIRED', { cause: e });
      const delay = Number.isFinite(e.retryAfterSeconds)
        ? Math.max(1, Math.min(86400, Math.ceil(e.retryAfterSeconds)))
        : 60;
      return {
        state: (await dependencies.jobs.defer(lease, delay)) ? 'idle' : 'stale',
        requestId: lease.requestId,
      };
    }
    const code =
      e instanceof MetNorwayError && e.code === 'NO_HISTORY'
        ? 'NO_HISTORY'
        : e instanceof MetNorwayError && e.code === 'INVALID_RESPONSE'
          ? 'INVALID_RESPONSE'
          : (e instanceof MetNorwayError && e.code === 'RATE_LIMITED') ||
              (e instanceof WeatherProviderError &&
                e.code === 'WEATHER_RATE_LIMITED')
            ? 'RATE_LIMITED'
            : 'UNAVAILABLE';
    const retry =
      e instanceof MetNorwayError &&
      e.retryAfterSeconds !== undefined &&
      Number.isFinite(e.retryAfterSeconds)
        ? Math.max(0, Math.min(86400, Math.ceil(e.retryAfterSeconds)))
        : undefined;
    const applied =
      retry === undefined
        ? await dependencies.jobs.fail(lease, code)
        : await dependencies.jobs.fail(lease, code, retry);
    return {
      state: applied ? 'unavailable' : 'stale',
      requestId: lease.requestId,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    // Shutdown joins the actual provider cleanup, including its shared-gate release.
    if (operation && (dependencies.execute || signal?.aborted))
      await operation.catch(() => undefined);
  }
}
