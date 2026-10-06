import {
  fetchOpenMeteo,
  WeatherProviderError,
  type OpenMeteoQuery,
  type WeatherProviderDependencies,
} from './weather-provider.js';
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
      code: 'DISABLED' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'NO_HISTORY',
    ) => Promise<boolean>;
  };
  provider: WeatherProviderDependencies<T>;
}
export async function runWeatherOnce<T, L extends WeatherWorkerLease>(
  dependencies: WeatherWorkerDependencies<T, L>,
): Promise<{
  state: 'idle' | 'ready' | 'stale' | 'disabled' | 'unavailable';
  requestId: string | null;
}> {
  const lease = await dependencies.jobs.claim();
  if (!lease) return { state: 'idle', requestId: null };
  if (dependencies.enabled !== true) {
    const applied = await dependencies.jobs.fail(lease, 'DISABLED');
    return {
      state: applied ? 'disabled' : 'stale',
      requestId: lease.requestId,
    };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const draft = await Promise.race([
      fetchOpenMeteo(lease.query, dependencies.provider, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('WEATHER_TIMEOUT'));
        }, 8000);
      }),
    ]);
    return {
      state: (await dependencies.jobs.finish(lease, draft)) ? 'ready' : 'stale',
      requestId: lease.requestId,
    };
  } catch (e) {
    const code =
      e instanceof WeatherProviderError && e.code === 'WEATHER_RATE_LIMITED'
        ? 'RATE_LIMITED'
        : 'UNAVAILABLE';
    const applied = await dependencies.jobs.fail(lease, code);
    return {
      state: applied ? 'unavailable' : 'stale',
      requestId: lease.requestId,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
