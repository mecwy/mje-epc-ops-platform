import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  createMetForecastCacheGate,
  MetForecastCacheError,
  type MetCacheEntry,
} from './met-forecast-cache.js';

// Scripted SQL responses exercise the adapter contract, not PostgreSQL/RLS/durability.
const org = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64),
  token = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-07T01:00:00.000Z';
const payload: MetCacheEntry = {
  body: { type: 'Feature', properties: { zero: 0 } },
  fetchedAt: at,
  expiresAt: '2026-10-07T02:00:00.000Z',
  lastModified: 'Wed, 07 Oct 2026 00:50:00 GMT',
};
function setup(
  options: {
    cooldown?: string;
    clock?: string;
    cached?: boolean;
    live?: boolean;
    token?: string;
    absent?: boolean;
    updateCount?: number;
  } = {},
) {
  const row = {
    body: options.cached ? payload.body : null,
    fetchedAt: options.cached ? payload.fetchedAt : null,
    expiresAt: options.cached ? payload.expiresAt : null,
    lastModified: options.cached ? payload.lastModified : null,
    leaseToken: options.live ? (options.token ?? token) : null,
    leasedUntil: options.live ? '2026-10-07T01:00:30.000Z' : null,
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  const execute = vi.fn(
    async (
      sql: string,
      values: unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT "until"'))
        return { rows: [{ until: options.cooldown ?? null }], rowCount: 1 };
      if (sql.startsWith('SELECT body'))
        return {
          rows: options.absent ? [] : [{ ...row }],
          rowCount: options.absent ? 0 : 1,
        };
      if (sql.startsWith('SELECT clock_timestamp'))
        return { rows: [{ at: new Date(options.clock ?? at) }], rowCount: 1 };
      if (sql.startsWith('UPDATE "MetForecastCache" SET "leaseToken"=$4')) {
        row.leaseToken = values[3] as string;
        row.leasedUntil = '2026-10-07T01:00:30.000Z';
      }
      return { rows: [], rowCount: options.updateCount ?? 1 };
    },
  );
  const release = vi.fn();
  const client = { query: execute, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  return {
    gate: createMetForecastCacheGate(pool, org),
    pool,
    client,
    connect,
    execute,
    release,
    row,
    calls,
    mutations: () => calls.filter((c) => c.sql.startsWith('UPDATE')),
  };
}
const signal = () => new AbortController().signal;
const lease = { key: hash, token };

describe('MET durable gate SQL contract (injected client only)', () => {
  it('requires trusted UUID scope and rejects malformed keys/times before connection', async () => {
    const s = setup();
    expect(() => createMetForecastCacheGate(s.pool, 'browser-org')).toThrow(
      'INVALID_INPUT',
    );
    await expect(
      s.gate.take('raw=personal-coordinate', at, signal()),
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      s.gate.take(hash, '2026-02-30T01:00:00Z', signal()),
    ).rejects.toThrow('INVALID_INPUT');
    expect(s.connect).not.toHaveBeenCalled();
  });
  it('does not acquire a client for an already cancelled request', async () => {
    const s = setup(),
      c = new AbortController();
    c.abort();
    await expect(s.gate.take(hash, at, c.signal)).rejects.toThrow('CANCELLED');
    expect(s.connect).not.toHaveBeenCalled();
  });
  it('sets local RLS and transaction bounds then locks cooldown before point and clock', async () => {
    const s = setup();
    const result = await s.gate.take(hash, at, signal());
    expect(result.state).toBe('leased');
    expect(s.calls[0]?.sql).toBe('BEGIN');
    expect(s.calls[1]?.sql).toContain("transaction_timeout='30s'");
    expect(s.calls[2]?.sql).toContain("lock_timeout='5s'");
    expect(s.calls[3]?.values).toEqual([org]);
    const texts = s.calls.map((c) => c.sql);
    const providerLock = texts.findIndex((v) => v.startsWith('SELECT "until"'));
    const pointLock = texts.findIndex((v) => v.startsWith('SELECT body'));
    const clock = texts.findIndex((v) =>
      v.startsWith('SELECT clock_timestamp'),
    );
    expect(providerLock).toBeLessThan(pointLock);
    expect(pointLock).toBeLessThan(clock);
    expect(s.mutations()[0]?.sql).toContain(
      "clock_timestamp()+interval '30 seconds'",
    );
    expect(s.mutations()[0]?.values.slice(0, 3)).toEqual([
      org,
      'met-norway',
      hash,
    ]);
    expect(texts.at(-1)).toBe('COMMIT');
    expect(s.release).toHaveBeenCalledOnce();
  });
  it('uses DB clock for fresh entry, preserving original fetch time and Last-Modified', async () => {
    const s = setup({ cached: true });
    const result = await s.gate.take(hash, '2030-01-01T00:00:00Z', signal());
    expect(result).toEqual({ state: 'fresh', entry: payload });
    expect(s.mutations()).toHaveLength(0);
  });
  it('retains expired body and exact conditional metadata when taking a replacement lease', async () => {
    const s = setup({ cached: true, clock: '2026-10-07T02:00:01Z' });
    const result = await s.gate.take(hash, at, signal());
    expect(result.state).toBe('leased');
    if (result.state !== 'leased') throw new Error('TEST expected lease');
    expect(result.entry).toEqual(payload);
    expect(result.lease.key).toBe(hash);
    expect(result.lease.token).toMatch(/^[a-f0-9-]{36}$/);
    expect(s.mutations()[0]?.values[3]).toBe(result.lease.token);
  });
  it('reports a live competing token as busy without writing a new token', async () => {
    const s = setup({ live: true, clock: '2026-10-07T01:00:01.100Z' });
    expect(await s.gate.take(hash, at, signal())).toEqual({
      state: 'busy',
      retryAfterSeconds: 29,
    });
    expect(s.mutations()).toHaveLength(0);
  });
  it('checks provider cooldown even for a cached point, with a bounded retry', async () => {
    const s = setup({ cached: true, cooldown: '2026-10-09T01:00:00Z' });
    expect(await s.gate.take(hash, at, signal())).toEqual({
      state: 'busy',
      retryAfterSeconds: 86400,
    });
    expect(s.mutations()).toHaveLength(0);
  });
  it('commits one bounded body atomically and fences token/DB deadline/cooldown in SQL', async () => {
    const s = setup({ live: true });
    expect(await s.gate.commit(lease, payload, at)).toBe(true);
    const write = s.mutations()[0]!;
    expect(write.sql).toContain('"leaseToken"=$4::uuid');
    expect(write.sql).toContain('"leasedUntil">clock_timestamp()');
    expect(write.sql).toContain('c."until">clock_timestamp()');
    expect(write.values).toEqual([
      org,
      'met-norway',
      hash,
      token,
      JSON.stringify(payload.body),
      at,
      payload.expiresAt,
      payload.lastModified,
    ]);
    expect(write.sql).toContain('"leaseToken"=NULL,"leasedUntil"=NULL');
  });
  it.each([
    'foreign',
    'expired',
    'absent',
    'cooldown',
    'payload-expired',
  ] as const)('refuses %s publication without UPDATE', async (kind) => {
    const s = setup({
      live: true,
      token:
        kind === 'foreign' ? '33333333-3333-4333-8333-333333333333' : token,
      clock: kind === 'expired' ? '2026-10-07T01:00:30Z' : at,
      absent: kind === 'absent',
      cooldown: kind === 'cooldown' ? '2026-10-07T01:01:00Z' : undefined,
    });
    const input =
      kind === 'payload-expired'
        ? { ...payload, fetchedAt: '2026-10-07T00:00:00Z', expiresAt: at }
        : payload;
    expect(await s.gate.commit(lease, input, '2020-01-01T00:00:00Z')).toBe(
      false,
    );
    expect(s.mutations()).toHaveLength(0);
  });
  it('does not claim success when the final CAS returns zero', async () => {
    const s = setup({ live: true, updateCount: 0 });
    expect(await s.gate.commit(lease, payload, at)).toBe(false);
  });
  it.each(['replacement', 'expired'] as const)(
    'release and throttle do not mutate %s owner',
    async (kind) => {
      const s = setup({
        live: true,
        token:
          kind === 'replacement'
            ? '33333333-3333-4333-8333-333333333333'
            : token,
        clock: kind === 'expired' ? '2026-10-07T01:00:30Z' : at,
      });
      await s.gate.release(lease);
      await s.gate.throttle(lease, payload.expiresAt);
      expect(s.mutations()).toHaveLength(0);
    },
  );
  it('release keeps body intact and repeats the exact live token fence', async () => {
    const s = setup({ live: true, cached: true });
    await s.gate.release(lease);
    expect(s.mutations()[0]?.values).toEqual([org, 'met-norway', hash, token]);
    expect(s.mutations()[0]?.sql).toContain('"leasedUntil">clock_timestamp()');
    expect(s.mutations()[0]?.sql).not.toContain('body=');
  });
  it('cooldown is monotonic, bounded, org/provider scoped and fenced at UPDATE time', async () => {
    const s = setup({ live: true });
    await s.gate.throttle(lease, payload.expiresAt);
    const write = s.mutations()[0]!;
    expect(write.sql).toContain('GREATEST');
    expect(write.sql).toContain('LEAST');
    expect(write.sql).toContain("interval '86400 seconds'");
    expect(write.sql).toContain('c."leasedUntil">clock_timestamp()');
    expect(write.values).toEqual([
      org,
      'met-norway',
      hash,
      token,
      payload.expiresAt,
    ]);
    expect(write.sql).not.toContain('SET "leaseToken"');
  });
  it.each([
    { x: undefined },
    { x: NaN },
    { x: 1n },
    { x: new Date() },
    { x: 'a'.repeat(2 * 1024 * 1024) },
  ])(
    'rejects non-JSON or oversized body before opening a transaction',
    async (body) => {
      const s = setup({ live: true });
      await expect(
        s.gate.commit(lease, { ...payload, body }, at),
      ).rejects.toThrow('INVALID_INPUT');
      expect(s.connect).not.toHaveBeenCalled();
    },
  );
  it('bounds nesting/cycles and HTTP-date metadata', async () => {
    const s = setup(),
      cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    await expect(
      s.gate.commit(lease, { ...payload, body: cycle }, at),
    ).rejects.toThrow('INVALID_INPUT');
    await expect(
      s.gate.commit(lease, { ...payload, lastModified: 'a'.repeat(201) }, at),
    ).rejects.toThrow('INVALID_INPUT');
    expect(s.connect).not.toHaveBeenCalled();
  });
  it('sanitizes database failures and rolls back/releases', async () => {
    const s = setup(),
      original = s.execute.getMockImplementation()!;
    s.execute.mockImplementation(async (sql, values) => {
      if (sql.startsWith('SELECT body'))
        throw new Error('TEST secret coordinate');
      return original(sql, values);
    });
    await expect(s.gate.take(hash, at, signal())).rejects.toEqual(
      new MetForecastCacheError('UNAVAILABLE'),
    );
    expect(s.release).toHaveBeenCalledOnce();
    expect(s.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
  it('discards a connection when rollback fails', async () => {
    const s = setup(),
      original = s.execute.getMockImplementation()!;
    s.execute.mockImplementation(async (sql, values) => {
      if (sql.startsWith('SELECT body') || sql === 'ROLLBACK')
        throw new Error('TEST broken connection');
      return original(sql, values);
    });
    await expect(s.gate.take(hash, at, signal())).rejects.toThrow(
      'UNAVAILABLE',
    );
    expect(s.release).toHaveBeenCalledWith(true);
  });
  it('captures immutable lease and metadata before waiting for the connection', async () => {
    const s = setup({ live: true }),
      value = { ...lease },
      input = { ...payload };
    let deliver!: (client: PoolClient) => void;
    s.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const pending = s.gate.commit(value, input, at);
    value.token = '33333333-3333-4333-8333-333333333333';
    value.key = 'b'.repeat(64);
    input.expiresAt = 'INVALID';
    input.lastModified = 'INVALID';
    deliver(s.client);
    expect(await pending).toBe(true);
    expect(s.mutations()[0]?.values).toEqual([
      org,
      'met-norway',
      hash,
      token,
      JSON.stringify(payload.body),
      at,
      payload.expiresAt,
      payload.lastModified,
    ]);
  });
  it('rollback after an abort prevents a successfully staged lease from escaping', async () => {
    const s = setup(),
      c = new AbortController(),
      original = s.execute.getMockImplementation()!;
    s.execute.mockImplementation(async (sql, values) => {
      const result = await original(sql, values);
      if (sql.startsWith('UPDATE')) c.abort();
      return result;
    });
    await expect(s.gate.take(hash, at, c.signal)).rejects.toThrow('CANCELLED');
    expect(s.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(s.calls.some((v) => v.sql === 'COMMIT')).toBe(false);
  });
  it('returns a lease when abort races COMMIT so C03 finally can release its exact token', async () => {
    const s = setup(),
      c = new AbortController(),
      original = s.execute.getMockImplementation()!;
    s.execute.mockImplementation(async (sql, values) => {
      const result = await original(sql, values);
      if (sql === 'COMMIT') c.abort();
      return result;
    });
    const result = await s.gate.take(hash, at, c.signal);
    expect(result.state).toBe('leased');
    if (result.state !== 'leased') throw new Error('TEST expected lease');
    await s.gate.release(result.lease);
    expect(s.mutations().at(-1)?.values[3]).toBe(result.lease.token);
  });
  it('an abort waiting for a pool client rejects promptly then returns the late client', async () => {
    const s = setup(),
      c = new AbortController();
    let deliver!: (client: PoolClient) => void;
    s.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const pending = s.gate.take(hash, at, c.signal);
    c.abort();
    await expect(pending).rejects.toThrow('CANCELLED');
    deliver(s.client);
    await Promise.resolve();
    expect(s.release).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
  });
});
