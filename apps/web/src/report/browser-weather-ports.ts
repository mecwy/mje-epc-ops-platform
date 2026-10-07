import {
  isRealTimestamp,
  type WeatherLocationDto,
  type WeatherRequestCommand,
  type WeatherRequestDto,
  type WeatherRequestState,
} from '@mje/contracts';
import { snapshotToView, disabledWeatherPorts } from './weather-adapter.js';
import type {
  WeatherContext,
  WeatherLocationDependencies,
  WeatherQueryIntent,
  WeatherQueryResult,
} from './weather-location-session.js';

/** Authenticated same-origin API only. No coordinates, token, provider or GPS belong here. */
export interface BrowserWeatherApi {
  weatherLocations(projectId: string, signal?: AbortSignal): Promise<unknown>;
  requestWeather(
    command: WeatherRequestCommand,
    signal?: AbortSignal,
  ): Promise<unknown>;
  weatherRequestStatus(
    projectId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  weatherSnapshot(
    projectId: string,
    snapshotId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES: WeatherRequestState[] = [
  'PENDING',
  'FETCHING',
  'READY',
  'NO_HISTORY',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'DISABLED',
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_WEATHER_RESPONSE');
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new Error('INVALID_WEATHER_RESPONSE');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('INVALID_WEATHER_RESPONSE');
  return value;
}
export function confirmedWeatherLocations(
  input: unknown,
  context: Readonly<WeatherContext>,
): WeatherLocationDto[] {
  if (!Array.isArray(input) || input.length > 2000)
    throw new Error('INVALID_WEATHER_RESPONSE');
  const scopes = new Map<string, WeatherLocationDto>();
  const versions = new Map<string, string>();
  const identities = new Set<string>();
  for (const value of input) {
    const o = object(value),
      point = object(o['point']);
    const coord = (key: 'lat' | 'lon', limit: number) => {
      const v = text(point[key], 32);
      if (!/^-?\d{1,3}(?:\.\d{1,12})?$/.test(v) || Math.abs(Number(v)) > limit)
        throw new Error('INVALID_WEATHER_RESPONSE');
      return v;
    };
    const confirmedAt = text(o['confirmedAt'], 40);
    if (
      o['projectId'] !== context.projectId ||
      o['siteTimezone'] !== context.timezone ||
      typeof o['n'] !== 'number' ||
      !Number.isSafeInteger(o['n']) ||
      o['n'] <= 0 ||
      !confirmedAt.endsWith('Z') ||
      !isRealTimestamp(confirmedAt)
    )
      throw new Error('INVALID_WEATHER_RESPONSE');
    const location: WeatherLocationDto = {
      id: uuid(o['id']),
      projectId: uuid(o['projectId']),
      scopeKey: text(o['scopeKey'], 100),
      n: o['n'],
      siteTimezone: context.timezone,
      point: { lat: coord('lat', 90), lon: coord('lon', 180) },
      confirmedAt,
    };
    const key = JSON.stringify([location.scopeKey, location.n]);
    const serialized = JSON.stringify(location);
    if (versions.has(key) || identities.has(location.id))
      throw new Error('INVALID_WEATHER_RESPONSE');
    versions.set(key, serialized);
    identities.add(location.id);
    const current = scopes.get(location.scopeKey);
    if (!current || location.n > current.n)
      scopes.set(location.scopeKey, location);
  }
  return [...scopes.values()].sort((a, b) =>
    a.scopeKey.localeCompare(b.scopeKey),
  );
}
function request(
  input: unknown,
  context: Readonly<WeatherContext>,
  requestId?: string,
): WeatherRequestDto {
  const o = object(input),
    id = uuid(o['id']);
  if (
    (requestId !== undefined && id !== requestId) ||
    o['projectId'] !== context.projectId ||
    o['businessDate'] !== context.businessDate ||
    o['locationVersionId'] !== context.locationVersionId ||
    !STATES.includes(o['state'] as WeatherRequestState)
  )
    throw new Error('INVALID_WEATHER_RESPONSE');
  const state = o['state'] as WeatherRequestState;
  const snapshotId = o['snapshotId'] === null ? null : uuid(o['snapshotId']);
  if ((state === 'READY') !== (snapshotId !== null))
    throw new Error('INVALID_WEATHER_RESPONSE');
  return {
    id,
    projectId: context.projectId,
    businessDate: context.businessDate,
    locationVersionId: context.locationVersionId!,
    state,
    snapshotId,
  };
}
function abortError() {
  return new DOMException('Aborted', 'AbortError');
}
/** Bounds even an injected API that ignores abort; late values never escape this operation. */
function aborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      void operation.catch(() => {});
      reject(abortError());
      return;
    }
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}
function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 2000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
export function weatherReferenceFlag(flag: string | undefined): boolean {
  return flag === 'true';
}

export function createBrowserWeatherPorts(
  api: BrowserWeatherApi,
): Pick<
  WeatherLocationDependencies,
  'listLocations' | 'queryWeather' | 'loadWeather'
> {
  return {
    loadWeather: disabledWeatherPorts.loadWeather,
    listLocations: async (context, signal) => {
      if (signal.aborted) throw abortError();
      return confirmedWeatherLocations(
        await aborted(api.weatherLocations(context.projectId, signal), signal),
        context,
      );
    },
    queryWeather: async (
      context,
      intent: WeatherQueryIntent,
      signal,
    ): Promise<WeatherQueryResult> => {
      if (signal.aborted) throw abortError();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener('abort', cancel, { once: true });
      const deadline = setTimeout(cancel, 30000);
      const live = controller.signal;
      let posting = false;
      try {
        const command = intent.command;
        if (
          command.projectId !== context.projectId ||
          command.businessDate !== context.businessDate ||
          command.locationVersionId !== context.locationVersionId
        )
          throw new Error('INVALID_WEATHER_RESPONSE');
        let result: WeatherRequestDto;
        const resuming = !!intent.requestId;
        if (!intent.requestId) {
          posting = true;
          result = request(
            await aborted(api.requestWeather(command, live), live),
            context,
          );
          intent.requestId = result.id;
          posting = false;
        } else
          result = request(
            await aborted(
              api.weatherRequestStatus(
                context.projectId,
                intent.requestId,
                live,
              ),
              live,
            ),
            context,
            intent.requestId,
          );
        // The initial GET on a resumed request counts towards the 15-read window.
        let polls = resuming ? 1 : 0;
        while (result.state === 'PENDING' || result.state === 'FETCHING') {
          if (polls >= 15) return { kind: 'pending' };
          if (polls > 0) await delay(live);
          result = request(
            await aborted(
              api.weatherRequestStatus(
                context.projectId,
                intent.requestId!,
                live,
              ),
              live,
            ),
            context,
            intent.requestId,
          );
          polls++;
        }
        if (result.state !== 'READY')
          return { kind: 'terminal', state: result.state };
        const snapshot = object(
          await aborted(
            api.weatherSnapshot(context.projectId, result.snapshotId!, live),
            live,
          ),
        );
        const reference = snapshotToView(
          {
            id: uuid(snapshot['id']),
            data: snapshot['data'] as Parameters<
              typeof snapshotToView
            >[0]['data'],
            sourceLink: text(snapshot['sourceLink'], 2000),
            licenseLink: text(snapshot['licenseLink'], 2000),
          },
          Date.now(),
        );
        if (
          reference.snapshotId !== result.snapshotId ||
          reference.projectId !== context.projectId ||
          reference.businessDate !== context.businessDate ||
          reference.timezone !== context.timezone ||
          reference.locationVersionId !== context.locationVersionId
        )
          throw new Error('INVALID_WEATHER_RESPONSE');
        return { kind: 'ready', reference };
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (live.aborted)
          return intent.requestId ? { kind: 'pending' } : { kind: 'unknown' };
        const code =
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
        if (
          posting &&
          (code === 'NETWORK' ||
            code === 'REQUEST_FAILED' ||
            code === 'RETRY' ||
            code === 'RATE_LIMITED' ||
            !(error instanceof Error))
        )
          return { kind: 'unknown' };
        throw new Error('WEATHER_QUERY_FAILED', { cause: error });
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', cancel);
      }
    },
  };
}
