import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReportLocationCandidate } from '@mje/contracts';
import { createBrowserLocationPorts } from './browser-location-ports.js';
import type { GeoSource } from './geo.js';
import { WeatherLocationSession } from './weather-location-session.js';

// Synthetic TEST browser readings only; no real GPS or provider is invoked.
const reading = {
  coords: {
    latitude: 45.12345678901234,
    longitude: 19.01,
    accuracy: 12.345678,
  },
  timestamp: 0,
};
function source() {
  let success!: Parameters<GeoSource['watchPosition']>[0];
  let failure!: Parameters<GeoSource['watchPosition']>[1];
  const geo: GeoSource = {
    watchPosition: vi.fn(function (this: GeoSource, onFix, onError) {
      expect(this).toBe(geo);
      success = onFix;
      failure = onError;
      return 71;
    }),
    clearWatch: vi.fn(function (this: GeoSource) {
      expect(this).toBe(geo);
    }),
  };
  return { geo, fix: () => success(reading), deny: () => failure({ code: 1 }) };
}
function session(ports: ReturnType<typeof createBrowserLocationPorts>) {
  const confirm = vi.fn(() => true);
  const instance = new WeatherLocationSession(
    {
      ownerKey: 'TEST-owner',
      projectId: 'TEST-project',
      businessDate: '2026-10-06',
      timezone: 'Europe/Belgrade',
      locationVersionId: ports.locationVersionId ?? null,
    },
    {
      loadWeather: ports.loadWeather!,
      locate: ports.locate!,
      acceptLocation: parseReportLocationCandidate,
      confirmLocation: confirm,
      referenceWeather: vi.fn(() => false),
    },
    { writable: true, locked: false },
  );
  return { instance, confirm };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('active browser report location ports', () => {
  it('construction and session mounting/weather refresh do not read GPS', async () => {
    const getGeolocation = vi.fn(() => source().geo);
    const ports = createBrowserLocationPorts(getGeolocation);
    const { instance, confirm } = session(ports);
    expect(ports.locationVersionId).toBeNull();
    expect(await instance.refreshWeather()).toBe(false);
    expect(instance.getSnapshot().weatherStatus).toBe('not_configured');
    expect(getGeolocation).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    await expect(
      ports.loadWeather!(
        instance.getSnapshot().context,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/^WEATHER_DISABLED$/);
    expect(getGeolocation).not.toHaveBeenCalled();
  });
  it('uses the real navigator capability lazily and preserves its method receiver', async () => {
    const test = source();
    const getter = vi.fn(() => test.geo);
    const nav = Object.defineProperty({}, 'geolocation', { get: getter });
    vi.stubGlobal('navigator', nav);
    const ports = createBrowserLocationPorts();
    expect(getter).not.toHaveBeenCalled();
    const pending = ports.locate!(new AbortController().signal);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(test.geo.watchPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 },
    );
    test.fix();
    expect(await pending).toMatchObject({
      kind: 'fix',
      reading: {
        lat: '45.12345678901234',
        accuracyM: '12.345678',
        deviceFixAt: null,
      },
    });
    expect(test.geo.clearWatch).toHaveBeenCalledWith(71);
  });
  it('only explicit confirmation passes a candidate into the parent draft', async () => {
    const test = source();
    const { instance, confirm } = session(
      createBrowserLocationPorts(() => test.geo),
    );
    const pending = instance.captureLocation();
    test.fix();
    expect(await pending).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(instance.getSnapshot().locationStatus).toBe('candidate');
    expect(instance.confirmLocation()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual([
      expect.objectContaining({
        projectId: 'TEST-project',
        businessDate: '2026-10-06',
      }),
      expect.objectContaining({
        lat: '45.12345678901234',
        accuracyM: '12.345678',
      }),
    ]);
    expect(instance.getSnapshot().locationStatus).toBe(
      'confirmed_pending_save',
    );
  });
  it.each([null, undefined])(
    'unsupported capability %s preserves manual workflow',
    async (geo) => {
      expect(
        await createBrowserLocationPorts(() => geo).locate!(
          new AbortController().signal,
        ),
      ).toEqual({ kind: 'unsupported' });
    },
  );
  it('also works when navigator is absent', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(
      await createBrowserLocationPorts().locate!(new AbortController().signal),
    ).toEqual({ kind: 'unsupported' });
  });
  it('maps permission denial using the existing acquisition contract', async () => {
    const test = source();
    const pending = createBrowserLocationPorts(() => test.geo).locate!(
      new AbortController().signal,
    );
    test.deny();
    expect(await pending).toEqual({ kind: 'denied' });
    expect(test.geo.clearWatch).toHaveBeenCalledWith(71);
  });
  it('an already cancelled capture does not even read the GPS capability', async () => {
    const getGeolocation = vi.fn(() => source().geo);
    const controller = new AbortController();
    controller.abort();
    expect(
      await createBrowserLocationPorts(getGeolocation).locate!(
        controller.signal,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(getGeolocation).not.toHaveBeenCalled();
  });
  it('cancelling the existing session releases the watch and rejects late fixes', async () => {
    const test = source();
    const { instance, confirm } = session(
      createBrowserLocationPorts(() => test.geo),
    );
    const pending = instance.captureLocation();
    instance.cancelLocation();
    test.fix();
    expect(await pending).toBe(false);
    expect(instance.getSnapshot().candidate).toBeNull();
    expect(instance.confirmLocation()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(test.geo.clearWatch).toHaveBeenCalledWith(71);
  });
  it('preserves the existing eight second acquisition limit', async () => {
    vi.useFakeTimers();
    const test = source();
    const pending = createBrowserLocationPorts(() => test.geo).locate!(
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(test.geo.clearWatch).toHaveBeenCalledWith(71);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('capability access failure returns a safe unavailable result', async () => {
    const ports = createBrowserLocationPorts(() => {
      throw new Error('TEST-device-details');
    });
    expect(await ports.locate!(new AbortController().signal)).toEqual({
      kind: 'unavailable',
    });
  });
  it('read-only or locked session never invokes a capture port', async () => {
    const getter = vi.fn(() => source().geo);
    const { instance } = session(createBrowserLocationPorts(getter));
    instance.setAccess({ writable: false, locked: false });
    expect(await instance.captureLocation()).toBe(false);
    instance.setAccess({ writable: true, locked: true });
    expect(await instance.captureLocation()).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
