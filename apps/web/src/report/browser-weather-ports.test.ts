import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseReportLocationCandidate,
  WEATHER_METRICS,
  type WeatherLocationDto,
  type WeatherSnapshotDto,
} from '@mje/contracts';
import {
  confirmedWeatherLocations,
  createBrowserWeatherPorts,
  weatherReferenceFlag,
  type BrowserWeatherApi,
} from './browser-weather-ports.js';
import { browserLocationPortsForFlag } from './browser-location-ports.js';
import {
  WeatherLocationSession,
  type WeatherContext,
  type WeatherQueryIntent,
} from './weather-location-session.js';

// Synthetic same-origin API responses. No browser GPS, server, DB or provider is started.
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = (): WeatherContext => ({
  ownerKey: 'TEST-owner',
  projectId: id(1),
  businessDate: '2026-10-05',
  timezone: 'UTC',
  locationVersionId: id(3),
});
const location = (
  n = 1,
  scopeKey = 'TEST-site',
  versionId = id(3),
): WeatherLocationDto => ({
  id: versionId,
  projectId: id(1),
  scopeKey,
  n,
  siteTimezone: 'UTC',
  point: { lat: '1', lon: '1' },
  confirmedAt: '2026-10-06T10:00:00Z',
});
const request = (state = 'READY', snapshotId: string | null = id(8)) => ({
  id: id(7),
  projectId: id(1),
  businessDate: '2026-10-05',
  locationVersionId: id(3),
  state,
  snapshotId,
});
function snapshot(): WeatherSnapshotDto {
  return {
    id: id(8),
    adapterVersion: 'TEST-v1',
    responseHash: 'TEST-hash',
    sourceLink: 'https://example.test/weather',
    licenseLink: 'https://example.test/license',
    data: {
      provider: 'open-meteo',
      query: {
        projectId: id(1),
        locationVersionId: id(3),
        businessDate: '2026-10-05',
        timezone: 'UTC',
        point: { lat: '1', lon: '1' },
        interval: {
          startAt: '2026-10-05T00:00:00Z',
          endAt: '2026-10-06T00:00:00Z',
        },
        product: 'historical-weather',
        model: 'era5',
      },
      category: 'reanalysis',
      fetchedAt: '2026-10-06T12:00:00Z',
      publishedAt: null,
      coverage: 'partial',
      grid: null,
      metrics: Object.fromEntries(
        WEATHER_METRICS.map((key) => [
          key,
          key === 'precipitation'
            ? { state: 'value', value: '0', raw: '0', unit: 'mm' }
            : {
                state: 'missing',
                raw: null,
                unit: null,
                reason: 'TEST absent',
              },
        ]),
      ) as WeatherSnapshotDto['data']['metrics'],
    },
  };
}
function setup(overrides: Partial<BrowserWeatherApi> = {}) {
  const api: BrowserWeatherApi = {
    weatherLocations: vi.fn(async () => [location()]),
    requestWeather: vi.fn(async () => request()),
    weatherRequestStatus: vi.fn(async () => request()),
    weatherSnapshot: vi.fn(async () => snapshot()),
    ...overrides,
  };
  const ports = createBrowserWeatherPorts(api);
  const locate = vi.fn(async () => ({ kind: 'unsupported' as const }));
  const referenceWeather = vi.fn(() => true);
  const instance = new WeatherLocationSession(
    { ...context(), locationVersionId: null },
    {
      ...ports,
      locate,
      acceptLocation: parseReportLocationCandidate,
      confirmLocation: vi.fn(() => true),
      referenceWeather,
    },
    { writable: true, locked: false },
  );
  return { api, ports, instance, locate, referenceWeather };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe('authenticated browser weather ports', () => {
  it('revalidates a selected scope to its newest version, and a removed scope returns to deliberate selection', async () => {
    const { instance, api } = setup({
      requestWeather: vi.fn(async () => request('NO_HISTORY', null)),
    });
    await instance.activateWeather();
    api.weatherLocations = vi.fn(async () => [
      location(),
      location(2, 'TEST-site', id(4)),
    ]);
    api.requestWeather = vi.fn(async () => ({
      ...request('NO_HISTORY', null),
      locationVersionId: id(4),
    }));
    await instance.activateWeather();
    expect(instance.getSnapshot().context.locationVersionId).toBe(id(4));
    expect(instance.getSnapshot().locationUpdated).toBe(true);
    expect(api.requestWeather).toHaveBeenCalledWith(
      expect.objectContaining({ locationVersionId: id(4), refresh: false }),
      expect.any(AbortSignal),
    );
    api.weatherLocations = vi.fn(async () => [
      location(1, 'TEST-replacement', id(5)),
    ]);
    await instance.activateWeather();
    expect(instance.getSnapshot().context.locationVersionId).toBeNull();
    expect(instance.getSnapshot().locationDirectoryStatus).toBe('choose');
    expect(api.requestWeather).toHaveBeenCalledTimes(1);
  });
  it('does not adopt a live reference after its freshness window has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-06T12:00:00Z');
    const { instance, referenceWeather } = setup();
    await instance.activateWeather();
    vi.setSystemTime('2026-10-06T13:00:00Z');
    expect(instance.referenceWeather()).toBe(false);
    expect(instance.getSnapshot().reference?.stale).toBe(true);
    expect(referenceWeather).not.toHaveBeenCalled();
  });
  it('a directory failure makes any previous reference visibly stale and blocks adoption', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-06T12:00:00Z');
    const { instance, api, referenceWeather } = setup();
    await instance.activateWeather();
    api.weatherLocations = vi.fn(async () => [
      { ...location(), projectId: id(99) },
    ]);
    await instance.activateWeather();
    expect(instance.getSnapshot().locationDirectoryStatus).toBe('failed');
    expect(instance.getSnapshot().reference?.stale).toBe(true);
    expect(instance.referenceWeather()).toBe(false);
    expect(referenceWeather).not.toHaveBeenCalled();
  });
  it.each(['ownerKey', 'projectId', 'businessDate', 'timezone'] as const)(
    'fences the old directory after changing %s and clears the previous choices',
    async (field) => {
      const late = deferred<unknown>();
      const { instance, api } = setup({
        weatherLocations: vi.fn(() => late.promise),
      });
      const loading = instance.activateWeather();
      const next = {
        ...instance.getSnapshot().context,
        [field]: field === 'projectId' ? id(99) : 'TEST-next',
      };
      instance.setContext(next);
      late.resolve([location()]);
      await loading;
      expect(instance.getSnapshot().context).toEqual(next);
      expect(instance.getSnapshot().locations).toEqual([]);
      expect(api.requestWeather).not.toHaveBeenCalled();
    },
  );
  it('hidden or renewing workspace access cancels the old operation and revalidates on return', async () => {
    const late = deferred<unknown>();
    const directory = vi
      .fn()
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue([location()]);
    const { instance, api } = setup({
      weatherLocations: directory,
      requestWeather: vi.fn(async () => request('NO_HISTORY', null)),
    });
    const loading = instance.activateWeather();
    instance.setAccess({ writable: false, locked: true });
    late.resolve([location()]);
    await loading;
    expect(api.requestWeather).not.toHaveBeenCalled();
    instance.setAccess({ writable: true, locked: false });
    await instance.activateWeather();
    expect(directory).toHaveBeenCalledTimes(2);
    expect(api.requestWeather).toHaveBeenCalledTimes(1);
  });
  it('status polling is serial and the deadline aborts a stalled GET without another POST', async () => {
    vi.useFakeTimers();
    const late = deferred<unknown>();
    const status = vi.fn(() => late.promise);
    const { instance, api } = setup({
      requestWeather: vi.fn(async () => request('PENDING', null)),
      weatherRequestStatus: status,
    });
    const pending = instance.activateWeather();
    await vi.advanceTimersByTimeAsync(29999);
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(instance.getSnapshot().weatherStatus).toBe('pending');
    expect(api.requestWeather).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    late.resolve(request());
    await Promise.resolve();
    expect(instance.getSnapshot().reference).toBeNull();
  });
  it.each(['true', 'false'] as const)(
    'keeps weather %s independent from both location flags',
    (weather) => {
      for (const gps of ['true', 'false']) {
        expect(weatherReferenceFlag(weather)).toBe(weather === 'true');
        expect(!!browserLocationPortsForFlag(gps)).toBe(gps === 'true');
      }
      expect(weatherReferenceFlag(undefined)).toBe(false);
    },
  );
  it('chooses only the newest confirmed version per scope and rejects conflicting duplicates', () => {
    expect(
      confirmedWeatherLocations(
        [
          location(1),
          location(2, 'TEST-site', id(4)),
          location(1, 'TEST-other', id(5)),
        ],
        context(),
      ).map((v) => v.id),
    ).toEqual([id(5), id(4)]);
    expect(() =>
      confirmedWeatherLocations(
        [location(), location(1, 'TEST-site', id(4))],
        context(),
      ),
    ).toThrow();
    for (const invalid of [
      { ...location(), projectId: id(99) },
      { ...location(), siteTimezone: 'Europe/Belgrade' },
      { ...location(), n: 0 },
    ])
      expect(() => confirmedWeatherLocations([invalid], context())).toThrow();
  });
  it('zero scopes makes zero POSTs and multiple scopes require a deliberate selection', async () => {
    const { instance, api, locate } = setup({
      weatherLocations: vi.fn(async () => []),
    });
    await instance.activateWeather();
    expect(instance.getSnapshot().locationDirectoryStatus).toBe('none');
    expect(api.requestWeather).not.toHaveBeenCalled();
    api.weatherLocations = vi.fn(async () => [
      location(),
      location(1, 'TEST-other', id(4)),
    ]);
    await instance.activateWeather();
    expect(instance.getSnapshot().locationDirectoryStatus).toBe('choose');
    expect(api.requestWeather).not.toHaveBeenCalled();
    await instance.selectWeatherLocation(id(3));
    expect(api.requestWeather).toHaveBeenCalledTimes(1);
    expect(locate).not.toHaveBeenCalled();
  });
  it('loads a canonical snapshot without adopting it or constructing frozen actor fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-06T12:00:00Z');
    const { instance, api, referenceWeather, locate } = setup();
    expect(await instance.activateWeather()).toBe(true);
    expect(instance.getSnapshot().reference?.snapshotId).toBe(id(8));
    expect(
      instance
        .getSnapshot()
        .reference?.values.find((v) => v.label === 'precipitation')?.value,
    ).toBe('0');
    expect(instance.getSnapshot().reference).not.toHaveProperty('adoptedAt');
    expect(referenceWeather).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
    expect(instance.referenceWeather()).toBe(true);
    expect(referenceWeather).toHaveBeenCalledWith(context(), id(8));
    expect(api.requestWeather).toHaveBeenCalledWith(
      expect.objectContaining({ refresh: false, locationVersionId: id(3) }),
      expect.any(AbortSignal),
    );
    await instance.refreshWeather();
    expect(api.requestWeather).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: true }),
      expect.any(AbortSignal),
    );
  });
  it('keeps an unknown POST command and key for recovery instead of creating a fresh request', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce({ code: 'NETWORK' })
      .mockResolvedValue(request('NO_HISTORY', null));
    const { instance } = setup({ requestWeather: post });
    await instance.activateWeather();
    expect(instance.getSnapshot().weatherStatus).toBe('unknown');
    await instance.refreshWeather();
    expect(instance.getSnapshot().weatherStatus).toBe('NO_HISTORY');
    expect(post.mock.calls[1]![0]).toBe(post.mock.calls[0]![0]);
    expect(JSON.stringify(post.mock.calls[1]![0])).toBe(
      JSON.stringify(post.mock.calls[0]![0]),
    );
  });
  it('starts a fresh keyed request after a known snapshot read fails', async () => {
    const snapshotRead = vi
      .fn()
      .mockRejectedValueOnce(new Error('TEST invalid snapshot'))
      .mockResolvedValue(snapshot());
    const { instance, api } = setup({ weatherSnapshot: snapshotRead });
    await instance.activateWeather();
    expect(instance.getSnapshot().weatherStatus).toBe('unavailable');
    await instance.refreshWeather();
    expect(instance.getSnapshot().weatherStatus).toBe('ready');
    expect(api.requestWeather).toHaveBeenCalledTimes(2);
    const first = vi.mocked(api.requestWeather).mock.calls[0]![0];
    const second = vi.mocked(api.requestWeather).mock.calls[1]![0];
    expect(second.clientMutationId).not.toBe(first.clientMutationId);
    expect(second.refresh).toBe(true);
  });
  it('performs at most fifteen serial status reads and resumes only the original request', async () => {
    vi.useFakeTimers();
    const status = vi.fn(async () => request('PENDING', null));
    const { instance, api } = setup({
      requestWeather: vi.fn(async () => request('PENDING', null)),
      weatherRequestStatus: status,
    });
    const pending = instance.activateWeather();
    await vi.advanceTimersByTimeAsync(28000);
    await pending;
    expect(instance.getSnapshot().weatherStatus).toBe('pending');
    expect(status).toHaveBeenCalledTimes(15);
    expect(vi.getTimerCount()).toBe(0);
    const continuing = instance.refreshWeather();
    await vi.advanceTimersByTimeAsync(28000);
    await continuing;
    expect(api.requestWeather).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(30);
    expect(status).toHaveBeenLastCalledWith(
      id(1),
      id(7),
      expect.any(AbortSignal),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds token/network waits inside the same thirty-second query window', async () => {
    vi.useFakeTimers();
    const { instance, api } = setup({
      requestWeather: vi.fn(() => new Promise(() => {})),
    });
    const querying = instance.activateWeather();
    await vi.advanceTimersByTimeAsync(30000);
    await querying;
    expect(instance.getSnapshot().weatherStatus).toBe('unknown');
    expect(api.weatherRequestStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['NO_HISTORY', 'UNAVAILABLE', 'RATE_LIMITED', 'DISABLED'])(
    'stops polling on %s without treating it as pending',
    async (state) => {
      const { instance, api } = setup({
        requestWeather: vi.fn(async () => request(state, null)),
      });
      await instance.activateWeather();
      expect(instance.getSnapshot().weatherStatus).toBe(state);
      expect(api.weatherRequestStatus).not.toHaveBeenCalled();
      expect(api.weatherSnapshot).not.toHaveBeenCalled();
    },
  );
  it.each([
    'id',
    'projectId',
    'businessDate',
    'locationVersionId',
    'timezone',
  ] as const)(
    'rejects a mismatched snapshot %s before exposing or adopting it',
    async (field) => {
      const invalid = snapshot();
      if (field === 'id') invalid.id = id(99);
      else
        invalid.data.query[field] =
          field === 'businessDate'
            ? '2026-10-04'
            : field === 'timezone'
              ? 'Europe/Belgrade'
              : id(99);
      const { instance, referenceWeather } = setup({
        weatherSnapshot: vi.fn(async () => invalid),
      });
      expect(await instance.activateWeather()).toBe(false);
      expect(instance.getSnapshot().reference).toBeNull();
      expect(referenceWeather).not.toHaveBeenCalled();
    },
  );
  it.each(['directory', 'post', 'poll', 'snapshot'] as const)(
    'aborts %s on freezing and fences even an API that returns late',
    async (phase) => {
      const late = deferred<unknown>();
      let signal!: AbortSignal;
      const stall = vi.fn(
        (_arg: unknown, second?: unknown, third?: AbortSignal) => {
          signal = third ?? (second as AbortSignal);
          return late.promise;
        },
      );
      const { instance, api, referenceWeather } = setup({
        ...(phase === 'directory' ? { weatherLocations: stall } : {}),
        ...(phase === 'post' ? { requestWeather: stall } : {}),
        ...(phase === 'poll'
          ? {
              requestWeather: vi.fn(async () => request('PENDING', null)),
              weatherRequestStatus: stall,
            }
          : {}),
        ...(phase === 'snapshot' ? { weatherSnapshot: stall } : {}),
      });
      const querying = instance.activateWeather();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      instance.setAccess({ writable: true, locked: true });
      expect(signal.aborted).toBe(true);
      late.resolve(
        phase === 'directory'
          ? [location()]
          : phase === 'snapshot'
            ? snapshot()
            : request(),
      );
      await querying;
      expect(instance.getSnapshot().reference).toBeNull();
      expect(referenceWeather).not.toHaveBeenCalled();
      expect(instance.referenceWeather()).toBe(false);
      expect(api.weatherRequestStatus).toHaveBeenCalledTimes(
        phase === 'poll' ? 1 : 0,
      );
    },
  );
  it('fences an old scope snapshot when switching to another confirmed scope', async () => {
    const old = deferred<unknown>();
    const { instance, api } = setup({
      weatherLocations: vi.fn(async () => [
        location(),
        location(1, 'TEST-next', id(4)),
      ]),
      weatherSnapshot: vi.fn(() => old.promise),
    });
    await instance.activateWeather();
    const first = instance.selectWeatherLocation(id(3));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    api.requestWeather = vi.fn(async () => ({
      ...request('NO_HISTORY', null),
      locationVersionId: id(4),
    }));
    await instance.selectWeatherLocation(id(4));
    old.resolve(snapshot());
    await first;
    expect(instance.getSnapshot().context.locationVersionId).toBe(id(4));
    expect(instance.getSnapshot().weatherStatus).toBe('NO_HISTORY');
    expect(instance.getSnapshot().reference).toBeNull();
  });
  it('preserves same-key command identity in the port itself and respects pre-aborted input', async () => {
    const { ports, api } = setup();
    const controller = new AbortController();
    controller.abort();
    const intent: WeatherQueryIntent = {
      command: {
        projectId: id(1),
        businessDate: '2026-10-05',
        locationVersionId: id(3),
        refresh: false,
        clientMutationId: id(9),
      },
    };
    await expect(
      ports.queryWeather!(context(), intent, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.requestWeather).not.toHaveBeenCalled();
  });
});
