/** Dedicated WEATHER_FETCH consumer. Trusted boot org context only; never an HTTP actor. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseWeatherQuery,
  parseWeatherReferenceDraft,
  type WeatherQueryDto,
  type WeatherReferenceDraftDto,
} from '@mje/contracts';
import { weatherSafe } from './weather-store.js';
export interface WeatherJobLease {
  orgId: string;
  requestId: string;
  eventId: string;
  token: string;
  query: WeatherQueryDto;
  attempts: number;
}
export type WeatherJobFailure =
  | 'NO_HISTORY'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'DISABLED'
  | 'INVALID_RESPONSE';
export interface WeatherSnapshotMetadata {
  adapterVersion: string;
  sourceLink: string;
  licenseLink: string;
}
const DEFAULT_METADATA: WeatherSnapshotMetadata = {
  adapterVersion: 'open-meteo-daily-v1',
  sourceLink: 'https://open-meteo.com/en/docs/historical-weather-api',
  licenseLink: 'https://open-meteo.com/en/terms',
};
const MET_METADATA: WeatherSnapshotMetadata = {
  adapterVersion: 'met-norway-locationforecast-v1',
  sourceLink:
    'https://api.met.no/weatherapi/locationforecast/2.0/documentation',
  licenseLink: 'https://api.met.no/doc/License',
};
async function jobTransaction<T>(
  pool: Pool,
  orgId: string,
  work: (client: PoolClient) => Promise<T>,
) {
  return weatherSafe(async () => {
    if (!/^[a-f0-9-]{36}$/i.test(orgId))
      throw new Error('INVALID_SYSTEM_SCOPE');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id',$1,true)", [orgId]);
      await client.query(
        "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'",
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}
export async function claimWeatherJob(
  pool: Pool,
  orgId: string,
): Promise<WeatherJobLease | null> {
  return jobTransaction(pool, orgId, async (client) => {
    const rows = await client.query<{
      requestId: string;
      eventId: string;
      query: WeatherQueryDto;
      attempts: number;
      at: Date;
    }>(
      `SELECT r.id AS "requestId",e.id AS "eventId",r.query,r.attempts,clock_timestamp() AS at FROM "WeatherRequest" r JOIN "OutboxEvent" e ON e."orgId"=r."orgId" AND e."aggregateId"=r.id AND e."aggregateVersion"=r."refreshGeneration" AND e."eventType"='WEATHER_FETCH' WHERE r."orgId"=$1 AND e."processedAt" IS NULL AND e."availableAt"<=clock_timestamp() AND ((r.state='PENDING' AND r."nextAttemptAt"<=clock_timestamp()) OR (r.state='FETCHING' AND r."leasedUntil"<clock_timestamp())) ORDER BY r."requestedAt",r.id LIMIT 1 FOR UPDATE OF r,e SKIP LOCKED`,
      [orgId],
    );
    const row = rows.rows[0];
    if (!row) return null;
    if (row.attempts >= 2) {
      await client.query(
        `UPDATE "WeatherRequest" SET state='UNAVAILABLE',"leaseToken"=NULL,"leasedUntil"=NULL,"terminalCode"='ATTEMPTS_EXHAUSTED' WHERE "orgId"=$1 AND id=$2`,
        [orgId, row.requestId],
      );
      await client.query(
        `UPDATE "OutboxEvent" SET "processedAt"=clock_timestamp() WHERE "orgId"=$1 AND id=$2`,
        [orgId, row.eventId],
      );
      return null;
    }
    let query: WeatherQueryDto;
    try {
      query = parseWeatherQuery(row.query, new Date(row.at).toISOString());
    } catch {
      await client.query(
        `UPDATE "WeatherRequest" SET state='NO_HISTORY',"leaseToken"=NULL,"leasedUntil"=NULL,"terminalCode"='QUERY_WINDOW_EXPIRED' WHERE "orgId"=$1 AND id=$2`,
        [orgId, row.requestId],
      );
      await client.query(
        `UPDATE "OutboxEvent" SET "processedAt"=clock_timestamp() WHERE "orgId"=$1 AND id=$2`,
        [orgId, row.eventId],
      );
      return null;
    }
    const token = randomUUID();
    await client.query(
      `UPDATE "WeatherRequest" SET state='FETCHING',"leaseToken"=$3,"leasedUntil"=clock_timestamp()+interval '30 seconds',attempts=attempts+1,"terminalCode"=NULL WHERE "orgId"=$1 AND id=$2`,
      [orgId, row.requestId, token],
    );
    return {
      orgId,
      requestId: row.requestId,
      eventId: row.eventId,
      token,
      query,
      attempts: row.attempts + 1,
    };
  });
}
async function ownedRequest(client: PoolClient, lease: WeatherJobLease) {
  const row = (
    await client.query<{ query: WeatherQueryDto; attempts: number; at: Date }>(
      `SELECT query,attempts,clock_timestamp() AS at FROM "WeatherRequest" WHERE "orgId"=$1 AND id=$2 AND state='FETCHING' AND "leaseToken"=$3 AND "leasedUntil">clock_timestamp() FOR UPDATE`,
      [lease.orgId, lease.requestId, lease.token],
    )
  ).rows[0];
  return row ?? null;
}
/** false means lease expired/reclaimed/settled; no stale consumer can publish a snapshot. */
export async function finishWeatherJob(
  pool: Pool,
  lease: WeatherJobLease,
  input: WeatherReferenceDraftDto,
  metadata?: WeatherSnapshotMetadata,
): Promise<boolean> {
  return jobTransaction(pool, lease.orgId, async (client) => {
    const row = await ownedRequest(client, lease);
    if (!row) return false;
    const draft = parseWeatherReferenceDraft(input);
    // Legacy defaults belong only to Open-Meteo. MET callers must supply the
    // fixed actual provider attribution; arbitrary HTTPS links are not proof.
    const attribution =
      metadata ??
      (draft.provider === 'open-meteo' ? DEFAULT_METADATA : undefined);
    if (
      JSON.stringify(draft.query) !==
      JSON.stringify(parseWeatherQuery(row.query, draft.fetchedAt))
    )
      throw new Error('WEATHER_SCOPE_MISMATCH');
    if (
      !attribution ||
      !attribution.adapterVersion ||
      attribution.adapterVersion.length > 80 ||
      ![attribution.sourceLink, attribution.licenseLink].every(
        (s) => s.length <= 300 && s.startsWith('https://'),
      )
    )
      throw new Error('WEATHER_METADATA_INVALID');
    if (
      (draft.provider === 'met-norway' &&
        (attribution.adapterVersion !== MET_METADATA.adapterVersion ||
          attribution.sourceLink !== MET_METADATA.sourceLink ||
          attribution.licenseLink !== MET_METADATA.licenseLink)) ||
      (draft.provider === 'open-meteo' &&
        (attribution.adapterVersion.startsWith('met-norway') ||
          attribution.sourceLink === MET_METADATA.sourceLink ||
          attribution.licenseLink === MET_METADATA.licenseLink))
    )
      throw new Error('WEATHER_METADATA_INVALID');
    // Canonical decoder order is fixed; hash is reproducible without storing external raw bodies.
    const responseHash = createHash('sha256')
      .update(JSON.stringify(draft))
      .digest('hex');
    await client.query(
      `INSERT INTO "WeatherSnapshot"(id,"orgId","projectId","locationVersionId","requestId","businessDate","siteTimezone",data,"fetchedAt","publishedAt","adapterVersion","responseHash","sourceLink","licenseLink") VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14) ON CONFLICT("orgId","requestId") DO NOTHING`,
      [
        randomUUID(),
        lease.orgId,
        draft.query.projectId,
        draft.query.locationVersionId,
        lease.requestId,
        draft.query.businessDate,
        draft.query.timezone,
        JSON.stringify(draft),
        draft.fetchedAt,
        draft.publishedAt,
        attribution.adapterVersion,
        responseHash,
        attribution.sourceLink,
        attribution.licenseLink,
      ],
    );
    await client.query(
      `UPDATE "WeatherRequest" SET state='READY',"leaseToken"=NULL,"leasedUntil"=NULL,"terminalCode"=NULL WHERE "orgId"=$1 AND id=$2`,
      [lease.orgId, lease.requestId],
    );
    await client.query(
      `UPDATE "OutboxEvent" SET "processedAt"=clock_timestamp(),attempts=$3 WHERE "orgId"=$1 AND "eventType"='WEATHER_FETCH' AND "aggregateId"=$2`,
      [lease.orgId, lease.requestId, row.attempts],
    );
    return true;
  });
}
export async function failWeatherJob(
  pool: Pool,
  lease: WeatherJobLease,
  code: WeatherJobFailure,
  retryAfterSeconds?: number,
): Promise<boolean> {
  return jobTransaction(pool, lease.orgId, async (client) => {
    if (
      ![
        'NO_HISTORY',
        'UNAVAILABLE',
        'RATE_LIMITED',
        'DISABLED',
        'INVALID_RESPONSE',
      ].includes(code)
    )
      throw new Error('INVALID_JOB_CODE');
    const row = await ownedRequest(client, lease);
    if (!row) return false;
    const knownDelay =
      retryAfterSeconds !== undefined &&
      Number.isInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 0 &&
      retryAfterSeconds <= 86400;
    const retry =
      row.attempts < 2 &&
      (code === 'UNAVAILABLE' || (code === 'RATE_LIMITED' && knownDelay));
    const delay = knownDelay ? Math.max(5, retryAfterSeconds!) : 5;
    await client.query(
      `UPDATE "WeatherRequest" SET state=$3,"leaseToken"=NULL,"leasedUntil"=NULL,"terminalCode"=$4,"nextAttemptAt"=clock_timestamp()+$5*interval '1 second' WHERE "orgId"=$1 AND id=$2`,
      [
        lease.orgId,
        lease.requestId,
        retry ? 'PENDING' : code === 'INVALID_RESPONSE' ? 'UNAVAILABLE' : code,
        code,
        delay,
      ],
    );
    await client.query(
      `UPDATE "OutboxEvent" SET "availableAt"=clock_timestamp()+$3*interval '1 second',"processedAt"=CASE WHEN $4::boolean THEN NULL ELSE clock_timestamp() END,attempts=$5 WHERE "orgId"=$1 AND "eventType"='WEATHER_FETCH' AND "aggregateId"=$2`,
      [lease.orgId, lease.requestId, delay, retry, row.attempts],
    );
    return true;
  });
}

/** Gate busy/cooldown is pre-HTTP: undo only the owned claim's reserved attempt.
 * Existing settled supplier attempts remain untouched; no historical snapshots are changed.
 */
export async function deferWeatherJob(
  pool: Pool,
  lease: WeatherJobLease,
  retryAfterSeconds: number,
): Promise<boolean> {
  return jobTransaction(pool, lease.orgId, async (client) => {
    if (
      !Number.isInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > 86400
    )
      throw new Error('INVALID_DEFER_DELAY');
    const row = await ownedRequest(client, lease);
    if (!row) return false;
    const attempts = Math.max(0, row.attempts - 1);
    let expired = false;
    try {
      parseWeatherQuery(row.query, new Date(row.at).toISOString());
    } catch {
      expired = true;
    }
    const delay = Math.max(5, retryAfterSeconds);
    await client.query(
      `UPDATE "WeatherRequest" SET state=$3,"leaseToken"=NULL,"leasedUntil"=NULL,attempts=$4,"terminalCode"=$5,"nextAttemptAt"=clock_timestamp()+$6*interval '1 second' WHERE "orgId"=$1 AND id=$2`,
      [
        lease.orgId,
        lease.requestId,
        expired ? 'NO_HISTORY' : 'PENDING',
        attempts,
        expired ? 'QUERY_WINDOW_EXPIRED' : null,
        delay,
      ],
    );
    await client.query(
      `UPDATE "OutboxEvent" SET "availableAt"=clock_timestamp()+$3*interval '1 second',"processedAt"=CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END,attempts=$5 WHERE "orgId"=$1 AND id=$2 AND "eventType"='WEATHER_FETCH' AND "aggregateId"=$6`,
      [lease.orgId, lease.eventId, delay, expired, attempts, lease.requestId],
    );
    return true;
  });
}
