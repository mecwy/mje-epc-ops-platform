/**
 * Field plumbing (A6 design §2, §5): errors, pre-authentication throttling, idempotency for
 * device and PM actors, the lock helpers, device-token bootstrap and deferred housekeeping.
 * Tokens, hashes and codes never leave this layer in an error, event or audit row.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DeviceState } from '@mje/contracts';
import {
  PREVIOUS_HASH_MS,
  expiryReason,
  isLive,
  lockMode,
  type DeviceClock,
  type EndReason,
} from './field-rules.js';
import { sha } from './store-kit.js';

export type FieldErrorCode =
  | 'FIELD_AUTH_REQUIRED'
  | 'DEVICE_ENDED'
  | 'DEVICE_PENDING'
  | 'FORBIDDEN'
  | 'NOT_FOREMAN'
  | 'SELF_CONFIRM'
  | 'NOT_FOUND'
  | 'ENTRY_CODE_INVALID'
  | 'PERSON_NOT_ROSTERED'
  | 'RATE_LIMITED'
  | 'RETRY'
  | 'TOKEN_CONFLICT'
  | 'TOO_MANY_PENDING'
  | 'CHALLENGE_INVALID'
  | 'CONFIRM_STALE'
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
  /** Hash the value with the daily salt (client IP, entry code, device token). */
  salted: boolean;
  /**
   * Count only when the value is an active entry code. Arbitrary values would otherwise each
   * create a bucket (unbounded rows from one caller); the IP bucket still counts every request.
   */
  onlyActiveEntryCode?: boolean;
}
export const LIMITS = {
  entryIp: (ip: string): Limit => salted('entry-ip', ip, 600, 300),
  entryCode: (code: string): Limit => ({
    ...salted('entry-code', code, 600, 600),
    onlyActiveEntryCode: true,
  }),
  bindIp: (ip: string): Limit => salted('bind-ip', ip, 3600, 150),
  bindCode: (code: string): Limit => ({
    ...salted('bind-code', code, 3600, 300),
    onlyActiveEntryCode: true,
  }),
  challenge: (tokenHash: string): Limit =>
    salted('challenge', tokenHash, 3600, 10),
  unknownToken: (ip: string): Limit => salted('unknown-token', ip, 600, 60),
  /** Failed confirms per confirmer (device or account id); counted after the commit. */
  failedConfirms: (actorId: string): Limit => ({
    name: 'confirm-fail',
    value: actorId,
    windowSec: 3600,
    max: 30,
    salted: false,
  }),
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
  /** Whether the value is an active entry code (through the SELECT-only lookup policy). */
  private async activeEntryCode(c: PoolClient, code: string): Promise<boolean> {
    await c.query("SELECT set_config('app.entry_code', $1, true)", [code]);
    const r = await c.query(
      `SELECT 1 FROM "FieldEntryCode" WHERE "retiredAt" IS NULL AND code=$1`,
      [code],
    );
    await c.query("SELECT set_config('app.entry_code', '', true)");
    return r.rowCount === 1;
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
        if (!l.onlyActiveEntryCode || (await this.activeEntryCode(c, l.value)))
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
  /** Whether a failure bucket is already full (read only). */
  async full(l: Limit, client?: PoolClient): Promise<boolean> {
    const read = async (c: PoolClient) => {
      const r = await c.query<{ count: number }>(
        `SELECT count FROM "FieldThrottle" WHERE bucket = $1 AND "windowStart" = ${WINDOW}`,
        [await this.bucket(c, l), l.windowSec],
      );
      return (r.rows[0]?.count ?? 0) >= l.max;
    };
    return client ? read(client) : this.tx(read);
  }
  /** Counts one failure, best-effort (after the request's own outcome is settled). */
  async add(l: Limit): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO "FieldThrottle"(bucket, "windowStart", count) VALUES ($1, ${WINDOW}, 1)
        ON CONFLICT (bucket, "windowStart") DO UPDATE SET count = "FieldThrottle".count + 1`,
        [await this.bucket(c, l), l.windowSec],
      );
    });
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
/** Level I for bind and rotate: one request per token hash across all orgs. */
export const tokenLock = (client: PoolClient, hash: string) =>
  advisory(client, `field-token:${hash}`);
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

// ---------- events and lifecycle writes ----------
export interface EventActor {
  accountId?: string | null;
  personId?: string | null;
  deviceId?: string | null;
}
export async function deviceEvent(
  client: PoolClient,
  e: {
    orgId: string;
    projectId: string;
    deviceId?: string | null;
    personId?: string | null;
    kind: string;
    reason?: string | null;
    actor?: EventActor;
  },
) {
  await client.query(
    `INSERT INTO "FieldDeviceEvent"(id,"orgId","projectId","deviceId","personId",kind,"reasonCode","actorAccountId","actorPersonId","actorDeviceId")
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      e.orgId,
      e.projectId,
      e.deviceId ?? null,
      e.personId ?? null,
      e.kind,
      e.reason ?? null,
      e.actor?.accountId ?? null,
      e.actor?.personId ?? null,
      e.actor?.deviceId ?? null,
    ],
  );
}
const EVENT_OF: Record<EndReason, string> = {
  REJECTED: 'REJECT',
  SUPERSEDED: 'SUPERSEDE',
  REVOKED: 'REVOKE',
  RELEASED: 'RELEASE',
  REPLACED: 'REPLACE',
  UNASSIGNED: 'UNASSIGN',
  PENDING_TIMEOUT: 'EXPIRE',
  LIFETIME: 'EXPIRE',
  IDLE: 'EXPIRE',
};
/**
 * Ends a live device the caller holds FOR UPDATE: the terminal state, the end columns, its
 * live challenges superseded, one event. Returns false if it was no longer live.
 */
export async function endDevice(
  client: PoolClient,
  d: { orgId: string; projectId: string; id: string; personId: string },
  state: 'REJECTED' | 'REVOKED' | 'EXPIRED',
  reason: EndReason,
  actor: EventActor = {},
): Promise<boolean> {
  const r = await client.query(
    `UPDATE "FieldDevice" SET state=$3, "endedAt"=now(), "endReason"=$4, version=version+1
    WHERE "orgId"=$1 AND id=$2 AND state IN ('PENDING','CONFIRMED')`,
    [d.orgId, d.id, state, reason],
  );
  if (!r.rowCount) return false;
  await client.query(
    `UPDATE "FieldConfirmChallenge" SET "supersededAt"=now()
    WHERE "orgId"=$1 AND "deviceId"=$2 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
    [d.orgId, d.id],
  );
  await deviceEvent(client, {
    orgId: d.orgId,
    projectId: d.projectId,
    deviceId: d.id,
    personId: d.personId,
    kind: state === 'EXPIRED' ? 'EXPIRE' : EVENT_OF[reason],
    reason,
    actor,
  });
  return true;
}

// ---------- device-token bootstrap (design §5) ----------
export interface DeviceRow extends DeviceClock {
  id: string;
  orgId: string;
  projectId: string;
  personId: string;
  state: DeviceState;
  generation: number;
  version: number;
  rotatedAt: Date | null;
  createdAt: Date;
}
export const DEVICE_COLUMNS = `d.id, d."orgId", d."projectId", d."personId", d.state, d.generation, d.version,
  d."pendingUntil", d."expiresAt", d."memberUntil", d."lastSeenAt", d."rotatedAt", d."createdAt"`;
export interface FieldAuth {
  device: DeviceRow;
  matched: 'current' | 'previous';
  /** The authoritative clock: now() = the transaction start time. */
  now: Date;
}
export interface FieldSpec {
  /** Revoke, release, rotate: always FOR UPDATE. */
  lifecycle?: boolean;
  allowPending?: boolean;
  /** Only rotate may present the previous hash, for its exact replay. */
  allowPrevious?: boolean;
  /** Level I before the person locks: the idempotency key or the new token's hash. */
  keyLock?: { route: string; key: string };
  tokenLock?: string;
  /** Level 1 person locks, given the non-locking lookup (sorted inside). */
  persons?: (d: DeviceRow) => string[];
  /**
   * Deferred housekeeping after the transaction (default on). A TEST seam switches it off to
   * show that nothing the request answers depends on it.
   */
  deferred?: boolean;
}
type Attempt<T> =
  | {
      kind: 'ok';
      value: T;
      auth: FieldAuth;
      mode: 'UPDATE' | 'SHARE';
      authAt: string;
      hasPrevious: boolean;
    }
  | { kind: 'unknown' }
  | { kind: 'ended'; observed: DeviceRow | null }
  | { kind: 'reclassify' };

/**
 * Authenticates a device token and runs `work` in the same transaction, as the low-privilege
 * application role: (1) non-locking lookup through the SELECT-only lookup policy, (2) org
 * context, (3) level I locks, (4) person locks, (5) the locked re-read in its final mode, which
 * revalidates the hash, state and every deadline. A FOR UPDATE request persists an observed
 * expiry and commits before answering DEVICE_ENDED; a FOR SHARE request whose wall clock
 * crossed into the last idle day while it waited restarts once with a fresh now().
 */
export async function fieldTransaction<T>(
  pool: Pool,
  throttle: FieldThrottle,
  tokenHash: string,
  ip: string,
  spec: FieldSpec,
  work: (client: PoolClient, auth: FieldAuth) => Promise<T>,
): Promise<T> {
  if (await throttle.full(LIMITS.unknownToken(ip)))
    throw new FieldError('RATE_LIMITED');
  for (let attempt = 1; ; attempt++) {
    const a = await attemptOnce(pool, tokenHash, spec, work);
    if (a.kind === 'reclassify') {
      if (attempt >= 2) throw new FieldError('RETRY');
      continue;
    }
    if (a.kind === 'unknown') {
      await throttle.add(LIMITS.unknownToken(ip)).catch(() => undefined);
      throw new FieldError('FIELD_AUTH_REQUIRED');
    }
    const deferred = spec.deferred !== false;
    if (a.kind === 'ended') {
      if (a.observed && deferred)
        await persistObservedExpiry(
          pool,
          a.observed.orgId,
          a.observed.id,
        ).catch(() => undefined);
      throw new FieldError('DEVICE_ENDED');
    }
    const d = a.auth.device;
    if (
      deferred &&
      a.mode === 'SHARE' &&
      d.state === 'CONFIRMED' &&
      a.auth.matched === 'current'
    )
      await recordActivity(pool, d.orgId, d.id, a.authAt).catch(
        () => undefined,
      );
    if (deferred && a.auth.matched === 'current' && a.hasPrevious)
      await clearPreviousHash(
        pool,
        d.orgId,
        d.id,
        d.generation,
        tokenHash,
      ).catch(() => undefined);
    return a.value;
  }
}

async function attemptOnce<T>(
  pool: Pool,
  tokenHash: string,
  spec: FieldSpec,
  work: (client: PoolClient, auth: FieldAuth) => Promise<T>,
): Promise<Attempt<T>> {
  const client = await pool.connect();
  let open = true;
  const finish = async (commit: boolean) => {
    open = false;
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    // 1. Non-locking lookup; it returns everything step 5 needs to choose its mode.
    await client.query("SELECT set_config('app.device_token_hash', $1, true)", [
      tokenHash,
    ]);
    const found = await client.query<DeviceRow & { now: Date }>(
      `SELECT ${DEVICE_COLUMNS}, now() AS now FROM "FieldDevice" d WHERE d."tokenHash"=$1 OR d."prevTokenHash"=$1`,
      [tokenHash],
    );
    const seen = found.rows[0];
    if (!seen) {
      await finish(false);
      return { kind: 'unknown' };
    }
    const now = seen.now;
    // 2. Org context; the lookup policy is not needed any more.
    await client.query(
      "SELECT set_config('app.org_id', $1, true), set_config('app.device_token_hash', '', true)",
      [seen.orgId],
    );
    // 3. Level I, 4. level 1.
    if (spec.tokenLock) await tokenLock(client, spec.tokenLock);
    if (spec.keyLock)
      await keyLock(
        client,
        seen.orgId,
        seen.id,
        spec.keyLock.route,
        spec.keyLock.key,
      );
    await personLocks(
      client,
      seen.orgId,
      seen.projectId,
      spec.persons?.(seen) ?? [],
    );
    // 5. Locked re-read in the final mode, chosen before locking.
    const mode = lockMode(seen, now, !!spec.lifecycle);
    const locked = await client.query<
      DeviceRow & {
        current: boolean;
        previous: boolean;
        hasPrevious: boolean;
        authAt: string;
      }
    >(
      `SELECT ${DEVICE_COLUMNS}, d."tokenHash"=$3 AS current, COALESCE(d."prevTokenHash"=$3, false) AS previous,
        d."prevTokenHash" IS NOT NULL AS "hasPrevious", now()::text AS "authAt"
      FROM "FieldDevice" d WHERE d."orgId"=$1 AND d.id=$2 FOR ${mode === 'UPDATE' ? 'UPDATE' : 'SHARE'}`,
      [seen.orgId, seen.id, tokenHash],
    );
    const row = locked.rows[0];
    if (!row || (!row.current && !row.previous)) {
      await finish(false);
      return { kind: 'unknown' };
    }
    if (
      row.previous &&
      (!spec.allowPrevious ||
        !row.rotatedAt ||
        now.getTime() >= row.rotatedAt.getTime() + PREVIOUS_HASH_MS)
    ) {
      await finish(false);
      return { kind: 'unknown' };
    }
    if (!isLive(row.state)) {
      await finish(false);
      return { kind: 'ended', observed: null };
    }
    const reason = expiryReason(row, now);
    if (reason) {
      if (mode === 'UPDATE') {
        await endDevice(client, row, 'EXPIRED', reason);
        await finish(true);
        return { kind: 'ended', observed: null };
      }
      // Rejected from the timestamps alone; persisting is best-effort housekeeping.
      await finish(false);
      return { kind: 'ended', observed: row };
    }
    if (mode === 'SHARE' && row.state === 'CONFIRMED') {
      const late = await client.query<{ late: boolean }>(
        `SELECT clock_timestamp() >= "lastSeenAt" + interval '29 days' AS late FROM "FieldDevice" WHERE "orgId"=$1 AND id=$2`,
        [row.orgId, row.id],
      );
      if (late.rows[0]!.late) {
        await finish(false);
        return { kind: 'reclassify' };
      }
    }
    if (row.state === 'PENDING' && !spec.allowPending)
      throw new FieldError('DEVICE_PENDING');
    if (mode === 'UPDATE' && row.state === 'CONFIRMED' && row.current)
      await client.query(
        `UPDATE "FieldDevice" SET "lastSeenAt"=GREATEST("lastSeenAt", now()) WHERE "orgId"=$1 AND id=$2`,
        [row.orgId, row.id],
      );
    const auth: FieldAuth = {
      device: row,
      matched: row.current ? 'current' : 'previous',
      now,
    };
    const value = await work(client, auth);
    await finish(true);
    return {
      kind: 'ok',
      value,
      auth,
      mode,
      authAt: row.authAt,
      hasPrevious: row.hasPrevious,
    };
  } catch (error) {
    if (open) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------- deferred housekeeping (after the request's transaction; best-effort) ----------
async function housekeeping(
  pool: Pool,
  orgId: string,
  work: (c: PoolClient) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1s'",
    );
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
/**
 * Records the activity of a FOR SHARE request: one guarded UPDATE holding no other lock.
 * `authAt` is the request's own now(); the guards keep it monotonic and, evaluated under the
 * row lock, never touch a terminal row or one within a day of any deadline, so it can never
 * revive an elapsed deadline.
 */
export async function recordActivity(
  pool: Pool,
  orgId: string,
  deviceId: string,
  authAt: string,
): Promise<boolean> {
  let changed = false;
  await housekeeping(pool, orgId, async (c) => {
    const r = await c.query(
      `UPDATE "FieldDevice" SET "lastSeenAt"=$3::timestamptz
      WHERE "orgId"=$1 AND id=$2 AND state='CONFIRMED' AND "lastSeenAt" < $3::timestamptz
        AND now() < "lastSeenAt" + interval '29 days' AND now() < "expiresAt"
        AND ("memberUntil" IS NULL OR now() < "memberUntil")`,
      [orgId, deviceId, authAt],
    );
    changed = r.rowCount === 1;
  });
  return changed;
}
/**
 * After the new token's first use, drops the recovery hash, only if the row still has the
 * observed generation and current hash (which together fix its previous hash), so an older
 * task never clears a newer rotation's recovery hash.
 */
export async function clearPreviousHash(
  pool: Pool,
  orgId: string,
  deviceId: string,
  generation: number,
  tokenHash: string,
): Promise<boolean> {
  let changed = false;
  await housekeeping(pool, orgId, async (c) => {
    const r = await c.query(
      `UPDATE "FieldDevice" SET "prevTokenHash"=NULL
      WHERE "orgId"=$1 AND id=$2 AND generation=$3 AND "tokenHash"=$4 AND "prevTokenHash" IS NOT NULL`,
      [orgId, deviceId, generation, tokenHash],
    );
    changed = r.rowCount === 1;
  });
  return changed;
}
/** Persists EXPIRED for a deadline a FOR SHARE request observed, if it still holds. */
export async function persistObservedExpiry(
  pool: Pool,
  orgId: string,
  deviceId: string,
): Promise<boolean> {
  let changed = false;
  await housekeeping(pool, orgId, async (c) => {
    const r = await c.query<DeviceRow & { now: Date }>(
      `SELECT ${DEVICE_COLUMNS}, now() AS now FROM "FieldDevice" d WHERE d."orgId"=$1 AND d.id=$2 FOR UPDATE`,
      [orgId, deviceId],
    );
    const row = r.rows[0];
    const reason = row ? expiryReason(row, row.now) : null;
    if (row && reason) changed = await endDevice(c, row, 'EXPIRED', reason);
  });
  return changed;
}
