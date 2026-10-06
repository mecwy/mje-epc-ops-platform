import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  parseReportLocationCandidate,
  parseWeatherQuery,
  parseWeatherReferenceDraft,
  type ReportLocationCandidateDto,
} from '@mje/contracts';
import { WeatherLocation } from './WeatherLocation.js';
import {
  WeatherLocationSession,
  type LocationCandidate,
  type LocateInput,
  type WeatherContext,
  type WeatherLocationDependencies,
  type WeatherReferenceView,
} from './weather-location-session.js';

// Synthetic TEST presentation adapters; no GPS, browser, DB or real provider is used.
const context = (): WeatherContext => ({
  ownerKey: 'TEST-owner',
  projectId: 'TEST-project',
  businessDate: '2026-10-05',
  timezone: 'Europe/Belgrade',
  locationVersionId: 'TEST-location-v1',
});
const candidate = (): LocationCandidate => ({
  lat: '45.000000',
  lon: '19.000000',
  accuracyM: '200.00',
  deviceFixAt: null,
  acquiredAt: '2026-10-06T12:00:00Z',
});
const reference = (): WeatherReferenceView => ({
  projectId: 'TEST-project',
  businessDate: '2026-10-05',
  timezone: 'Europe/Belgrade',
  locationVersionId: 'TEST-location-v1',
  snapshotId: 'TEST-weather-v1',
  source: 'TEST Open-Meteo',
  category: 'reanalysis',
  fetchedAt: '2026-10-06T12:00:00Z',
  publishedAt: null,
  interval: { startAt: '2026-10-04T22:00:00Z', endAt: '2026-10-05T22:00:00Z' },
  coverage: 'partial',
  stale: false,
  values: [
    { label: 'TEST rain', state: 'value', value: '0', unit: 'mm' },
    { label: 'TEST wind', state: 'missing', value: null, unit: 'm/s' },
  ],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function setup(
  overrides: Partial<WeatherLocationDependencies> = {},
  ctx = context(),
) {
  const dependencies: WeatherLocationDependencies = {
    loadWeather: vi.fn(async () => reference()),
    locate: vi.fn(async (): Promise<LocateInput> => ({
      kind: 'fix',
      reading: candidate(),
    })),
    acceptLocation: (input) => input as LocationCandidate,
    confirmLocation: vi.fn(() => true),
    referenceWeather: vi.fn(() => true),
    ...overrides,
  };
  return {
    dependencies,
    session: new WeatherLocationSession(ctx, dependencies, {
      writable: true,
      locked: false,
    }),
  };
}
afterEach(() => vi.useRealTimers());

// TEST consumer projection: decode the boundary DTO before exposing presentation fields.
// A synthetic snapshot identity is supplied here; no server snapshot exists in this test.
const codecContext = (): WeatherContext => ({
  ...context(),
  projectId: '10000000-0000-4000-8000-000000000001',
  locationVersionId: '10000000-0000-4000-8000-000000000002',
});
function codecReference(ctx: Readonly<WeatherContext>): WeatherReferenceView {
  const query = parseWeatherQuery(
    {
      projectId: ctx.projectId,
      locationVersionId: ctx.locationVersionId,
      businessDate: ctx.businessDate,
      timezone: ctx.timezone,
      point: { lat: '45.000000', lon: '19.000000' },
      interval: reference().interval,
      product: 'historical-weather',
      model: 'era5',
    },
    '2026-10-06T12:00:00Z',
  );
  const dto = parseWeatherReferenceDraft({
    provider: 'open-meteo',
    query,
    category: 'reanalysis',
    fetchedAt: '2026-10-06T12:00:00Z',
    publishedAt: null,
    coverage: 'partial',
    grid: null,
    metrics: {
      condition: {
        state: 'unknown',
        raw: '?',
        unit: null,
        reason: 'TEST unknown',
      },
      temperatureMin: {
        state: 'blank',
        raw: '',
        unit: '°C',
        reason: 'TEST blank',
      },
      temperatureMax: {
        state: 'missing',
        raw: null,
        unit: '°C',
        reason: 'TEST absent',
      },
      precipitation: { state: 'value', value: '0', raw: '0.00', unit: 'mm' },
      windMax: {
        state: 'not_applicable',
        raw: 'N/A',
        unit: null,
        reason: 'TEST NA',
      },
      gustMax: {
        state: 'missing',
        raw: null,
        unit: 'm/s',
        reason: 'TEST absent',
      },
    },
  });
  return {
    ...reference(),
    projectId: dto.query.projectId,
    businessDate: dto.query.businessDate,
    timezone: dto.query.timezone,
    locationVersionId: dto.query.locationVersionId,
    category: dto.category,
    fetchedAt: dto.fetchedAt,
    publishedAt: dto.publishedAt,
    interval: dto.query.interval,
    coverage: dto.coverage,
    values: Object.entries(dto.metrics).map(([label, metric]) => ({
      label,
      state: metric.state,
      value: metric.state === 'value' ? metric.value : null,
      unit: metric.unit,
    })),
  };
}

describe('formal codec consumer boundary', () => {
  it('decodes a deliberate fix into the parent pending draft, preserving unknown device time', async () => {
    let pendingDraft: ReportLocationCandidateDto | null = null;
    const confirmLocation = vi.fn(
      (ctx: Readonly<WeatherContext>, fix: Readonly<LocationCandidate>) => {
        expect(ctx).toEqual(codecContext());
        pendingDraft = parseReportLocationCandidate(fix);
        return true;
      },
    );
    const { session } = setup(
      { acceptLocation: parseReportLocationCandidate, confirmLocation },
      codecContext(),
    );
    expect(await session.captureLocation()).toBe(true);
    expect(pendingDraft).toBeNull();
    expect(session.confirmLocation()).toBe(true);
    expect(pendingDraft).toEqual(candidate());
    expect(session.getSnapshot().locationStatus).toBe('confirmed_pending_save');
    // Parent acceptance above has no save API, receipt timestamp or persistence outcome.
    expect(confirmLocation).toHaveBeenCalledTimes(1);
  });
  it('rejects a malformed fix through the real location codec before parent adoption', async () => {
    const { session, dependencies } = setup(
      {
        acceptLocation: parseReportLocationCandidate,
        locate: async () => ({
          kind: 'fix',
          reading: { ...candidate(), lat: '91' },
        }),
      },
      codecContext(),
    );
    expect(await session.captureLocation()).toBe(false);
    expect(session.getSnapshot().candidate).toBeNull();
    expect(session.getSnapshot().locationStatus).toBe('unavailable');
    expect(session.confirmLocation()).toBe(false);
    expect(dependencies.confirmLocation).not.toHaveBeenCalled();
  });
  it('projects codec-validated reference states without treating unknowns as zero or receipt as business day', async () => {
    const { session, dependencies } = setup(
      {
        acceptLocation: parseReportLocationCandidate,
        loadWeather: async (ctx) => codecReference(ctx),
      },
      codecContext(),
    );
    expect(await session.refreshWeather()).toBe(true);
    const ref = session.getSnapshot().reference!;
    expect(ref.businessDate).toBe('2026-10-05');
    expect(ref.fetchedAt).toBe('2026-10-06T12:00:00Z');
    expect(ref.publishedAt).toBeNull();
    expect(ref.values.map((v) => [v.state, v.value])).toEqual([
      ['unknown', null],
      ['blank', null],
      ['missing', null],
      ['value', '0'],
      ['not_applicable', null],
      ['missing', null],
    ]);
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
    expect(session.referenceWeather()).toBe(true);
    expect(dependencies.referenceWeather).toHaveBeenCalledWith(
      codecContext(),
      ref.snapshotId,
    );
  });
  it.each([
    { writable: true, locked: true },
    { writable: false, locked: false },
  ])(
    'parent access %j fences location and adoption while retaining permitted reference reads',
    async (access) => {
      const geo = deferred<LocateInput>();
      const weather = deferred<WeatherReferenceView>();
      const { session, dependencies } = setup(
        {
          acceptLocation: parseReportLocationCandidate,
          locate: () => geo.promise,
          loadWeather: () => weather.promise,
        },
        codecContext(),
      );
      const capturing = session.captureLocation();
      const reading = session.refreshWeather();
      session.setAccess(access);
      geo.resolve({ kind: 'fix', reading: candidate() });
      weather.resolve(codecReference(codecContext()));
      expect(await capturing).toBe(false);
      expect(await reading).toBe(access.writable);
      expect(session.getSnapshot().candidate).toBeNull();
      expect(session.getSnapshot().reference).toEqual(
        access.writable ? codecReference(codecContext()) : null,
      );
      expect(session.confirmLocation()).toBe(false);
      expect(session.referenceWeather()).toBe(false);
      expect(dependencies.confirmLocation).not.toHaveBeenCalled();
      expect(dependencies.referenceWeather).not.toHaveBeenCalled();
    },
  );
  it('rejects a valid codec response belonging to another parent project', async () => {
    const other = {
      ...codecContext(),
      projectId: '10000000-0000-4000-8000-000000000003',
    };
    const { session, dependencies } = setup(
      {
        acceptLocation: parseReportLocationCandidate,
        loadWeather: async () => codecReference(other),
      },
      codecContext(),
    );
    expect(await session.refreshWeather()).toBe(false);
    expect(session.getSnapshot().weatherStatus).toBe('unavailable');
    expect(session.referenceWeather()).toBe(false);
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
  });
  it('retains the new parent context when the old codec response arrives after switching days', async () => {
    const old = deferred<WeatherReferenceView>();
    const { session } = setup(
      {
        acceptLocation: parseReportLocationCandidate,
        loadWeather: () => old.promise,
      },
      codecContext(),
    );
    const pending = session.refreshWeather();
    const next = { ...codecContext(), businessDate: '2026-10-04' };
    session.setContext(next);
    old.resolve(codecReference(codecContext()));
    expect(await pending).toBe(false);
    expect(session.getSnapshot().context).toEqual(next);
    expect(session.getSnapshot().reference).toBeNull();
  });
});

describe('one-day weather/location session', () => {
  it('never captures location during construction or weather read', async () => {
    const { session, dependencies } = setup();
    await session.refreshWeather();
    expect(dependencies.locate).not.toHaveBeenCalled();
    expect(dependencies.confirmLocation).not.toHaveBeenCalled();
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
  });
  it.each(['denied', 'unsupported', 'unavailable'] as const)(
    'keeps %s fail-visible without confirming a fix',
    async (kind) => {
      const { session, dependencies } = setup({
        locate: async () => ({ kind }),
      });
      expect(await session.captureLocation()).toBe(false);
      expect(session.getSnapshot().locationStatus).toBe(kind);
      expect(session.editable).toBe(true);
      expect(session.confirmLocation()).toBe(false);
      expect(dependencies.confirmLocation).not.toHaveBeenCalled();
    },
  );
  it('requires deliberate confirmation; poor precision is retained, not corrected', async () => {
    const { session, dependencies } = setup();
    expect(await session.captureLocation()).toBe(true);
    expect(dependencies.confirmLocation).not.toHaveBeenCalled();
    expect(session.getSnapshot().candidate).toEqual(candidate());
    expect(session.confirmLocation()).toBe(true);
    expect(session.getSnapshot().locationStatus).toBe('confirmed_pending_save');
    expect(dependencies.confirmLocation).toHaveBeenCalledWith(
      context(),
      candidate(),
    );
  });
  it('parent rejection or exception leaves the candidate available', async () => {
    const { session, dependencies } = setup({
      confirmLocation: vi.fn(() => false),
    });
    await session.captureLocation();
    expect(session.confirmLocation()).toBe(false);
    expect(session.getSnapshot().candidate).toEqual(candidate());
    dependencies.confirmLocation = () => {
      throw new Error('TEST busy');
    };
    expect(session.confirmLocation()).toBe(false);
    expect(session.getSnapshot().candidate).toEqual(candidate());
  });
  it('cancel aborts capture and drops a late location result', async () => {
    const d = deferred<LocateInput>();
    let signal!: AbortSignal;
    const { session, dependencies } = setup({
      locate: (s) => {
        signal = s;
        return d.promise;
      },
    });
    const pending = session.captureLocation();
    session.cancelLocation();
    expect(signal.aborted).toBe(true);
    d.resolve({ kind: 'fix', reading: candidate() });
    expect(await pending).toBe(false);
    expect(session.getSnapshot().candidate).toBeNull();
    expect(dependencies.confirmLocation).not.toHaveBeenCalled();
  });
  it.each([
    'businessDate',
    'projectId',
    'ownerKey',
    'locationVersionId',
    'timezone',
  ] as const)(
    'changing %s fences late capture and weather responses',
    async (field) => {
      const geo = deferred<LocateInput>();
      const weather = deferred<WeatherReferenceView>();
      const { session } = setup({
        locate: () => geo.promise,
        loadWeather: () => weather.promise,
      });
      const g = session.captureLocation();
      const w = session.refreshWeather();
      const next = { ...context(), [field]: 'TEST-changed' };
      session.setContext(next);
      geo.resolve({ kind: 'fix', reading: candidate() });
      weather.resolve(reference());
      await Promise.all([g, w]);
      expect(session.getSnapshot().context).toEqual(next);
      expect(session.getSnapshot().candidate).toBeNull();
      expect(session.getSnapshot().reference).toBeNull();
    },
  );
  it('newer refresh survives the older response in either order', async () => {
    const old = deferred<WeatherReferenceView>();
    const newer = deferred<WeatherReferenceView>();
    const loadWeather = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(newer.promise);
    const { session } = setup({ loadWeather });
    const a = session.refreshWeather();
    const b = session.refreshWeather();
    newer.resolve({ ...reference(), snapshotId: 'TEST-weather-v2' });
    await b;
    old.resolve(reference());
    await a;
    expect(session.getSnapshot().reference?.snapshotId).toBe('TEST-weather-v2');
  });
  it('a provider/context mismatch is unavailable and cannot be adopted', async () => {
    const { session, dependencies } = setup({
      loadWeather: async () => ({ ...reference(), businessDate: '2026-10-06' }),
    });
    expect(await session.refreshWeather()).toBe(false);
    expect(session.getSnapshot().weatherStatus).toBe('unavailable');
    expect(session.referenceWeather()).toBe(false);
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
  });
  it('no configured site point prevents query but not manual editing or one-shot capture', async () => {
    const { session, dependencies } = setup(
      {},
      { ...context(), locationVersionId: null },
    );
    expect(await session.refreshWeather()).toBe(false);
    expect(dependencies.loadWeather).not.toHaveBeenCalled();
    expect(session.editable).toBe(true);
    expect(await session.captureLocation()).toBe(true);
  });
  it('unavailable reference does not lock the parent/manual save path', async () => {
    const { session } = setup({
      loadWeather: async () => {
        throw new Error('TEST offline');
      },
    });
    await session.refreshWeather();
    expect(session.editable).toBe(true);
    expect(session.getSnapshot().weatherStatus).toBe('unavailable');
  });
  it('adoption is explicit and a refresh does not replace its selected snapshot', async () => {
    const { session, dependencies } = setup();
    await session.refreshWeather();
    expect(session.referenceWeather()).toBe(true);
    dependencies.loadWeather = async () => ({
      ...reference(),
      snapshotId: 'TEST-weather-v2',
    });
    await session.refreshWeather();
    expect(session.getSnapshot().referencedSnapshotId).toBe('TEST-weather-v1');
    expect(dependencies.referenceWeather).toHaveBeenCalledTimes(1);
  });
  it('an expired reference is labeled and cannot silently be newly referenced', async () => {
    const { session, dependencies } = setup({
      loadWeather: async () => ({ ...reference(), stale: true }),
    });
    await session.refreshWeather();
    expect(session.referenceWeather()).toBe(false);
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
  });
  it('read-only or day-locked inputs block capture, adoption and parent mutations', async () => {
    const { session, dependencies } = setup();
    await session.refreshWeather();
    await session.captureLocation();
    session.setAccess({ writable: true, locked: true });
    expect(session.confirmLocation()).toBe(false);
    expect(session.referenceWeather()).toBe(false);
    expect(await session.captureLocation()).toBe(false);
    expect(await session.refreshWeather()).toBe(false);
    session.setAccess({ writable: false, locked: false });
    expect(dependencies.confirmLocation).not.toHaveBeenCalled();
    expect(dependencies.referenceWeather).not.toHaveBeenCalled();
  });
  it('one-shot timeout aborts the injected locator and leaves manual editing available', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const { session } = setup({
      locate: (s) => {
        signal = s;
        return new Promise(() => {});
      },
    });
    const pending = session.captureLocation();
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(session.getSnapshot().locationStatus).toBe('unavailable');
    expect(session.editable).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('mutating an adapter result cannot rewrite the displayed reference', async () => {
    const input = reference();
    const { session } = setup({ loadWeather: async () => input });
    await session.refreshWeather();
    input.values[0]!.value = '99';
    expect(session.getSnapshot().reference?.values[0]?.value).toBe('0');
  });
});

describe('isolated WeatherLocation presentation', () => {
  it.each(['zh', 'en'] as const)(
    'shows manual input, zero/missing and provenance in %s',
    async (locale) => {
      const { session } = setup();
      await session.refreshWeather();
      const html = renderToStaticMarkup(
        createElement(WeatherLocation, {
          session,
          locale,
          manualWeather: 'TEST onsite <rain>',
          manualTemperature: 'TEST unknown',
          onManualChange: vi.fn(),
        }),
      );
      expect(html).toContain('0 mm');
      expect(html).toContain(locale === 'zh' ? '未提供' : 'Not provided');
      expect(html).toContain('2026-10-05');
      expect(html).toContain('2026-10-06T12:00:00Z');
      expect(html).toContain('TEST onsite &lt;rain&gt;');
      expect(html).toContain(locale === 'zh' ? '安全放行' : 'work permission');
    },
  );
  it('weather reads never change the parent manual values', async () => {
    const change = vi.fn();
    const { session } = setup();
    await session.refreshWeather();
    await session.captureLocation();
    session.confirmLocation();
    renderToStaticMarkup(
      createElement(WeatherLocation, {
        session,
        locale: 'en',
        manualWeather: 'TEST manual',
        manualTemperature: '',
        onManualChange: change,
      }),
    );
    expect(change).not.toHaveBeenCalled();
  });
  it('read-only presentation has no capture or adoption buttons', () => {
    const { session } = setup();
    session.setAccess({ writable: false, locked: false });
    const html = renderToStaticMarkup(
      createElement(WeatherLocation, {
        session,
        locale: 'en',
        manualWeather: '',
        manualTemperature: '',
        onManualChange: vi.fn(),
      }),
    );
    expect(html).not.toContain('Locate once');
    expect(html).not.toContain('Reference this snapshot');
    expect(html).toContain('disabled');
  });
});
