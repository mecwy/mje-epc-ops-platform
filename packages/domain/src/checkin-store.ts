/**
 * Worker check-in and staged selfie (A6b; design docs/architecture/a6-field-devices-design.md
 * §3, §5, §6). A check-in is the claim "P was on site at T": it never becomes hours and never
 * fills headcount or report facts (U8). Device routes authenticate through `fieldTransaction`
 * (A6a bootstrap, decision time and clock guard); PM routes are Entra PROJECT_MANAGER writes.
 *
 * Lock order (§5): throttle (T) → idempotency key (I) → device row share (2) → report day (4)
 * → slot (5) → selfie row / check-in row (6) → FieldDay counter (7). The decision time is taken
 * once every lock it depends on is held; every deadline is judged at it and every time written
 * is it. Coordinates never reach an error, an event, an audit row or an idempotency record.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CheckInCommand,
  CheckInFlag,
  CheckInKind,
  CheckInListDto,
  CheckInResultDto,
  CheckInRowDto,
  CrewAttribution,
  FieldSettingsCommand,
  FieldSettingsDto,
  FixInput,
  PmProxyCheckInCommand,
  ProxyCheckInCommand,
  SelfieUploadDto,
  SiteReferenceCommand,
  VoidCheckInCommand,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  FieldError,
  FieldThrottle,
  decisionTime,
  deviceEvent,
  fieldTransaction,
  keyLock,
  priorOutcome,
  recordOutcome,
} from './field-kit.js';
import {
  FIX_STALE_MS,
  PM_PROXY_DAYS_DEFAULT,
  SELFIE_STAGED_MS,
  admitDeviceTimes,
  distanceBucket,
  fence,
  localDate,
  proxyLocationFlags,
  type Fix,
  type SiteReference,
} from './checkin-rules.js';
import { mediaTypeMatches } from './photo-file.js';
import { daysBetween } from './report-rules.js';
import { withoutLocationMetadata } from './photo-strip.js';
import type { PhotoBlobStore, PhotoFile } from './photo-store.js';
import {
  audit,
  inTransaction,
  lockReportDay,
  projectWriter,
  type Actor,
} from './store-kit.js';

/** Selfie bytes; `delete` of a missing key succeeds (a blob already gone counts as deleted). */
export interface SelfieBlobStore extends PhotoBlobStore {
  delete(key: string): Promise<void>;
}
export const SELFIE_MAX_BYTES = 3 * 1024 * 1024;
export const SELFIE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export interface CheckInStoreOptions {
  /** TEST seam, read per request: false switches deferred housekeeping off. */
  housekeeping?: boolean;
}
interface FieldSettings {
  n: number;
  selfieEnabled: boolean;
  pmProxyDays: number;
}
/** What a submitted revision freezes of the day's check-ins (rule 1): never hours or headcount. */
export interface FieldDayAsOf {
  seqBoundary: number;
  summary: CheckInListDto['summary'];
  checkIns: {
    checkInId: string;
    personId: string;
    kind: CheckInKind;
    occurredAt: string | null;
    timePrecision: 'EXACT' | 'DAY';
    crewId: string | null;
    crewAttribution: CrewAttribution;
    flags: CheckInFlag[];
    hasSelfie: boolean;
    daySeq: number;
  }[];
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const fixOf = (f: FixInput): Fix => ({
  lat: Number(f.lat),
  lon: Number(f.lon),
  accuracyM: Number(f.accuracyM),
});

// ---------- shared reads and locks ----------
async function siteReference(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<SiteReference | null> {
  const r = await client.query<{
    n: number;
    lat: string;
    lon: string;
    radiusM: number;
  }>(
    `SELECT n, lat, lon, "radiusM" FROM "ProjectSiteReference" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY n DESC LIMIT 1`,
    [orgId, projectId],
  );
  const row = r.rows[0];
  return row
    ? {
        n: row.n,
        lat: Number(row.lat),
        lon: Number(row.lon),
        radiusM: row.radiusM,
      }
    : null;
}
async function fieldSettings(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<FieldSettings> {
  const r = await client.query<FieldSettings>(
    `SELECT n, "selfieEnabled", "pmProxyDays" FROM "ProjectFieldSetting" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY n DESC LIMIT 1`,
    [orgId, projectId],
  );
  // U1: selfie is off until a project enables it.
  return (
    r.rows[0] ?? {
      n: 0,
      selfieEnabled: false,
      pmProxyDays: PM_PROXY_DAYS_DEFAULT,
    }
  );
}
async function projectTimezone(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<string> {
  const r = await client.query<{ timezone: string }>(
    `SELECT timezone FROM "Project" WHERE "orgId"=$1 AND id=$2`,
    [orgId, projectId],
  );
  const tz = r.rows[0]!.timezone;
  // An invalid master-data zone must never silently become the server's.
  new Intl.DateTimeFormat('en', { timeZone: tz });
  return tz;
}
/** Level 5: one writer per (project, person, business day) slot. */
const slotLock = (
  client: PoolClient,
  orgId: string,
  projectId: string,
  personId: string,
  businessDate: string,
) =>
  client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${orgId}:field-slot:${projectId}:${personId}:${businessDate}`,
  ]);
/** Level 7: the next field sequence number of the day (the caller holds the day lock, level 4). */
async function nextSeq(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<number> {
  const r = await client.query<{ lastSeq: string }>(
    `INSERT INTO "FieldDay"(id,"orgId","projectId","businessDate","lastSeq") VALUES($1,$2,$3,$4::date,1)
    ON CONFLICT ("orgId","projectId","businessDate") DO UPDATE SET "lastSeq" = "FieldDay"."lastSeq" + 1
    RETURNING "lastSeq"`,
    [randomUUID(), orgId, projectId, businessDate],
  );
  return Number(r.rows[0]!.lastSeq);
}
/**
 * The field sequence frozen by the day's latest submitted revision, or null when the day was
 * never submitted. A revision from before check-ins existed froze none (0).
 */
async function submittedBoundary(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<number | null> {
  const r = await client.query<{ boundary: string | null }>(
    `SELECT COALESCE(r.snapshot->'field'->>'seqBoundary', '0') AS boundary FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND d."scopeKey"='report' AND d."currentRevisionNumber" > 0`,
    [orgId, projectId, businessDate],
  );
  const b = r.rows[0]?.boundary;
  return b === undefined || b === null ? null : Number(b);
}
/** The crew the person is a MEMBER of at an instant (exact timestamps). */
async function crewAt(
  client: PoolClient,
  orgId: string,
  projectId: string,
  personId: string,
  at: string,
  role: 'MEMBER' | 'FOREMAN' = 'MEMBER',
): Promise<string | null> {
  const r = await client.query<{ crewId: string }>(
    `SELECT "crewId" FROM "CrewAssignment" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND role=$5
      AND "validFrom" <= $4::timestamptz AND ("validUntil" IS NULL OR $4::timestamptz < "validUntil")`,
    [orgId, projectId, personId, at, role],
  );
  return r.rows[0]?.crewId ?? null;
}
/** A target person never rostered in the project (other org, none) is NOT_FOUND. */
async function assertInProject(
  client: PoolClient,
  orgId: string,
  projectId: string,
  personId: string,
) {
  const r = await client.query(
    `SELECT 1 FROM "CrewAssignment" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 LIMIT 1`,
    [orgId, projectId, personId],
  );
  if (!r.rowCount) throw new FieldError('NOT_FOUND');
}
async function existingCheckIn(
  client: PoolClient,
  orgId: string,
  projectId: string,
  personId: string,
  businessDate: string,
) {
  const r = await client.query<{ occurredAt: Date | null; kind: string }>(
    `SELECT "occurredAt", kind FROM "WorkerCheckIn"
    WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND "businessDate"=$4::date AND "voidedAt" IS NULL`,
    [orgId, projectId, personId, businessDate],
  );
  const row = r.rows[0];
  if (row)
    throw new FieldError('ALREADY_CHECKED_IN', {
      occurredAt: iso(row.occurredAt),
      kind: row.kind,
    });
}
/** Another project of the org has a non-voided check-in for the person that day (allowed, flagged). */
async function multiProjectDay(
  client: PoolClient,
  orgId: string,
  projectId: string,
  personId: string,
  businessDate: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM "WorkerCheckIn" WHERE "orgId"=$1 AND "personId"=$3 AND "businessDate"=$4::date
      AND "projectId" <> $2 AND "voidedAt" IS NULL LIMIT 1`,
    [orgId, projectId, personId, businessDate],
  );
  return r.rowCount === 1;
}

/** The revision's field part, read under the day lock the submission holds (level 4). */
export async function fieldDayAsOf(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<FieldDayAsOf> {
  const day = await client.query<{ lastSeq: string }>(
    `SELECT "lastSeq" FROM "FieldDay" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date`,
    [orgId, projectId, businessDate],
  );
  const seqBoundary = Number(day.rows[0]?.lastSeq ?? 0);
  const r = await client.query<{
    checkInId: string;
    personId: string;
    kind: CheckInKind;
    occurredAt: Date | null;
    timePrecision: 'EXACT' | 'DAY';
    crewId: string | null;
    crewAttribution: CrewAttribution;
    flags: CheckInFlag[];
    hasSelfie: boolean;
    daySeq: string;
  }>(
    `SELECT c.id AS "checkInId", c."personId", c.kind, c."occurredAt", c."timePrecision", c."crewId", c."crewAttribution",
      c.flags, EXISTS (SELECT 1 FROM "CheckInSelfie" s WHERE s."orgId"=c."orgId" AND s."checkInId"=c.id) AS "hasSelfie", c."daySeq"
    FROM "WorkerCheckIn" c WHERE c."orgId"=$1 AND c."projectId"=$2 AND c."businessDate"=$3::date
      AND c."daySeq" <= $4 AND (c."voidSeq" IS NULL OR c."voidSeq" > $4)
    ORDER BY c."daySeq"`,
    [orgId, projectId, businessDate, seqBoundary],
  );
  const checkIns = r.rows.map((c) => ({
    ...c,
    occurredAt: iso(c.occurredAt),
    daySeq: Number(c.daySeq),
  }));
  return { seqBoundary, summary: summarize(checkIns), checkIns };
}
function summarize(
  rows: { personId: string; kind: CheckInKind; flags: CheckInFlag[] }[],
): CheckInListDto['summary'] {
  return {
    present: new Set(rows.map((c) => c.personId)).size,
    self: rows.filter((c) => c.kind === 'SELF').length,
    proxy: rows.filter((c) => c.kind !== 'SELF').length,
    flagged: rows.filter((c) => c.flags.length > 0).length,
  };
}

type DeviceOutcome =
  | { kind: 'ok'; body: CheckInResultDto }
  | { kind: 'refused'; code: FieldError['code'] };

export class CheckInStore {
  readonly throttle: FieldThrottle;
  constructor(
    private readonly pool: Pool,
    private readonly blobs: SelfieBlobStore | null,
    private readonly options: CheckInStoreOptions = {},
  ) {
    this.throttle = new FieldThrottle(pool);
  }
  private get deferred() {
    return this.options.housekeeping !== false;
  }

  // ---------- device: staged selfie ----------
  /**
   * U1: a selfie is staged first (self only, project switch on), idempotent on key + sha256.
   * Location metadata is removed before the bytes are stored; the key names the row.
   */
  async uploadSelfie(
    ip: string,
    tokenHash: string,
    cmd: { clientMutationId: string },
    file: PhotoFile,
  ): Promise<SelfieUploadDto> {
    if (file.bytes.length > SELFIE_MAX_BYTES)
      throw new FieldError('SELFIE_TOO_LARGE');
    if (
      !file.bytes.length ||
      !mediaTypeMatches(file.mediaType, file.bytes, SELFIE_MEDIA_TYPES)
    )
      throw new FieldError('UNSUPPORTED_MEDIA');
    const stored = withoutLocationMetadata(file.bytes);
    if (!stored) throw new FieldError('UNSUPPORTED_MEDIA');
    const route = 'FIELD_SELFIE';
    const command = {
      clientMutationId: cmd.clientMutationId,
      sha256: sha256(file.bytes),
      mediaType: file.mediaType,
    };
    let written: string | null = null;
    // Set once `work` has returned: the COMMIT is then sent and its outcome may be unknown.
    let committing = false;
    let owner: { orgId: string; deviceId: string } | null = null;
    try {
      return await fieldTransaction(
        this.pool,
        this.throttle,
        tokenHash,
        ip,
        {
          deferred: this.deferred,
          keyLock: { route, key: cmd.clientMutationId },
        },
        async (client, { device: d, at, now }) => {
          if (!this.blobs) throw new FieldError('FEATURE_OFF');
          owner = { orgId: d.orgId, deviceId: d.id };
          const settings = await fieldSettings(client, d.orgId, d.projectId);
          if (!settings.selfieEnabled) throw new FieldError('FEATURE_OFF');
          const prior = await priorOutcome<SelfieUploadDto>(
            client,
            d.orgId,
            d.id,
            route,
            cmd.clientMutationId,
            command,
          );
          if (prior) return prior.body as SelfieUploadDto;
          const id = randomUUID();
          const key = `selfie/${d.orgId}/${id}`;
          const expiresAt = new Date(now.getTime() + SELFIE_STAGED_MS);
          await client.query(
            `INSERT INTO "FieldSelfie"(id,"orgId","projectId","personId","deviceId",sha256,"blobKey","mediaType","sizeBytes",state,"createdAt","expiresAt")
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'STAGED',$10::timestamptz,$11::timestamptz)`,
            [
              id,
              d.orgId,
              d.projectId,
              d.personId,
              d.id,
              sha256(stored),
              key,
              file.mediaType,
              stored.length,
              at,
              expiresAt.toISOString(),
            ],
          );
          written = key;
          await this.blobs.put(key, stored, file.mediaType);
          const body: SelfieUploadDto = {
            selfieId: id,
            expiresAt: expiresAt.toISOString(),
          };
          await recordOutcome(
            client,
            d.orgId,
            d.id,
            route,
            cmd.clientMutationId,
            command,
            { status: 200, body },
          );
          committing = true;
          return body;
        },
      );
    } catch (error) {
      if (!written || !this.blobs || !owner) throw error;
      if (!committing) {
        // `work` failed before any COMMIT was sent: the row cannot have committed, so the
        // image it would have named is removed (best-effort).
        await this.blobs.delete(written).catch(() => undefined);
        throw error;
      }
      // The COMMIT was sent but its acknowledgement was lost: settle the outcome under the same
      // key lock (so an in-flight original finishes first). Committed → the stored result;
      // certainly not committed → remove the image; unknown → leave it (never delete an image
      // a committed row may name).
      const settled = await this.settleUpload(
        owner,
        route,
        cmd.clientMutationId,
        command,
        written,
      ).catch(() => undefined);
      if (settled) return settled;
      throw error;
    }
  }
  private async settleUpload(
    owner: { orgId: string; deviceId: string },
    route: string,
    key: string,
    command: unknown,
    blobKey: string,
  ): Promise<SelfieUploadDto | null> {
    const prior = await this.orgTx(owner.orgId, async (c) => {
      await keyLock(c, owner.orgId, owner.deviceId, route, key);
      return priorOutcome<SelfieUploadDto>(
        c,
        owner.orgId,
        owner.deviceId,
        route,
        key,
        command,
      );
    });
    if (prior) return prior.body as SelfieUploadDto;
    await this.blobs!.delete(blobKey);
    return null;
  }

  // ---------- device: self and foreman-proxy check-in ----------
  async checkIn(
    ip: string,
    tokenHash: string,
    cmd: CheckInCommand,
  ): Promise<CheckInResultDto> {
    return this.deviceCheckIn(ip, tokenHash, 'SELF', {
      ...cmd,
      personId: null,
    });
  }
  async proxyCheckIn(
    ip: string,
    tokenHash: string,
    cmd: ProxyCheckInCommand,
  ): Promise<CheckInResultDto> {
    return this.deviceCheckIn(ip, tokenHash, 'FOREMAN_PROXY', {
      ...cmd,
      stagedSelfieId: null,
    });
  }
  private async deviceCheckIn(
    ip: string,
    tokenHash: string,
    kind: 'SELF' | 'FOREMAN_PROXY',
    cmd: Omit<CheckInCommand, 'stagedSelfieId'> & {
      personId: string | null;
      stagedSelfieId: string | null;
    },
  ): Promise<CheckInResultDto> {
    const route = kind === 'SELF' ? 'FIELD_CHECKIN' : 'FIELD_CHECKIN_PROXY';
    // The event is hashed; deviceSentAt is transport (refreshed on a retry) and is not.
    const event =
      kind === 'SELF'
        ? {
            businessDate: cmd.businessDate,
            occurredAt: cmd.occurredAt,
            fix: cmd.fix,
            stagedSelfieId: cmd.stagedSelfieId,
          }
        : {
            personId: cmd.personId,
            businessDate: cmd.businessDate,
            occurredAt: cmd.occurredAt,
            fix: cmd.fix,
          };
    const outcome = await fieldTransaction<DeviceOutcome>(
      this.pool,
      this.throttle,
      tokenHash,
      ip,
      {
        deferred: this.deferred,
        keyLock: { route, key: cmd.clientMutationId },
        // Levels 4, 5 and 6 before the decision time, so a request that waited on the day
        // lock (a submission) or the selfie row (a cleanup claim) is judged after the wait.
        afterLock: async (client, d) => {
          const subject = cmd.personId ?? d.personId;
          await lockReportDay(client, d.orgId, d.projectId, cmd.businessDate);
          await slotLock(
            client,
            d.orgId,
            d.projectId,
            subject,
            cmd.businessDate,
          );
          if (cmd.stagedSelfieId)
            await client.query(
              `SELECT id FROM "FieldSelfie" WHERE "orgId"=$1 AND id=$2 FOR UPDATE`,
              [d.orgId, cmd.stagedSelfieId],
            );
        },
      },
      async (client, { device: d, now: t, at }) => {
        const subject = cmd.personId ?? d.personId;
        // Resource authorization (before the idempotency lookup, so a replay re-runs it).
        let crewId: string | null;
        if (kind === 'FOREMAN_PROXY') {
          if (subject === d.personId) throw new FieldError('PROXY_NOT_ALLOWED');
          await assertInProject(client, d.orgId, d.projectId, subject);
          // Actor authority at the decision time; the subject in that crew now and at occurredAt.
          const crew = await crewAt(
            client,
            d.orgId,
            d.projectId,
            d.personId,
            at,
            'FOREMAN',
          );
          const now = await crewAt(client, d.orgId, d.projectId, subject, at);
          crewId = await crewAt(
            client,
            d.orgId,
            d.projectId,
            subject,
            cmd.occurredAt,
          );
          if (!crew || now !== crew || crewId !== crew)
            throw new FieldError('PROXY_NOT_ALLOWED');
        } else {
          crewId = await crewAt(
            client,
            d.orgId,
            d.projectId,
            subject,
            cmd.occurredAt,
          );
          if (!crewId) throw new FieldError('PERSON_NOT_ROSTERED');
        }
        let selfie: { state: string; expiresAt: Date } | null = null;
        if (cmd.stagedSelfieId) {
          const s = await client.query<{ state: string; expiresAt: Date }>(
            `SELECT state, "expiresAt" FROM "FieldSelfie"
            WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND "deviceId"=$4 AND "personId"=$5`,
            [d.orgId, d.projectId, cmd.stagedSelfieId, d.id, d.personId],
          );
          // Someone else's, another project's, another org's or none: the same NOT_FOUND.
          if (!s.rows[0]) throw new FieldError('NOT_FOUND');
          selfie = s.rows[0];
        }
        const prior = await priorOutcome<CheckInResultDto>(
          client,
          d.orgId,
          d.id,
          route,
          cmd.clientMutationId,
          event,
        );
        // A replay returns the stored result: no time or geofence rule is re-run.
        if (prior) return { kind: 'ok', body: prior.body as CheckInResultDto };
        const refuse = async (
          code: FieldError['code'],
          distance: number | null = null,
        ): Promise<DeviceOutcome> => {
          await deviceEvent(client, {
            orgId: d.orgId,
            projectId: d.projectId,
            deviceId: d.id,
            personId: subject,
            kind: 'CHECKIN_REFUSED',
            reason: code,
            actor: { deviceId: d.id, personId: d.personId },
            distanceBucketM:
              distance === null ? null : distanceBucket(distance),
          });
          return { kind: 'refused', code };
        };
        const timeZone = await projectTimezone(client, d.orgId, d.projectId);
        const time = admitDeviceTimes({
          occurredAt: new Date(cmd.occurredAt),
          fixAt: new Date(cmd.fix.fixAt),
          deviceSentAt: new Date(cmd.deviceSentAt),
          receivedAt: t,
          businessDate: cmd.businessDate,
          timeZone,
        });
        if (!time.ok) return refuse(time.code);
        const ref = await siteReference(client, d.orgId, d.projectId);
        const fenced = fence(fixOf(cmd.fix), ref);
        if (!fenced.ok) return refuse(fenced.code, fenced.distanceM);
        await existingCheckIn(
          client,
          d.orgId,
          d.projectId,
          subject,
          cmd.businessDate,
        );
        if (selfie) {
          const settings = await fieldSettings(client, d.orgId, d.projectId);
          if (!settings.selfieEnabled) throw new FieldError('FEATURE_OFF');
          // Row-locked (level 6): STAGED and unexpired at the decision time, or nothing.
          if (
            selfie.state !== 'STAGED' ||
            selfie.expiresAt.getTime() <= t.getTime()
          )
            throw new FieldError('SELFIE_EXPIRED');
        }
        const flags: CheckInFlag[] = [...time.flags, ...fenced.flags];
        if (
          await multiProjectDay(
            client,
            d.orgId,
            d.projectId,
            subject,
            cmd.businessDate,
          )
        )
          flags.push('MULTI_PROJECT_DAY');
        const boundary = await submittedBoundary(
          client,
          d.orgId,
          d.projectId,
          cmd.businessDate,
        );
        const seq = await nextSeq(
          client,
          d.orgId,
          d.projectId,
          cmd.businessDate,
        );
        const id = randomUUID();
        const self = kind === 'SELF';
        const distance = Math.round(fenced.distanceM);
        await client.query(
          `INSERT INTO "WorkerCheckIn"(id,"orgId","projectId","personId","businessDate","siteTimezone",kind,"crewId","crewAttribution",
            "deviceId","actorPersonId","occurredAt","timePrecision","fixAt","deviceSentAt","receivedAt","clockSkewMs",
            lat,lon,"accuracyM","distanceM","siteRefN","actorLat","actorLon","actorAccuracyM","actorFixAt","actorDistanceM",flags,"daySeq")
          VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,'OCCURRED_AT',$9,$10,$11::timestamptz,'EXACT',$12::timestamptz,$13::timestamptz,$14::timestamptz,$15,
            $16,$17,$18,$19,$20,$21,$22,$23,$24::timestamptz,$25,$26::text[],$27)`,
          [
            id,
            d.orgId,
            d.projectId,
            subject,
            cmd.businessDate,
            timeZone,
            kind,
            crewId,
            d.id,
            d.personId,
            cmd.occurredAt,
            cmd.fix.fixAt,
            cmd.deviceSentAt,
            at,
            t.getTime() - new Date(cmd.deviceSentAt).getTime(),
            self ? cmd.fix.lat : null,
            self ? cmd.fix.lon : null,
            self ? cmd.fix.accuracyM : null,
            self ? distance : null,
            ref!.n,
            self ? null : cmd.fix.lat,
            self ? null : cmd.fix.lon,
            self ? null : cmd.fix.accuracyM,
            self ? null : cmd.fix.fixAt,
            self ? null : distance,
            flags,
            seq,
          ],
        );
        if (selfie) {
          await client.query(
            `UPDATE "FieldSelfie" SET state='ATTACHED', "attachedAt"=$3::timestamptz WHERE "orgId"=$1 AND id=$2`,
            [d.orgId, cmd.stagedSelfieId, at],
          );
          await client.query(
            `INSERT INTO "CheckInSelfie"(id,"orgId","projectId","personId","checkInId","selfieId") VALUES($1,$2,$3,$4,$5,$6)`,
            [
              randomUUID(),
              d.orgId,
              d.projectId,
              subject,
              id,
              cmd.stagedSelfieId,
            ],
          );
        }
        const body: CheckInResultDto = {
          checkInId: id,
          businessDate: cmd.businessDate,
          kind,
          occurredAt: new Date(cmd.occurredAt).toISOString(),
          timePrecision: 'EXACT',
          flags,
          hasSelfie: !!selfie,
          afterSubmission: boundary !== null && seq > boundary,
        };
        await recordOutcome(
          client,
          d.orgId,
          d.id,
          route,
          cmd.clientMutationId,
          event,
          { status: 200, body },
        );
        return { kind: 'ok', body };
      },
    );
    // A refused attempt committed its event; it is a request error, never a finding.
    if (outcome.kind === 'refused') throw new FieldError(outcome.code);
    return outcome.body;
  }

  // ---------- project manager ----------
  private pm<T>(
    identity: Identity,
    projectId: string,
    work: (client: PoolClient, actor: Actor, timeZone: string) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, projectId);
      return work(client, actor, project.timezone);
    });
  }
  /**
   * U3: a PM proxy, on or off site, back to the project's window (default 7 days). Without a
   * time it is DAY precision (never invented). The PM's fix only yields flags and is stored as
   * the actor's location, never the worker's.
   */
  async pmProxy(
    identity: Identity,
    cmd: PmProxyCheckInCommand,
  ): Promise<CheckInResultDto> {
    const route = 'FIELD_PM_PROXY';
    return this.pm(identity, cmd.projectId, async (client, actor, timeZone) => {
      const { orgId } = actor;
      const projectId = cmd.projectId;
      await assertInProject(client, orgId, projectId, cmd.personId);
      await keyLock(
        client,
        orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
      );
      const prior = await priorOutcome<CheckInResultDto>(
        client,
        orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
      );
      if (prior) return prior.body as CheckInResultDto;
      await lockReportDay(client, orgId, projectId, cmd.businessDate);
      await slotLock(client, orgId, projectId, cmd.personId, cmd.businessDate);
      const { t, at } = await decisionTime(client, orgId, projectId);
      const today = localDate(t, timeZone);
      const back = daysBetween(cmd.businessDate, today);
      if (back < 0) throw new FieldError('TIME_ORDER_INVALID');
      const settings = await fieldSettings(client, orgId, projectId);
      if (back > settings.pmProxyDays) throw new FieldError('TOO_LATE');
      let crewId: string | null;
      let crewAttribution: CrewAttribution;
      if (cmd.occurredAt) {
        const occurred = new Date(cmd.occurredAt);
        if (occurred.getTime() > t.getTime())
          throw new FieldError('TIME_ORDER_INVALID');
        if (localDate(occurred, timeZone) !== cmd.businessDate)
          throw new FieldError('BUSINESS_DAY_MISMATCH');
        crewId = await crewAt(
          client,
          orgId,
          projectId,
          cmd.personId,
          cmd.occurredAt,
        );
        if (!crewId) throw new FieldError('PERSON_NOT_ROSTERED');
        crewAttribution = 'OCCURRED_AT';
      } else {
        // Any MEMBER interval overlapping the site day [00:00, 24:00), including people who
        // have since left; the crew only when exactly one crew overlaps it.
        const crews = await client.query<{ crewId: string }>(
          `SELECT DISTINCT "crewId" FROM "CrewAssignment" WHERE "orgId"=$1 AND "projectId"=$2 AND "personId"=$3 AND role='MEMBER'
            AND tstzrange("validFrom", "validUntil", '[)')
              && tstzrange(($4::date)::timestamp AT TIME ZONE $5, ($4::date + 1)::timestamp AT TIME ZONE $5, '[)')`,
          [orgId, projectId, cmd.personId, cmd.businessDate, timeZone],
        );
        if (!crews.rowCount) throw new FieldError('PERSON_NOT_ROSTERED');
        crewId = crews.rowCount === 1 ? crews.rows[0]!.crewId : null;
        crewAttribution = crewId ? 'ONLY_CREW_OF_DAY' : 'UNKNOWN';
      }
      if (
        cmd.actorFix &&
        Math.abs(t.getTime() - new Date(cmd.actorFix.fixAt).getTime()) >
          FIX_STALE_MS
      )
        throw new FieldError('FIX_TIME_INVALID');
      const ref = await siteReference(client, orgId, projectId);
      const loc = proxyLocationFlags(
        cmd.actorFix ? fixOf(cmd.actorFix) : null,
        ref,
      );
      if ((cmd.businessDate !== today || loc.flags.length) && !cmd.reason)
        throw new FieldError('REASON_REQUIRED');
      await existingCheckIn(
        client,
        orgId,
        projectId,
        cmd.personId,
        cmd.businessDate,
      );
      const flags: CheckInFlag[] = [...loc.flags];
      if (
        await multiProjectDay(
          client,
          orgId,
          projectId,
          cmd.personId,
          cmd.businessDate,
        )
      )
        flags.push('MULTI_PROJECT_DAY');
      const boundary = await submittedBoundary(
        client,
        orgId,
        projectId,
        cmd.businessDate,
      );
      const seq = await nextSeq(client, orgId, projectId, cmd.businessDate);
      const id = randomUUID();
      // The PM's own fix, kept as the actor's location (with its distance when a reference exists).
      const fix = cmd.actorFix;
      await client.query(
        `INSERT INTO "WorkerCheckIn"(id,"orgId","projectId","personId","businessDate","siteTimezone",kind,"crewId","crewAttribution",
          "actorPersonId","actorAccountId","occurredAt","timePrecision","receivedAt","siteRefN","actorLat","actorLon","actorAccuracyM",
          "actorFixAt","actorDistanceM",source,reason,flags,"daySeq")
        VALUES($1,$2,$3,$4,$5::date,$6,'PM_PROXY',$7,$8,$9,$10,$11::timestamptz,$12,$13::timestamptz,$14,$15,$16,$17,$18::timestamptz,$19,$20,$21,$22::text[],$23)`,
        [
          id,
          orgId,
          projectId,
          cmd.personId,
          cmd.businessDate,
          timeZone,
          crewId,
          crewAttribution,
          actor.personId,
          actor.accountId,
          cmd.occurredAt,
          cmd.occurredAt ? 'EXACT' : 'DAY',
          at,
          fix && ref ? ref.n : null,
          fix?.lat ?? null,
          fix?.lon ?? null,
          fix?.accuracyM ?? null,
          fix?.fixAt ?? null,
          loc.distanceM === null ? null : Math.round(loc.distanceM),
          cmd.source,
          cmd.reason || null,
          flags,
          seq,
        ],
      );
      const body: CheckInResultDto = {
        checkInId: id,
        businessDate: cmd.businessDate,
        kind: 'PM_PROXY',
        occurredAt: cmd.occurredAt
          ? new Date(cmd.occurredAt).toISOString()
          : null,
        timePrecision: cmd.occurredAt ? 'EXACT' : 'DAY',
        flags,
        hasSelfie: false,
        afterSubmission: boundary !== null && seq > boundary,
      };
      await audit(
        client,
        actor,
        { type: 'WORKER_CHECK_IN', id, version: 1 },
        'FIELD_PM_PROXY',
        cmd.reason,
        null,
        {
          personId: cmd.personId,
          businessDate: cmd.businessDate,
          timePrecision: body.timePrecision,
          source: cmd.source,
          flags,
          daySeq: seq,
        },
        cmd.clientMutationId,
      );
      await recordOutcome(
        client,
        orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
        { status: 200, body },
      );
      return body;
    });
  }
  /** PM only, reason required; the void columns are set once and take the next day sequence. */
  async voidCheckIn(identity: Identity, cmd: VoidCheckInCommand) {
    const route = 'FIELD_CHECKIN_VOID';
    return this.pm(identity, cmd.projectId, async (client, actor) => {
      const { orgId } = actor;
      const found = await client.query<{ businessDate: string }>(
        `SELECT "businessDate"::text AS "businessDate" FROM "WorkerCheckIn" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3`,
        [orgId, cmd.projectId, cmd.checkInId],
      );
      const row = found.rows[0];
      if (!row) throw new FieldError('NOT_FOUND');
      await keyLock(
        client,
        orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
      );
      const prior = await priorOutcome<{
        checkInId: string;
        voidSeq: number;
        afterSubmission: boolean;
      }>(client, orgId, actor.accountId, route, cmd.clientMutationId, cmd);
      if (prior) return prior.body;
      await lockReportDay(client, orgId, cmd.projectId, row.businessDate);
      const locked = await client.query<{ voidedAt: Date | null }>(
        `SELECT "voidedAt" FROM "WorkerCheckIn" WHERE "orgId"=$1 AND id=$2 FOR UPDATE`,
        [orgId, cmd.checkInId],
      );
      if (locked.rows[0]!.voidedAt) throw new FieldError('VERSION_CONFLICT');
      const { at } = await decisionTime(client, orgId, cmd.projectId);
      const boundary = await submittedBoundary(
        client,
        orgId,
        cmd.projectId,
        row.businessDate,
      );
      const seq = await nextSeq(client, orgId, cmd.projectId, row.businessDate);
      await client.query(
        `UPDATE "WorkerCheckIn" SET "voidedAt"=$3::timestamptz, "voidedBy"=$4, "voidReason"=$5, "voidSeq"=$6 WHERE "orgId"=$1 AND id=$2`,
        [orgId, cmd.checkInId, at, actor.accountId, cmd.reason, seq],
      );
      const body = {
        checkInId: cmd.checkInId,
        voidSeq: seq,
        afterSubmission: boundary !== null && seq > boundary,
      };
      await audit(
        client,
        actor,
        { type: 'WORKER_CHECK_IN', id: cmd.checkInId, version: 1 },
        'FIELD_CHECKIN_VOID',
        cmd.reason,
        null,
        { voidSeq: seq },
        cmd.clientMutationId,
      );
      await recordOutcome(
        client,
        orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
        { status: 200, body },
      );
      return body;
    });
  }
  /**
   * The PM's check-in list of a day, beside (never instead of) the declared headcount (U8).
   * Readers get READ_ONLY: check-ins are writer data (A6.0). No coordinates.
   */
  async checkIns(
    identity: Identity,
    projectId: string,
    businessDate: string,
  ): Promise<CheckInListDto> {
    return this.pm(identity, projectId, async (client, actor) => {
      const boundary = await submittedBoundary(
        client,
        actor.orgId,
        projectId,
        businessDate,
      );
      const r = await client.query<{
        checkInId: string;
        personId: string;
        displayName: string;
        kind: CheckInKind;
        occurredAt: Date | null;
        timePrecision: 'EXACT' | 'DAY';
        crewId: string | null;
        crewAttribution: CrewAttribution;
        flags: CheckInFlag[];
        source: CheckInRowDto['source'];
        distanceM: number | null;
        selfieState: string | null;
        daySeq: string;
        voidedAt: Date | null;
        voidReason: string | null;
      }>(
        `SELECT c.id AS "checkInId", c."personId", p."displayName", c.kind, c."occurredAt", c."timePrecision", c."crewId",
          c."crewAttribution", c.flags, c.source, COALESCE(c."distanceM", c."actorDistanceM") AS "distanceM",
          (SELECT s.state FROM "CheckInSelfie" x JOIN "FieldSelfie" s ON s."orgId"=x."orgId" AND s.id=x."selfieId"
            WHERE x."orgId"=c."orgId" AND x."checkInId"=c.id) AS "selfieState",
          c."daySeq", c."voidedAt", c."voidReason"
        FROM "WorkerCheckIn" c JOIN "Person" p ON p."orgId"=c."orgId" AND p.id=c."personId"
        WHERE c."orgId"=$1 AND c."projectId"=$2 AND c."businessDate"=$3::date ORDER BY c."daySeq"`,
        [actor.orgId, projectId, businessDate],
      );
      const checkIns: CheckInRowDto[] = r.rows.map((c) => ({
        checkInId: c.checkInId,
        personId: c.personId,
        displayName: c.displayName,
        kind: c.kind,
        occurredAt: iso(c.occurredAt),
        timePrecision: c.timePrecision,
        crewId: c.crewId,
        crewAttribution: c.crewAttribution,
        flags: c.flags,
        source: c.source,
        distanceM: c.distanceM,
        selfie:
          c.selfieState === null
            ? 'NONE'
            : c.selfieState === 'ATTACHED'
              ? 'ATTACHED'
              : 'DELETED',
        daySeq: Number(c.daySeq),
        afterSubmission: boundary !== null && Number(c.daySeq) > boundary,
        voided: c.voidedAt
          ? { at: c.voidedAt.toISOString(), reason: c.voidReason! }
          : null,
      }));
      return {
        projectId,
        businessDate,
        seqBoundary: boundary,
        summary: summarize(checkIns.filter((c) => !c.voided)),
        checkIns,
      };
    });
  }
  /** PM-only read of an attached selfie; anything else (staged, deleting, deleted, none) is 404. */
  async selfie(
    identity: Identity,
    projectId: string,
    checkInId: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const target = await this.pm(identity, projectId, async (client, actor) => {
      const r = await client.query<{
        blobKey: string;
        sha256: string;
        mediaType: string;
      }>(
        `SELECT s."blobKey", s.sha256, s."mediaType" FROM "CheckInSelfie" x
        JOIN "FieldSelfie" s ON s."orgId"=x."orgId" AND s.id=x."selfieId"
        WHERE x."orgId"=$1 AND x."projectId"=$2 AND x."checkInId"=$3 AND s.state='ATTACHED'`,
        [actor.orgId, projectId, checkInId],
      );
      if (!r.rows[0]) throw new FieldError('NOT_FOUND');
      return r.rows[0];
    });
    const blob = this.blobs ? await this.blobs.get(target.blobKey) : null;
    if (!blob) throw new FieldError('NOT_FOUND');
    if (sha256(blob.bytes) !== target.sha256)
      throw new Error('Stored selfie does not match its recorded hash');
    return { bytes: blob.bytes, mediaType: target.mediaType };
  }

  // ---------- project settings (PM) ----------
  async settings(
    identity: Identity,
    projectId: string,
  ): Promise<FieldSettingsDto> {
    return this.pm(identity, projectId, async (client, actor) => {
      const ref = await client.query<{
        n: number;
        lat: string;
        lon: string;
        radiusM: number;
      }>(
        `SELECT n, lat::text AS lat, lon::text AS lon, "radiusM" FROM "ProjectSiteReference" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY n DESC LIMIT 1`,
        [actor.orgId, projectId],
      );
      const s = await fieldSettings(client, actor.orgId, projectId);
      return {
        projectId,
        siteReference: ref.rows[0] ?? null,
        settings: {
          n: s.n,
          selfieEnabled: s.selfieEnabled,
          pmProxyDays: s.pmProxyDays,
        },
      };
    });
  }
  /** A numbered, append-only settings row; `expectedN` must be the current number. */
  private numbered<T extends { clientMutationId: string; expectedN: number }>(
    identity: Identity,
    projectId: string,
    route: string,
    table: 'ProjectSiteReference' | 'ProjectFieldSetting',
    cmd: T,
    insert: (client: PoolClient, actor: Actor, n: number) => Promise<unknown>,
    after: Record<string, unknown>,
  ): Promise<{ n: number }> {
    return this.pm(identity, projectId, async (client, actor) => {
      await keyLock(
        client,
        actor.orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
      );
      const prior = await priorOutcome<{ n: number }>(
        client,
        actor.orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
      );
      if (prior) return prior.body as { n: number };
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${actor.orgId}:field-settings:${table}:${projectId}`],
      );
      const current = await client.query<{ n: number }>(
        `SELECT COALESCE(max(n), 0)::int AS n FROM "${table}" WHERE "orgId"=$1 AND "projectId"=$2`,
        [actor.orgId, projectId],
      );
      if (current.rows[0]!.n !== cmd.expectedN)
        throw new FieldError('VERSION_CONFLICT');
      const n = cmd.expectedN + 1;
      await insert(client, actor, n);
      await audit(
        client,
        actor,
        { type: 'PROJECT_FIELD_SETTINGS', id: projectId, version: n },
        route,
        '',
        null,
        { table, n, ...after },
        cmd.clientMutationId,
      );
      const body = { n };
      await recordOutcome(
        client,
        actor.orgId,
        actor.accountId,
        route,
        cmd.clientMutationId,
        cmd,
        { status: 200, body },
      );
      return body;
    });
  }
  /** U2: the site reference point and radius (50–2000 m). Audit and replay carry no coordinates. */
  async setSiteReference(identity: Identity, cmd: SiteReferenceCommand) {
    return this.numbered(
      identity,
      cmd.projectId,
      'FIELD_SITE_REFERENCE',
      'ProjectSiteReference',
      cmd,
      (client, actor, n) =>
        client.query(
          `INSERT INTO "ProjectSiteReference"(id,"orgId","projectId",n,lat,lon,"radiusM","createdBy") VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            actor.orgId,
            cmd.projectId,
            n,
            cmd.lat,
            cmd.lon,
            cmd.radiusM,
            actor.accountId,
          ],
        ),
      { radiusM: cmd.radiusM },
    );
  }
  /** U1 selfie switch and the U3 PM proxy window. */
  async setSettings(identity: Identity, cmd: FieldSettingsCommand) {
    return this.numbered(
      identity,
      cmd.projectId,
      'FIELD_SETTINGS',
      'ProjectFieldSetting',
      cmd,
      (client, actor, n) =>
        client.query(
          `INSERT INTO "ProjectFieldSetting"(id,"orgId","projectId",n,"selfieEnabled","pmProxyDays","createdBy") VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            actor.orgId,
            cmd.projectId,
            n,
            cmd.selfieEnabled,
            cmd.pmProxyDays,
            actor.accountId,
          ],
        ),
      { selfieEnabled: cmd.selfieEnabled, pmProxyDays: cmd.pmProxyDays },
    );
  }

  // ---------- selfie cleanup (worker) ----------
  private async orgTx<T>(
    orgId: string,
    work: (c: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '5s'",
      );
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
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
  /**
   * Claim, then delete (design §3). A short transaction claims eligible rows (`STAGED` expired
   * more than 5 minutes before `cutoff`, or `ATTACHED` more than 30 days before it) with
   * `FOR UPDATE SKIP LOCKED` and commits DELETING; only then are blobs deleted (missing = done),
   * and each row is set DELETED (audited) in its own transaction. A failed delete leaves the row
   * DELETING for the next sweep. `cutoff` defaults to the database clock; a test passes one.
   */
  async cleanupSelfies(
    orgId: string,
    options: { cutoff?: string; limit?: number } = {},
  ): Promise<{ claimed: number; deleted: number; failed: number }> {
    // Without a blob store nothing can be deleted: claim nothing, record nothing.
    if (!this.blobs) throw new Error('Selfie cleanup needs a blob store');
    const blobs = this.blobs;
    const limit = options.limit ?? 100;
    const cutoff = options.cutoff ?? null;
    const claimed = await this.orgTx(orgId, async (c) => {
      const r = await c.query(
        `WITH eligible AS (
          SELECT id FROM "FieldSelfie" WHERE "orgId"=$1 AND (
            (state='STAGED' AND "expiresAt" < COALESCE($2::timestamptz, clock_timestamp()) - interval '5 minutes')
            OR (state='ATTACHED' AND "attachedAt" < COALESCE($2::timestamptz, clock_timestamp()) - interval '30 days'))
          ORDER BY "expiresAt" LIMIT $3 FOR UPDATE SKIP LOCKED)
        UPDATE "FieldSelfie" s SET state='DELETING', "claimedAt"=clock_timestamp() FROM eligible
        WHERE s."orgId"=$1 AND s.id=eligible.id AND s.state IN ('STAGED','ATTACHED')
        RETURNING s.id`,
        [orgId, cutoff, limit],
      );
      return r.rowCount ?? 0;
    });
    const pending = await this.orgTx(orgId, (c) =>
      c.query<{ id: string; blobKey: string; attachedAt: Date | null }>(
        `SELECT id, "blobKey", "attachedAt" FROM "FieldSelfie" WHERE "orgId"=$1 AND state='DELETING' ORDER BY "claimedAt" LIMIT $2`,
        [orgId, limit],
      ),
    );
    let deleted = 0;
    let failed = 0;
    for (const row of pending.rows) {
      try {
        await blobs.delete(row.blobKey);
      } catch {
        failed++;
        continue;
      }
      const done = await this.orgTx(orgId, async (c) => {
        const r = await c.query(
          `UPDATE "FieldSelfie" SET state='DELETED', "deletedAt"=clock_timestamp() WHERE "orgId"=$1 AND id=$2 AND state='DELETING'`,
          [orgId, row.id],
        );
        if (!r.rowCount) return false;
        await c.query(
          `INSERT INTO "AuditLog"(id,"orgId","updatedAt","updatedBy","actorKind","entityType","entityId","entityVersion",action,reason,before,after,"correlationId")
          VALUES($1,$2,now(),'00000000-0000-0000-0000-000000000000','SYSTEM','FIELD_SELFIE',$3,1,'FIELD_SELFIE_DELETED',$4,NULL,NULL,$5)`,
          [
            randomUUID(),
            orgId,
            row.id,
            row.attachedAt ? 'RETENTION' : 'STAGED_EXPIRED',
            randomUUID(),
          ],
        );
        return true;
      });
      if (done) deleted++;
    }
    return { claimed, deleted, failed };
  }
}
