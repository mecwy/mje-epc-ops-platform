/** Durable supplier cache; trusted boot org only, with no HTTP or Worker dependency. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface MetCacheEntry {
  body: unknown;
  fetchedAt: string;
  expiresAt: string;
  lastModified: string | null;
}
export interface MetCacheLease {
  key: string;
  token: string;
}
export interface MetSharedGate {
  take(
    key: string,
    now: string,
    signal: AbortSignal,
  ): Promise<
    | { state: 'fresh'; entry: MetCacheEntry }
    | { state: 'leased'; lease: MetCacheLease; entry: MetCacheEntry | null }
    | { state: 'busy'; retryAfterSeconds: number }
  >;
  commit(
    lease: MetCacheLease,
    entry: MetCacheEntry,
    now: string,
  ): Promise<boolean>;
  release(lease: MetCacheLease): Promise<void>;
  throttle(lease: MetCacheLease, until: string): Promise<void>;
}
export class MetForecastCacheError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CANCELLED' | 'UNAVAILABLE') {
    super(code);
    this.name = 'MetForecastCacheError';
  }
}
const PROVIDER = 'met-norway';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BODY = 2 * 1024 * 1024;
type TakeResult = Awaited<ReturnType<MetSharedGate['take']>>;
interface CacheRow {
  body: unknown;
  fetchedAt: Date | string | null;
  expiresAt: Date | string | null;
  lastModified: string | null;
  leaseToken: string | null;
  leasedUntil: Date | string | null;
}
interface Locked {
  row: CacheRow | null;
  cooldown: Date | string | null;
  at: Date;
}
function invalid(): never {
  throw new MetForecastCacheError('INVALID_INPUT');
}
function stamp(v: string): number {
  if (
    typeof v !== 'string' ||
    v.length > 64 ||
    !/^\d{4}-\d\d-\d\dT.+Z$/.test(v)
  )
    invalid();
  const value = Date.parse(v);
  if (
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== v.slice(0, 10)
  )
    invalid();
  return value;
}
function key(v: string): void {
  if (typeof v !== 'string' || !HASH.test(v)) invalid();
}
function lease(v: MetCacheLease): MetCacheLease {
  if (!v || typeof v.token !== 'string' || !UUID.test(v.token)) invalid();
  key(v.key);
  return { key: v.key, token: v.token };
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MetForecastCacheError('CANCELLED');
}
function milliseconds(v: Date | string): number {
  const time = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(time)) throw new MetForecastCacheError('UNAVAILABLE');
  return time;
}
function retry(until: Date | string, at: Date): number {
  return Math.max(
    1,
    Math.min(86400, Math.ceil((milliseconds(until) - at.getTime()) / 1000)),
  );
}
function jsonBody(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 200000 || depth > 64) invalid();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) invalid();
      return;
    }
    if (typeof v !== 'object') invalid();
    if (Array.isArray(v)) {
      for (const child of v) visit(child, depth + 1);
      return;
    }
    if (
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      invalid();
    for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(body, 0);
  const value = JSON.stringify(body);
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY) invalid();
  return value;
}
function entry(row: CacheRow): MetCacheEntry | null {
  if (row.body === null && row.fetchedAt === null && row.expiresAt === null)
    return null;
  if (row.body === null || row.fetchedAt === null || row.expiresAt === null)
    throw new MetForecastCacheError('UNAVAILABLE');
  jsonBody(row.body);
  return {
    body: row.body,
    fetchedAt: new Date(milliseconds(row.fetchedAt)).toISOString(),
    expiresAt: new Date(milliseconds(row.expiresAt)).toISOString(),
    lastModified: row.lastModified,
  };
}
async function connect(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  cancelled(signal);
  if (!signal) return pool.connect();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new MetForecastCacheError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    pool.connect().then(
      (client) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          client.release();
          reject(new MetForecastCacheError('CANCELLED'));
        } else resolve(client);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** The caller supplies a boot-validated business org, never a browser or Entra tenant. */
export function createMetForecastCacheGate(
  pool: Pool,
  trustedOrgId: string,
): MetSharedGate {
  if (typeof trustedOrgId !== 'string' || !UUID.test(trustedOrgId)) invalid();
  async function transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let begun = false,
      discard = false;
    try {
      client = await connect(pool, signal);
      cancelled(signal);
      await client.query('BEGIN');
      begun = true;
      await client.query("SET LOCAL transaction_timeout='30s'");
      await client.query(
        "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'",
      );
      await client.query("SELECT set_config('app.org_id',$1,true)", [
        trustedOrgId,
      ]);
      cancelled(signal);
      const result = await work(client);
      cancelled(signal);
      await client.query('COMMIT');
      // A committed lease must be returned even if abort races COMMIT: C03 records it
      // before its next cancellation check and releases the exact token in finally.
      begun = false;
      return result;
    } catch (error) {
      if (client && begun) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      if (error instanceof MetForecastCacheError) throw error;
      throw new MetForecastCacheError(
        signal?.aborted ? 'CANCELLED' : 'UNAVAILABLE',
      );
    } finally {
      client?.release(discard ? true : undefined);
    }
  }
  async function lock(
    client: PoolClient,
    hash: string,
    insert: boolean,
  ): Promise<Locked> {
    await client.query(
      `INSERT INTO "MetForecastCooldown"("orgId",provider) VALUES($1,$2) ON CONFLICT("orgId",provider) DO NOTHING`,
      [trustedOrgId, PROVIDER],
    );
    const cooldown = (
      await client.query<{ until: Date | string | null }>(
        `SELECT "until" FROM "MetForecastCooldown" WHERE "orgId"=$1 AND provider=$2 FOR UPDATE`,
        [trustedOrgId, PROVIDER],
      )
    ).rows[0];
    if (!cooldown) throw new MetForecastCacheError('UNAVAILABLE');
    if (insert)
      await client.query(
        `INSERT INTO "MetForecastCache"("orgId",provider,"pointHash") VALUES($1,$2,$3) ON CONFLICT("orgId",provider,"pointHash") DO NOTHING`,
        [trustedOrgId, PROVIDER, hash],
      );
    const row =
      (
        await client.query<CacheRow>(
          `SELECT body,"fetchedAt","expiresAt","lastModified","leaseToken","leasedUntil" FROM "MetForecastCache" WHERE "orgId"=$1 AND provider=$2 AND "pointHash"=$3 FOR UPDATE`,
          [trustedOrgId, PROVIDER, hash],
        )
      ).rows[0] ?? null;
    const clock = (
      await client.query<{ at: Date | string }>(
        'SELECT clock_timestamp() AS at',
      )
    ).rows[0];
    if (!clock) throw new MetForecastCacheError('UNAVAILABLE');
    return {
      row,
      cooldown: cooldown.until,
      at: new Date(milliseconds(clock.at)),
    };
  }
  function owned(locked: Locked, value: MetCacheLease): boolean {
    return (
      locked.row?.leaseToken?.toLowerCase() === value.token.toLowerCase() &&
      locked.row.leasedUntil !== null &&
      milliseconds(locked.row.leasedUntil) > locked.at.getTime()
    );
  }
  return {
    async take(hash, now, signal): Promise<TakeResult> {
      key(hash);
      stamp(now);
      cancelled(signal);
      return transaction(async (client) => {
        const locked = await lock(client, hash, true);
        cancelled(signal);
        if (
          locked.cooldown &&
          milliseconds(locked.cooldown) > locked.at.getTime()
        )
          return {
            state: 'busy',
            retryAfterSeconds: retry(locked.cooldown, locked.at),
          };
        if (!locked.row) throw new MetForecastCacheError('UNAVAILABLE');
        const previous = entry(locked.row);
        if (previous && Date.parse(previous.expiresAt) > locked.at.getTime())
          return { state: 'fresh', entry: previous };
        if (
          locked.row.leaseToken &&
          locked.row.leasedUntil &&
          milliseconds(locked.row.leasedUntil) > locked.at.getTime()
        )
          return {
            state: 'busy',
            retryAfterSeconds: retry(locked.row.leasedUntil, locked.at),
          };
        const token = randomUUID();
        const result = await client.query(
          `UPDATE "MetForecastCache" SET "leaseToken"=$4::uuid,"leasedUntil"=clock_timestamp()+interval '30 seconds' WHERE "orgId"=$1 AND provider=$2 AND "pointHash"=$3 AND ("leasedUntil" IS NULL OR "leasedUntil"<=clock_timestamp())`,
          [trustedOrgId, PROVIDER, hash, token],
        );
        if (result.rowCount !== 1)
          throw new MetForecastCacheError('UNAVAILABLE');
        return {
          state: 'leased',
          lease: { key: hash, token },
          entry: previous,
        };
      }, signal);
    },
    async commit(value, input, now) {
      const owner = lease(value);
      stamp(now);
      if (!input || typeof input !== 'object') invalid();
      const { fetchedAt, expiresAt, lastModified } = input;
      const fetched = stamp(fetchedAt),
        expires = stamp(expiresAt);
      if (expires <= fetched) invalid();
      if (
        lastModified !== null &&
        (typeof lastModified !== 'string' ||
          Buffer.byteLength(lastModified, 'utf8') > 200 ||
          !Number.isFinite(Date.parse(lastModified)))
      )
        invalid();
      const body = jsonBody(input.body);
      return transaction(async (client) => {
        const locked = await lock(client, owner.key, false);
        if (
          !owned(locked, owner) ||
          expires <= locked.at.getTime() ||
          (locked.cooldown &&
            milliseconds(locked.cooldown) > locked.at.getTime())
        )
          return false;
        const result = await client.query(
          `UPDATE "MetForecastCache" SET body=$5::jsonb,"fetchedAt"=$6::timestamptz,"expiresAt"=$7::timestamptz,"lastModified"=$8,"leaseToken"=NULL,"leasedUntil"=NULL WHERE "orgId"=$1 AND provider=$2 AND "pointHash"=$3 AND "leaseToken"=$4::uuid AND "leasedUntil">clock_timestamp() AND $7::timestamptz>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "MetForecastCooldown" c WHERE c."orgId"=$1 AND c.provider=$2 AND c."until">clock_timestamp())`,
          [
            trustedOrgId,
            PROVIDER,
            owner.key,
            owner.token,
            body,
            fetchedAt,
            expiresAt,
            lastModified,
          ],
        );
        return result.rowCount === 1;
      });
    },
    async release(value) {
      const owner = lease(value);
      await transaction(async (client) => {
        const locked = await lock(client, owner.key, false);
        if (!owned(locked, owner)) return;
        await client.query(
          `UPDATE "MetForecastCache" SET "leaseToken"=NULL,"leasedUntil"=NULL WHERE "orgId"=$1 AND provider=$2 AND "pointHash"=$3 AND "leaseToken"=$4::uuid AND "leasedUntil">clock_timestamp()`,
          [trustedOrgId, PROVIDER, owner.key, owner.token],
        );
      });
    },
    async throttle(value, until) {
      const owner = lease(value);
      stamp(until);
      await transaction(async (client) => {
        const locked = await lock(client, owner.key, false);
        if (!owned(locked, owner)) return;
        await client.query(
          `UPDATE "MetForecastCooldown" SET "until"=GREATEST(COALESCE("until",'-infinity'::timestamptz),LEAST($5::timestamptz,clock_timestamp()+interval '86400 seconds')) WHERE "orgId"=$1 AND provider=$2 AND EXISTS(SELECT 1 FROM "MetForecastCache" c WHERE c."orgId"=$1 AND c.provider=$2 AND c."pointHash"=$3 AND c."leaseToken"=$4::uuid AND c."leasedUntil">clock_timestamp())`,
          [trustedOrgId, PROVIDER, owner.key, owner.token, until],
        );
      });
    },
  };
}
