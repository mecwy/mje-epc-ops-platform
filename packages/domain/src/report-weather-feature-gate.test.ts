import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { SaveFactsCommand } from '@mje/contracts';
import { ReportStore } from './report-store.js';
import { blankFacts } from './report-rules.js';
import { sha } from './store-kit.js';
const reference = {
  referenceId: 'TEST_reference',
  snapshotId: 'TEST_snapshot',
  locationVersionId: 'TEST_location',
};
const base: SaveFactsCommand = {
  projectId: 'TEST_project',
  businessDate: '2026-10-06',
  expectedVersion: 1,
  clientMutationId: 'TEST_key',
  facts: blankFacts(),
};
const capture: SaveFactsCommand['reportLocationOperation'] = {
  kind: 'capture',
  candidate: {
    lat: '45.1',
    lon: '19.1',
    accuracyM: '10',
    deviceFixAt: null,
    acquiredAt: '2026-10-06T12:00:00Z',
  },
  clientConfirmedAt: '2026-10-06T12:00:00Z',
};
function fake(
  command: SaveFactsCommand,
  role = 'PROJECT_MANAGER',
  previous = [reference],
) {
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes('app_account_for_identity')
      ? [
          {
            id: 'TEST_account',
            orgId: 'TEST_org',
            personId: 'TEST_person',
            authzVersion: 1,
          },
        ]
      : sql.includes('clock_timestamp')
        ? [{ decidedAt: '2026-10-06T12:00:00Z' }]
        : sql.includes('FROM "Membership"')
          ? [{ role, projectId: 'TEST_project' }]
          : sql.includes('FROM "Project"')
            ? [{ id: 'TEST_project', timezone: 'Europe/Belgrade' }]
            : sql.includes('FROM "DailyClose"')
              ? [{ id: 'TEST_day' }]
              : sql.includes('FROM "DailyReportDraft"')
                ? [{ facts: { ...blankFacts(), weatherReferences: previous } }]
                : sql.includes('FROM "IdempotencyRecord"')
                  ? [
                      {
                        requestHash: sha(command),
                        responseBody: { version: 2 },
                      },
                    ]
                  : [],
  }));
  const client = {
    query,
    on: vi.fn(),
    removeListener: vi.fn(),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, query };
}
const identity = { tenantId: 'TEST_tenant', objectId: 'TEST_object' };
describe('C03 report weather capture default-off gate', () => {
  it.each([false, true])(
    'weather adoption remains enabled with capture opt-in %s',
    async (location) => {
      const command: SaveFactsCommand = {
        ...base,
        facts: {
          ...base.facts,
          weatherReferences: [
            {
              snapshotId: reference.snapshotId,
              locationVersionId: reference.locationVersionId,
            },
          ],
        },
      };
      const { pool, query } = fake(command);
      expect(
        await new ReportStore(pool, {
          weatherReferenceEnabled: true,
          reportLocationEnabled: location,
        }).saveFacts(identity, command),
      ).toEqual({ version: 2 });
      expect(
        query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
      ).toBe(false);
    },
  );
  it.each([
    { weather: false, location: false, captureEnabled: false },
    { weather: false, location: true, captureEnabled: true },
    { weather: true, location: false, captureEnabled: false },
    { weather: true, location: true, captureEnabled: true },
  ])('independent capture gate: $weather/$location', async (flags) => {
    const command = { ...base, reportLocationOperation: capture };
    const { pool, query } = fake(command);
    const result = new ReportStore(pool, {
      weatherReferenceEnabled: flags.weather,
      reportLocationEnabled: flags.location,
    }).saveFacts(identity, command);
    if (flags.captureEnabled) {
      expect(await result).toEqual({ version: 2 });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
      ).toBe(false);
    }
    // This fake covers admission/replay, not first-write database persistence.
    expect(
      query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
    ).toBe(false);
  });
  it.each([false, true])(
    'independent capture still checks the role first (%s)',
    async (weather) => {
      const command = { ...base, reportLocationOperation: capture };
      const { pool, query } = fake(command, 'EXECUTIVE_READER');
      await expect(
        new ReportStore(pool, {
          weatherReferenceEnabled: weather,
          reportLocationEnabled: true,
        }).saveFacts(identity, command),
      ).rejects.toMatchObject({ code: 'READ_ONLY' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
      ).toBe(false);
      expect(
        query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
      ).toBe(false);
    },
  );
  it.each(['unadopted', 'other-reference'] as const)(
    'location-only opt-in does not admit %s weather',
    async (mode) => {
      const command: SaveFactsCommand = {
        ...base,
        facts: {
          ...base.facts,
          weatherReferences: [
            mode === 'unadopted'
              ? {
                  snapshotId: reference.snapshotId,
                  locationVersionId: reference.locationVersionId,
                }
              : { ...reference, snapshotId: 'TEST_other_snapshot' },
          ],
        },
      };
      const { pool, query } = fake(command);
      await expect(
        new ReportStore(pool, {
          weatherReferenceEnabled: false,
          reportLocationEnabled: true,
        }).saveFacts(identity, command),
      ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
      ).toBe(false);
      expect(
        query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
      ).toBe(false);
    },
  );
  it.each([undefined, false])(
    'blocks capture before successful replay with option %s',
    async (enabled) => {
      const command = { ...base, reportLocationOperation: capture };
      const { pool, query } = fake(command);
      await expect(
        new ReportStore(pool, { weatherReferenceEnabled: enabled }).saveFacts(
          identity,
          command,
        ),
      ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
      ).toBe(false);
      expect(
        query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
      ).toBe(false);
    },
  );
  it('checks role before exposing the feature state', async () => {
    const command = { ...base, reportLocationOperation: capture };
    const { pool, query } = fake(command, 'EXECUTIVE_READER');
    await expect(
      new ReportStore(pool).saveFacts(identity, command),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
    ).toBe(false);
  });
  it('explicit enablement lets the existing idempotency path replay capture without new side effects', async () => {
    const command = { ...base, reportLocationOperation: capture };
    const { pool, query } = fake(command);
    expect(
      await new ReportStore(pool, { weatherReferenceEnabled: true }).saveFacts(
        identity,
        command,
      ),
    ).toEqual({ version: 2 });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([sql]) => /^INSERT|^UPDATE/.test(sql.trim())),
    ).toBe(false);
  });
  it('blocks an unadopted snapshot before replay', async () => {
    const command = {
      ...base,
      facts: {
        ...base.facts,
        weatherReferences: [
          {
            snapshotId: reference.snapshotId,
            locationVersionId: reference.locationVersionId,
          },
        ],
      },
    };
    const { pool, query } = fake(command);
    await expect(
      new ReportStore(pool).saveFacts(identity, command),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
    ).toBe(false);
  });
  it('blocks a reference not already on this draft, even when it names a persisted identity', async () => {
    const command = {
      ...base,
      facts: {
        ...base.facts,
        weatherReferences: [
          { ...reference, snapshotId: 'TEST_other_snapshot' },
        ],
      },
    };
    const { pool, query } = fake(command);
    await expect(
      new ReportStore(pool).saveFacts(identity, command),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('IdempotencyRecord')),
    ).toBe(false);
  });
  it.each(['omit', 'clear', 'metadata'] as const)(
    'allows %s during disabled manual reporting',
    async (mode) => {
      const command: SaveFactsCommand =
        mode === 'omit'
          ? base
          : mode === 'clear'
            ? {
                ...base,
                reportLocationOperation: { kind: 'clear' },
                facts: { ...base.facts, weatherReferences: [] },
              }
            : {
                ...base,
                facts: { ...base.facts, weatherReferences: [reference] },
              };
      const { pool } = fake(command);
      expect(await new ReportStore(pool).saveFacts(identity, command)).toEqual({
        version: 2,
      });
    },
  );
});
