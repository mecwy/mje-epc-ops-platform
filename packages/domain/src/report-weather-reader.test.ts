import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { parseWeatherReferenceDraft, WEATHER_METRICS } from '@mje/contracts';
import {
  reportReader,
  readerContent,
  readerSnapshot,
  observeReportProjections,
} from './report-reader.js';
import { withReportReadContext } from './report-read-context.js';
import { blankFacts, hasFacts } from './report-rules.js';
import type { Actor } from './store-kit.js';
const projectId = '10000000-0000-4000-8000-000000000001';
const recordId = '20000000-0000-4000-8000-000000000001';
const actor: Actor = {
  orgId: 'TEST-org',
  accountId: 'TEST-account',
  personId: 'TEST-person',
  authzVersion: 1,
  decidedAt: '2026-10-06T12:00:00.000Z',
};
function fake(role: string | null, exists = true) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM "Membership"')
      ? role
        ? [{ role, projectId }]
        : []
      : sql.includes('FROM "Project"')
        ? exists
          ? [{ id: projectId, timezone: 'Europe/Belgrade' }]
          : []
        : [],
  }));
  return { query, db: { query } as unknown as PoolClient };
}
const reads = [
  'weatherLocations',
  'weatherRequest',
  'weatherSnapshot',
  'reportLocationCoordinates',
] as const;
describe('weather report read exits', () => {
  it.each(reads)(
    'denies a submitted-only reader before calling the %s helper',
    async (name) => {
      const { db, query } = fake('EXECUTIVE_READER');
      await expect(
        withReportReadContext(db, actor, (ctx) =>
          reportReader.forContext(ctx)[name](projectId, recordId),
        ),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(query).toHaveBeenCalledTimes(2);
    },
  );
  it('verifies membership even for an empty current location list', async () => {
    const { db, query } = fake(null);
    await expect(
      withReportReadContext(db, actor, (ctx) =>
        reportReader.forContext(ctx).weatherLocations(projectId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('verifies tenant project existence before an empty lookup', async () => {
    const { db, query } = fake('PROJECT_MANAGER', false);
    await expect(
      withReportReadContext(db, actor, (ctx) =>
        reportReader.forContext(ctx).weatherLocations(projectId),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('serves an authorized empty list via its registered projector', async () => {
    const { db, query } = fake('PROJECT_MANAGER');
    const seen: string[] = [];
    observeReportProjections((p) => seen.push(p));
    try {
      expect(
        await withReportReadContext(db, actor, (ctx) =>
          reportReader.forContext(ctx).weatherLocations(projectId),
        ),
      ).toEqual([]);
      expect(seen).toEqual(['report.weatherLocations']);
      expect(query).toHaveBeenLastCalledWith(
        expect.stringContaining('FROM "WeatherLocationVersion"'),
        [actor.orgId, projectId],
      );
    } finally {
      observeReportProjections(null);
    }
  });
  it('keeps optional safe extension facts distinct from a legacy blank report', () => {
    expect(blankFacts()).not.toHaveProperty('weatherReferences');
    expect(hasFacts(blankFacts())).toBe(false);
    expect(
      hasFacts({
        ...blankFacts(),
        weatherReferences: [
          { snapshotId: recordId, locationVersionId: projectId },
        ],
      }),
    ).toBe(true);
  });
  it('retains exact frozen weather refs alongside C06 and other snapshot extensions without re-querying', () => {
    const weatherReference = {
      referenceId: recordId,
      snapshotId: recordId,
      locationVersionId: projectId,
      adoptedAt: actor.decidedAt,
      adoptedByAccountId: 'TEST-account',
      adoptedByPersonId: 'TEST-person',
      adapterVersion: 'TEST-adapter-v1',
      responseHash: 'TEST-hash',
      sourceLink: 'https://example.test/source',
      licenseLink: 'https://example.test/license',
      snapshot: parseWeatherReferenceDraft(
        {
          provider: 'open-meteo',
          query: {
            projectId,
            locationVersionId: projectId,
            businessDate: '2026-10-05',
            timezone: 'Europe/Belgrade',
            point: { lat: '45.000000', lon: '19.000000' },
            interval: {
              startAt: '2026-10-04T22:00:00Z',
              endAt: '2026-10-05T22:00:00Z',
            },
            product: 'historical-weather',
            model: 'era5',
          },
          category: 'reanalysis',
          fetchedAt: actor.decidedAt,
          publishedAt: null,
          coverage: 'complete',
          grid: null,
          metrics: Object.fromEntries(
            WEATHER_METRICS.map((key) => [
              key,
              { state: 'value', value: '0', raw: '0.000', unit: 'TEST-unit' },
            ]),
          ),
        },
        actor.decidedAt,
      ),
    };
    const snapshot = {
      facts: blankFacts(),
      weatherReferences: [weatherReference],
      personnelSummary: undefined,
      items: [],
      nextPlan: { status: 'none', n: null, rows: [] },
      coverage: { missing: [], invalid: [] },
      extension: { test: 'untouched' },
    };
    const before = structuredClone(snapshot);
    expect(readerContent(snapshot, []).weatherReferences).toEqual([
      weatherReference,
    ]);
    expect(readerSnapshot(snapshot)['extension']).toEqual({
      test: 'untouched',
    });
    expect(readerSnapshot(snapshot)['weatherReferences']).toEqual(
      snapshot.weatherReferences,
    );
    expect(snapshot).toEqual(before);
    expect(readerContent(null, [])).not.toHaveProperty('weatherReferences');
    expect(readerSnapshot({ extension: 'TEST-legacy' })).not.toHaveProperty(
      'weatherReferences',
    );
  });
});
