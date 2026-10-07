/** Synthetic TEST forecast provenance, real report exits and finite job completion; no network/DB. */
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  WEATHER_METRICS,
  parseWeatherReferenceDraft,
  type WeatherReferenceDraftDto,
} from '@mje/contracts';
import { FIELDS } from './fields.js';
import { decide } from './interpret.js';
import { SURFACE } from './surface.js';
import { readerSnapshot, reportReader } from '../report-reader.js';
import { withReportReadContext } from '../report-read-context.js';
import type { Actor } from '../store-kit.js';
import {
  finishWeatherJob,
  type WeatherJobLease,
  type WeatherSnapshotMetadata,
} from '../weather-jobs.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: Actor = {
  orgId: id(1),
  accountId: id(2),
  personId: id(3),
  authzVersion: 1,
  decidedAt: '2026-10-07T10:00:00Z',
};
const metadata: WeatherSnapshotMetadata = {
  adapterVersion: 'met-norway-locationforecast-v1',
  sourceLink:
    'https://api.met.no/weatherapi/locationforecast/2.0/documentation',
  licenseLink: 'https://api.met.no/doc/License',
};
function draft(): WeatherReferenceDraftDto {
  const metric = {
    state: 'not_applicable',
    raw: null,
    unit: null,
    reason: 'not_daily',
  } as const;
  return parseWeatherReferenceDraft({
    provider: 'met-norway',
    query: {
      projectId: id(4),
      locationVersionId: id(5),
      businessDate: '2026-10-07',
      timezone: 'UTC',
      point: { lat: '45.123456', lon: '19.987654' },
      interval: {
        startAt: '2026-10-07T00:00:00Z',
        endAt: '2026-10-08T00:00:00Z',
      },
      product: 'forecast',
      model: 'forecast',
    },
    category: 'forecast',
    fetchedAt: '2026-10-07T10:00:00Z',
    publishedAt: null,
    coverage: 'partial',
    grid: null,
    metrics: Object.fromEntries(WEATHER_METRICS.map((k) => [k, metric])),
    forecast: {
      providerUpdatedAt: '2026-10-07T09:00:00Z',
      outboundPoint: { lat: '45.1234', lon: '19.9876' },
      returnedPoint: { lat: '45.1235', lon: '19.9877' },
      coveredInterval: {
        startAt: '2026-10-07T10:00:00Z',
        endAt: '2026-10-07T16:00:00Z',
      },
      instants: [
        {
          at: '2026-10-07T10:00:00Z',
          airTemperature: {
            state: 'value',
            value: '0',
            raw: '0',
            unit: 'celsius',
          },
          windSpeed: { state: 'value', value: '2.5', raw: '2.5', unit: 'm/s' },
          gust: {
            state: 'unknown',
            raw: null,
            unit: null,
            reason: 'not_reported',
          },
        },
      ],
      periods: [1, 6].map((hours) => ({
        startAt: '2026-10-07T10:00:00Z',
        endAt: hours === 1 ? '2026-10-07T11:00:00Z' : '2026-10-07T16:00:00Z',
        hours,
        symbolCode: 'rain',
        precipitation: { state: 'value', value: '0', raw: '0', unit: 'mm' },
      })),
    },
  });
}
const lease = (): WeatherJobLease => ({
  orgId: actor.orgId,
  requestId: id(6),
  eventId: id(7),
  token: id(8),
  query: draft().query,
  attempts: 1,
});
const snapshot = () => ({
  id: id(9),
  data: draft(),
  ...metadata,
  responseHash: 'a'.repeat(64),
});
function jobPool(owned = true) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => ({
    rows:
      sql.includes('FROM "WeatherRequest"') &&
      owned &&
      values[0] === actor.orgId &&
      values[2] === id(8)
        ? [{ query: draft().query, attempts: 1 }]
        : [],
  }));
  const release = vi.fn();
  return {
    query,
    release,
    pool: { connect: async () => ({ query, release }) } as unknown as Pool,
  };
}
function reportClient(role: string | null = 'PROJECT_MANAGER') {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const inScope =
      values[0] === actor.orgId &&
      (sql.includes('Membership') ? values[2] : values[1]) === id(4);
    let rows: Record<string, unknown>[] = [];
    if (inScope && sql.includes('FROM "Membership"') && role)
      rows = [{ role, projectId: id(4) }];
    if (inScope && sql.includes('FROM "Project"'))
      rows = [{ id: id(4), name: 'TEST site', code: 'TEST', timezone: 'UTC' }];
    if (inScope && sql.includes('FROM "WeatherSnapshot"')) rows = [snapshot()];
    return { rows };
  });
  return { query, client: { query } as unknown as PoolClient };
}
const entry = (route: string) => {
  const found = SURFACE.find((e) => e.entry === route);
  if (!found) throw new Error('TEST missing registered weather route');
  return found;
};

describe('forecast fields retain submitted site provenance without personal coordinates', () => {
  it('classifies both current and frozen forecast branches identically in submitted', () => {
    const current =
      FIELDS['report.weatherSnapshot'].fields.data.fields.forecast;
    const frozen =
      FIELDS['report.day.reader'].fields.weatherReferences.items.snapshot.fields
        .forecast;
    expect(current).toEqual(frozen);
    expect(current.layer).toBe('submitted');
    expect(Object.keys(current.fields).sort()).toEqual(
      [
        'providerUpdatedAt',
        'outboundPoint',
        'returnedPoint',
        'coveredInterval',
        'instants',
        'periods',
      ].sort(),
    );
    expect(current.fields.outboundPoint).toEqual({ subtree: 'submitted' });
    expect(current.fields.returnedPoint).toEqual({ subtree: 'submitted' });
    expect(current.fields.instants.items).toEqual({
      at: { layer: 'submitted' },
      airTemperature: { subtree: 'submitted' },
      windSpeed: { subtree: 'submitted' },
      gust: { subtree: 'submitted' },
    });
    expect(current.fields.periods.items).toEqual({
      startAt: { layer: 'submitted' },
      endAt: { layer: 'submitted' },
      hours: { layer: 'submitted' },
      symbolCode: { layer: 'submitted' },
      precipitation: { subtree: 'submitted' },
    });
    expect(FIELDS['report.reportLocationCoordinates'].fields).toEqual({
      lat: { layer: 'coordinates' },
      lon: { layer: 'coordinates' },
    });
    expect(FIELDS['report.weatherLocations'].items.point).toEqual({
      subtree: 'coordinates',
    });
  });
  it('submitted reader field paths retain forecast periods but omit personal and photo exact positions', () => {
    const decision = decide(entry('GET /api/report/day'), {
      principal: 'account',
      capabilities: ['report.view-submitted'],
      scope: 'granted',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.visibleKeys).toContain(
      'weatherReferences[].snapshot.forecast.periods[].symbolCode',
    );
    expect(decision.visibleKeys).toContain(
      'weatherReferences[].snapshot.forecast.instants[].at',
    );
    expect(decision.visibleKeys).not.toContain('photos[].capture.lat');
    expect(decision.visibleKeys).not.toContain('photos[].capture.lon');
    expect(decision.visibleKeys).not.toContain('facts.reportLocationRef.lat');
  });
  it('preserves original frozen UTC series/units/site points without mutating history', () => {
    const old = {
      weatherReferences: [{ ...snapshot(), snapshot: draft() }],
      foreman: { TEST: 'private' },
    };
    const before = structuredClone(old);
    const frozen = readerSnapshot(old);
    expect(frozen['weatherReferences']).toEqual(before.weatherReferences);
    expect(frozen).not.toHaveProperty('foreman');
    expect(old).toEqual(before);
    expect(readerSnapshot({ weatherReferences: [] })).toEqual({
      weatherReferences: [],
    });
  });
  it('the actual live writer exit returns the original parsed MET snapshot with tenant/project predicates', async () => {
    const { client, query } = reportClient();
    const result = await withReportReadContext(client, actor, (ctx) =>
      reportReader.forContext(ctx).weatherSnapshot(id(4), id(9)),
    );
    expect(result).toEqual(snapshot());
    const call = query.mock.calls.find(([sql]) =>
      sql.includes('FROM "WeatherSnapshot"'),
    );
    expect(call?.[1]).toEqual([actor.orgId, id(4), id(9)]);
  });
  it.each([null, 'EXECUTIVE_READER'])(
    'role %s cannot read live MET even when a snapshot exists',
    async (role) => {
      const { client, query } = reportClient(role);
      await expect(
        withReportReadContext(client, actor, (ctx) =>
          reportReader.forContext(ctx).weatherSnapshot(id(4), id(9)),
        ),
      ).rejects.toMatchObject({ code: role ? 'READ_ONLY' : 'FORBIDDEN' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('WeatherSnapshot')),
      ).toBe(false);
    },
  );
  it.each(['other-org', 'other-project'] as const)(
    '%s cannot read even an empty MET result',
    async (scope) => {
      const { client, query } = reportClient();
      await expect(
        withReportReadContext(
          client,
          scope === 'other-org' ? { ...actor, orgId: id(20) } : actor,
          (ctx) =>
            reportReader
              .forContext(ctx)
              .weatherSnapshot(
                scope === 'other-project' ? id(20) : id(4),
                id(9),
              ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('WeatherSnapshot')),
      ).toBe(false);
    },
  );
});

describe('finite finish preserves the actual provider metadata', () => {
  it('explicit canonical MET attribution persists together with exact parsed forecast', async () => {
    const f = jobPool();
    expect(await finishWeatherJob(f.pool, lease(), draft(), metadata)).toBe(
      true,
    );
    const values = f.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO "WeatherSnapshot"'),
    )?.[1];
    expect(JSON.parse(String(values?.[7]))).toEqual(draft());
    expect(values?.[10]).toBe(metadata.adapterVersion);
    expect(values?.slice(12, 14)).toEqual([
      metadata.sourceLink,
      metadata.licenseLink,
    ]);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(['omitted', 'adapter', 'source', 'license', 'open-meteo'] as const)(
    'rejects MET %s attribution before publishing',
    async (variant) => {
      const f = jobPool();
      const invalid =
        variant === 'omitted'
          ? undefined
          : variant === 'adapter'
            ? { ...metadata, adapterVersion: 'TEST_fake' }
            : variant === 'source'
              ? { ...metadata, sourceLink: 'https://TEST.invalid/source' }
              : variant === 'license'
                ? { ...metadata, licenseLink: 'https://TEST.invalid/license' }
                : {
                    adapterVersion: 'open-meteo-daily-v1',
                    sourceLink:
                      'https://open-meteo.com/en/docs/historical-weather-api',
                    licenseLink: 'https://open-meteo.com/en/terms',
                  };
      await expect(
        finishWeatherJob(f.pool, lease(), draft(), invalid),
      ).rejects.toThrow(/^WEATHER_STORE_FAILED$/);
      expect(
        f.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql)),
      ).toBe(false);
      expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    },
  );
  it('legacy Open-Meteo retains its default metadata without adding MET forecast', async () => {
    const met = draft();
    const { forecast: unused, ...common } =
      met.provider === 'met-norway'
        ? met
        : (() => {
            throw new Error('TEST MET required');
          })();
    expect(unused).toBeDefined();
    const legacy = parseWeatherReferenceDraft({
      ...common,
      provider: 'open-meteo',
    });
    const f = jobPool();
    expect(await finishWeatherJob(f.pool, lease(), legacy)).toBe(true);
    const values = f.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT INTO "WeatherSnapshot"'),
    )?.[1];
    expect(values?.[10]).toBe('open-meteo-daily-v1');
    expect(String(values?.[12])).toContain('open-meteo.com');
    expect(JSON.parse(String(values?.[7]))).not.toHaveProperty('forecast');
    const wrongProvider = jobPool();
    await expect(
      finishWeatherJob(wrongProvider.pool, lease(), legacy, metadata),
    ).rejects.toThrow(/^WEATHER_STORE_FAILED$/);
    expect(
      wrongProvider.query.mock.calls.some(([sql]) =>
        /^(INSERT|UPDATE)/.test(sql),
      ),
    ).toBe(false);
  });
  it.each(['expired', 'other-org', 'wrong-token'] as const)(
    '%s completion cannot publish regardless of metadata',
    async (variant) => {
      const f = jobPool(variant !== 'expired');
      const l = lease();
      if (variant === 'other-org') l.orgId = id(20);
      if (variant === 'wrong-token') l.token = id(20);
      expect(await finishWeatherJob(f.pool, l, draft(), metadata)).toBe(false);
      expect(
        f.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql)),
      ).toBe(false);
    },
  );
});
