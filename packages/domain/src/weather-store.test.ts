import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  readWeatherLocations,
  resolveWeatherFacts,
  weatherSafe,
  writeReportLocation,
} from './weather-store.js';
import { ReportError, type Actor } from './store-kit.js';
const actor: Actor = {
  orgId: 'TEST-org',
  accountId: 'TEST-account',
  personId: 'TEST-person',
  authzVersion: 1,
  decidedAt: '2026-10-06T12:00:00Z',
};
const scope = {
  projectId: 'TEST-project',
  dailyCloseId: 'TEST-day',
  businessDate: '2026-10-05',
  siteTimezone: 'Europe/Belgrade',
};
function client(allowed = true) {
  const query = vi.fn(
    async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => ({
      rows: sql.includes('FROM "Membership"')
        ? allowed
          ? [{ role: 'PROJECT_MANAGER' }]
          : []
        : sql.includes('FROM "Project"')
          ? [{ id: 'TEST-project', timezone: 'Europe/Belgrade' }]
          : sql.includes('FROM "DailyClose"')
            ? [{ state: 'DRAFT', correctionReason: null }]
            : [],
    }),
  );
  return { query, c: { query } as unknown as PoolClient };
}
describe('report transaction joins', () => {
  it('does not erase omitted weather or location fields', async () => {
    const { c } = client();
    const before = { weatherReferences: [] };
    expect(
      await resolveWeatherFacts(c, actor, scope, before, {}, 'TEST-key'),
    ).toEqual(before);
    expect(
      await resolveWeatherFacts(
        c,
        actor,
        scope,
        before,
        { weatherReferences: [] },
        'TEST-key',
      ),
    ).toEqual(before);
  });
  it('refuses changing a personal reference through generic facts', async () => {
    const { c } = client();
    await expect(
      resolveWeatherFacts(
        c,
        actor,
        scope,
        {},
        { reportLocationRef: null },
        'TEST-key',
      ),
    ).rejects.toThrow('weather.locationRef');
  });
  it('checks project authorization even if no weather rows exist', async () => {
    const { c, query } = client(false);
    await expect(
      readWeatherLocations(c, actor, 'TEST-project'),
    ).rejects.toThrow('FORBIDDEN');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('sanitizes database detail while retaining known permission errors', async () => {
    await expect(
      weatherSafe(async () => {
        throw new Error('TEST raw position and key');
      }),
    ).rejects.toThrow(/^WEATHER_STORE_FAILED$/);
    await expect(
      weatherSafe(async () => {
        throw new ReportError('READ_ONLY');
      }),
    ).rejects.toThrow('READ_ONLY');
  });
  it('retains a persisted reference with JSONB key order after refresh', async () => {
    const { c, query } = client();
    const recordId = '00000000-0000-4000-8000-000000000001';
    const at = '2026-10-06T12:00:00.000Z';
    const before = {
      serverReceivedAt: at,
      clientConfirmedAt: at,
      acquiredAt: at,
      deviceFixAt: null,
      accuracyM: '200.00',
      recordId,
    };
    const previous = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) =>
      sql.includes('FROM "ReportLocationRecord"')
        ? {
            rows: [
              {
                id: recordId,
                rawAccuracyM: '200.00',
                deviceFixAt: null,
                acquiredAt: new Date(at),
                clientConfirmedAt: new Date(at),
                serverReceivedAt: new Date(at),
              },
            ],
          }
        : previous(sql),
    );
    expect(
      await writeReportLocation(c, actor, scope, undefined, before, 'TEST-key'),
    ).toEqual(before);
  });
});
