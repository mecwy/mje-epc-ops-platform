import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  claimWeatherJob,
  failWeatherJob,
  finishWeatherJob,
  type WeatherJobLease,
} from './weather-jobs.js';
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
