import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  claimWeatherJob,
  failWeatherJob,
  finishWeatherJob,
  type WeatherJobLease,
} from './weather-jobs.js';
import * as jobs from './weather-jobs.js';
const orgId = '00000000-0000-4000-8000-000000000001';
function pool(fail = false) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (fail && sql.includes('FROM "WeatherRequest"'))
      throw new Error('TEST raw coordinates');
    return { rows: [] };
  });
  return {
    query,
    release,
    p: { connect: async () => ({ query, release }) } as unknown as Pool,
  };
}
const lease = {
  orgId,
  requestId: orgId,
  eventId: orgId,
  token: orgId,
  query: {},
  attempts: 1,
} as WeatherJobLease;
describe('finite weather job boundaries', () => {
  it('empty claim commits/releases and only sets trusted boot scope', async () => {
    const { p, query, release } = pool();
    expect(await claimWeatherJob(p, orgId)).toBeNull();
    expect(query.mock.calls[1]?.[0]).toContain('app.org_id');
    expect(release).toHaveBeenCalledOnce();
  });
  it('unknown boot context fails before connecting', async () => {
    const { p, query } = pool();
    await expect(claimWeatherJob(p, 'TEST-client-org')).rejects.toThrow(
      'WEATHER_STORE_FAILED',
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('expired/missing token cannot finish or requeue anything', async () => {
    const { p, query } = pool();
    expect(await finishWeatherJob(p, lease, {} as never)).toBe(false);
    expect(await failWeatherJob(p, lease, 'UNAVAILABLE')).toBe(false);
    expect(query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(false);
  });
  it('DB failure rolls back/releases and emits no raw detail', async () => {
    const { p, query, release } = pool(true);
    await expect(claimWeatherJob(p, orgId)).rejects.toThrow(
      /^WEATHER_STORE_FAILED$/,
    );
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('supplier attempts exclude owned pre-HTTP gate deferrals', () => {
  const q = {
    projectId: orgId,
    locationVersionId: orgId,
    businessDate: '2026-10-07',
    timezone: 'UTC',
    point: { lat: '45', lon: '19' },
    interval: {
      startAt: '2026-10-07T00:00:00Z',
      endAt: '2026-10-08T00:00:00Z',
    },
    product: 'forecast' as const,
    model: 'forecast' as const,
  };
  function owned(attempts = 1, ownedToken = true, at = '2026-10-07T10:00:00Z') {
    const query = vi.fn(async (sql: string, values: unknown[] = []) => ({
      rows:
        sql.includes('FROM "WeatherRequest"') &&
        ownedToken &&
        values[0] === orgId &&
        values[2] === orgId
          ? [{ query: q, attempts, at: new Date(at) }]
          : [],
    }));
    const release = vi.fn();
    return {
      query,
      release,
      p: { connect: async () => ({ query, release }) } as unknown as Pool,
    };
  }
  it.each([1, 2])(
    'busy after reservation %s preserves only the prior supplier count',
    async (attempts) => {
      const f = owned(attempts);
      expect(
        await jobs.deferWeatherJob(f.p, { ...lease, attempts: 99 }, 120),
      ).toBe(true);
      const update = f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "WeatherRequest"'),
      );
      expect(update?.[1]).toEqual([
        orgId,
        orgId,
        'PENDING',
        attempts - 1,
        null,
        120,
      ]);
      const outbox = f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "OutboxEvent"'),
      );
      expect(outbox?.[1]).toEqual([
        orgId,
        orgId,
        120,
        false,
        attempts - 1,
        orgId,
      ]);
      expect(update?.[0]).toContain('"leaseToken"=NULL');
      expect(update?.[0]).toContain('"leasedUntil"=NULL');
      expect(outbox?.[0]).toContain('ELSE NULL');
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
  it('bounds requeue delay at five seconds and refuses malformed input', async () => {
    const f = owned();
    await jobs.deferWeatherJob(f.p, lease, 1);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "WeatherRequest"'),
      )?.[1]?.[5],
    ).toBe(5);
    for (const invalid of [0, -1, 1.5, Infinity, NaN, 86401]) {
      const bad = owned();
      await expect(jobs.deferWeatherJob(bad.p, lease, invalid)).rejects.toThrow(
        /^WEATHER_STORE_FAILED$/,
      );
      expect(bad.query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(
        false,
      );
    }
  });
  it('expired token/wrong org cannot return a lease or rewrite prior attempts', async () => {
    for (const [f, input] of [
      [owned(2, false), lease],
      [owned(2), { ...lease, orgId: '33333333-3333-4333-8333-333333333333' }],
    ] as const) {
      expect(await jobs.deferWeatherJob(f.p, input, 5)).toBe(false);
      expect(f.query.mock.calls.some(([sql]) => /^UPDATE/.test(sql))).toBe(
        false,
      );
    }
  });
  it('an expired query window terminates rather than deferring forever', async () => {
    const f = owned(1, true, '2026-10-10T10:00:00Z');
    expect(await jobs.deferWeatherJob(f.p, lease, 60)).toBe(true);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "WeatherRequest"'),
      )?.[1],
    ).toEqual([orgId, orgId, 'NO_HISTORY', 0, 'QUERY_WINDOW_EXPIRED', 60]);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "OutboxEvent"'),
      )?.[1]?.[3],
    ).toBe(true);
  });
  it('INVALID_RESPONSE is terminal UNAVAILABLE with exact code and processed outbox', async () => {
    const f = owned();
    expect(await failWeatherJob(f.p, lease, 'INVALID_RESPONSE')).toBe(true);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "WeatherRequest"'),
      )?.[1],
    ).toEqual([orgId, orgId, 'UNAVAILABLE', 'INVALID_RESPONSE', 5]);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.startsWith('UPDATE "OutboxEvent"'),
      )?.[1]?.[3],
    ).toBe(false);
  });
});
