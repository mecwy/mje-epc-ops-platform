/**
 * Field plumbing (A6 design §5): errors, pre-authentication throttling, idempotency for field
 * and PM actors, and the lock helpers. Codes and secrets never leave this layer in an error or
 * audit row. The device-token bootstrap and its housekeeping arrive with A6a-2.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sha } from './store-kit.js';

export type FieldErrorCode =
  | 'NOT_FOUND'
  | 'ENTRY_CODE_INVALID'
  | 'RATE_LIMITED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ASSIGNMENT_OVERLAP'
  | 'ASSIGNMENT_CLOSED'
  | 'ROSTER_TIME_INVALID'
  | 'CREW_ENDED'
  | 'CREW_NOT_EMPTY'
  | 'CREW_CODE_TAKEN';
export class FieldError extends Error {
  constructor(public readonly code: FieldErrorCode) {
    super(code);
  }
}

export const hashSecret = (s: string) =>
  createHash('sha256').update(s).digest('hex');

// ---------- throttling (level T: own transaction, before the business transaction) ----------
export interface Limit {
  name: string;
  value: string;
  windowSec: number;
  max: number;
  /** Hash the value with the daily salt (client IP, entry code). */
  salted: boolean;
}
export const LIMITS = {
  entryIp: (ip: string): Limit => salted('entry-ip', ip, 600, 300),
  entryCode: (code: string): Limit => salted('entry-code', code, 600, 600),
};
function salted(name: string, value: string, windowSec: number, max: number) {
  return { name, value, windowSec, max, salted: true };
}
const WINDOW = `to_timestamp(floor(extract(epoch FROM now()) / $2) * $2)`;

/**
 * Fixed windows in Postgres (no Redis). Buckets are salted hashes; the daily salt and every
 * window older than 48 h are deleted, so a bucket never links back to a client.
 */
export class FieldThrottle {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async bucket(c: PoolClient, l: Limit): Promise<string> {
    if (!l.salted) return `${l.name}:${l.value}`;
    await c.query(
      `INSERT INTO "FieldThrottleSalt"(day, salt) VALUES ((now() AT TIME ZONE 'UTC')::date, $1) ON CONFLICT (day) DO NOTHING`,
      [randomBytes(32).toString('hex')],
    );
    const s = await c.query<{ salt: string }>(
      `SELECT salt FROM "FieldThrottleSalt" WHERE day = (now() AT TIME ZONE 'UTC')::date`,
    );
    return `${l.name}:${hashSecret(`${s.rows[0]!.salt}:${l.value}`)}`;
  }
  /** Counts the request in every bucket first, so a refused request still counts. */
  async hit(limits: Limit[]): Promise<void> {
    const over = await this.tx(async (c) => {
      const prune = await c.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(hashtextextended('field-throttle-prune', 0)) AS ok`,
      );
      if (prune.rows[0]!.ok) {
        await c.query(
          `DELETE FROM "FieldThrottle" WHERE "windowStart" < now() - interval '48 hours'`,
        );
        await c.query(
          `DELETE FROM "FieldThrottleSalt" WHERE day < (now() AT TIME ZONE 'UTC')::date - 1`,
        );
      }
      const keyed = [];
      for (const l of limits)
        keyed.push({ l, bucket: await this.bucket(c, l) });
      keyed.sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
      let exceeded = false;
      for (const { l, bucket } of keyed) {
        const r = await c.query<{ count: number }>(
          `INSERT INTO "FieldThrottle"(bucket, "windowStart", count) VALUES ($1, ${WINDOW}, 1)
          ON CONFLICT (bucket, "windowStart") DO UPDATE SET count = "FieldThrottle".count + 1 RETURNING count`,
          [bucket, l.windowSec],
        );
        if (r.rows[0]!.count > l.max) exceeded = true;
      }
      return exceeded;
    });
    if (over) throw new FieldError('RATE_LIMITED');
  }
}

// ---------- locks (design §5 global order) ----------
const advisory = (client: PoolClient, key: string, shared = false) =>
  client.query(
    `SELECT ${shared ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'}(hashtextextended($1, 0))`,
    [key],
  );
/** Level I: the key lock of `idempotent()` (same key), taken before any other level. */
export const keyLock = (
  client: PoolClient,
  orgId: string,
  actorId: string,
  route: string,
  key: string,
) => advisory(client, `${orgId}:${actorId}:${route}:${key}`);
/** Level 0: exclusive for roster writes, shared for readers of the expected crew set. */
export const rosterLock = (
  client: PoolClient,
  orgId: string,
  projectId: string,
  shared = false,
) => advisory(client, `${orgId}:field-roster:${projectId}`, shared);
/**
 * Level 1, sorted. The key matches the CrewAssignment trigger. Every transaction that locks a
 * device row FOR UPDATE and then waits for another lock holds that device's person lock first,
 * so device locks taken across persons cannot form a cycle.
 */
export async function personLocks(
  client: PoolClient,
  orgId: string,
  projectId: string,
  personIds: string[],
) {
  for (const p of [...new Set(personIds)].sort())
    await advisory(client, `${orgId}:field-person:${projectId}:${p}`);
}

// ---------- idempotency for field and PM actors ----------
export interface Outcome<T> {
  status: 200 | 409;
  body: T | { code: FieldErrorCode };
}
/**
 * Exactly-once per (actor, route, key) like `idempotent()`, but a committed refusal (such as a
 * counted failed challenge match) is stored and replayed too, without running again.
 */
export async function fieldIdempotent<T>(
  client: PoolClient,
  orgId: string,
  actorId: string,
  route: string,
  key: string,
  command: unknown,
  work: () => Promise<Outcome<T>>,
): Promise<Outcome<T> & { replayed: boolean }> {
  const requestHash = sha(command);
  await keyLock(client, orgId, actorId, route, key);
  const prior = await client.query<{
    requestHash: string;
    responseStatus: 200 | 409;
    responseBody: T;
  }>(
    `SELECT "requestHash", "responseStatus", "responseBody" FROM "IdempotencyRecord"
    WHERE "orgId"=$1 AND "actorId"=$2 AND route=$3 AND key=$4`,
    [orgId, actorId, route, key],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].requestHash !== requestHash)
      throw new FieldError('IDEMPOTENCY_KEY_REUSED');
    return {
      status: prior.rows[0].responseStatus,
      body: prior.rows[0].responseBody,
      replayed: true,
    };
  }
  const outcome = await work();
  await client.query(
    `INSERT INTO "IdempotencyRecord"(id,"orgId","updatedAt","updatedBy","actorId",route,key,"requestHash",status,"responseStatus","responseBody")
    VALUES($1,$2,now(),$3,$3,$4,$5,$6,'COMPLETED',$7,$8)`,
    [
      randomUUID(),
      orgId,
      actorId,
      route,
      key,
      requestHash,
      outcome.status,
      JSON.stringify(outcome.body),
    ],
  );
  return { ...outcome, replayed: false };
}
export function settled<T>(o: Outcome<T>): T {
  if (o.status !== 200)
    throw new FieldError((o.body as { code: FieldErrorCode }).code);
  return o.body as T;
}
