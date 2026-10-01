import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CaptureFixInput,
  LinkPhotoCommand,
  PhotoAsOfDto,
  PhotoDto,
  PhotoLinkDto,
  PhotoLocationKind,
  UnlinkPhotoCommand,
  UploadPhotoCommand,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import { photoAcceptable, type PhotoLocation } from './report-rules.js';
import { frozenPhotoViews, withheldCoordinates } from './reader-view.js';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MEDIA_TYPES,
  THUMB_MAX_BYTES,
  THUMB_MEDIA_TYPES,
  mediaTypeMatches,
  readFileClaims,
} from './photo-file.js';
import { withoutLocationMetadata } from './photo-strip.js';
import { ISSUE_KIND } from './issue-store.js';
import {
  REPORT_SCOPE,
  ReportError,
  audit,
  idempotent,
  inTransaction,
  lockReportDay,
  projectAccess,
  projectWriter,
  transactionSignal,
  type Access,
  type Actor,
} from './store-kit.js';

/**
 * Photos of the Site Daily Close (U2.1 rule 8, 1, 14). A photo supports one moment and one view;
 * it is recorded as a claim and never marks anything verified. No image content is analysed.
 *
 * - One PhotoEvidence row per distinct file per org (sha256): uploading the same bytes again for
 *   the same project and day returns the stored photo as it is; nothing is written twice and its
 *   links never change (links change only through link/unlink with the link version).
 * - camera (in-app capture) must carry a usable device fix, else NEEDS_LOCATION and nothing is
 *   stored. album uploads never carry the uploader's position; the file's own EXIF time and GPS
 *   are read here and kept as file claims (an album photo without GPS is flagged 'none').
 * - Bytes live in blob storage behind `PhotoBlobStore`, content-addressed: `${orgId}/${sha256}`
 *   for the photo, `${orgId}/${thumbSha256}.thumb` for its thumbnail. Blobs are written before the
 *   row; an object left by a rolled-back upload can only hold the bytes its key names (the store
 *   verifies an existing object) and is reused by a retry. Bytes are only served through the API
 *   after the same project access check, and re-hashed before they are.
 * - A read-only account (OD18) only ever sees photos frozen in a submitted revision of the
 *   project, with the link they had there. A photo id the caller may not see (missing, another
 *   project, or unfrozen for a reader) is NOT_FOUND on every photo route, never FORBIDDEN.
 * - OD20: a reader sees whether a photo has a position and its claimed accuracy, never the
 *   coordinates (reader-view `withheldCoordinates`, applied to every reader photo view), and
 *   gets image bytes without location metadata (photo-strip). The PHOTO_ELSEWHERE refusal of a
 *   duplicate file is unchanged (only writers upload).
 * - A photo backs one work item or one issue. Link changes are append-only (supersede + insert),
 *   so the history stays and a submitted revision keeps the link it froze. An unlinked photo is
 *   staging only: a submission freezes just the photos with a valid current link.
 * - Uploads follow the day lock of the facts: a submitted day accepts photos only while a
 *   correction is open. Link changes do not change a submitted revision (rule 1) and are allowed
 *   on any day by the project manager.
 */

/** Blob storage port; the Azure implementation lives in the API (no SDK in the domain). */
export interface PhotoBlob {
  bytes: Uint8Array;
  contentType: string;
}
export interface PhotoBlobStore {
  /**
   * Stores bytes under a content-addressed key. If the key already exists it must hold exactly
   * these bytes (else the call fails; nothing is overwritten); its content type is set to this one.
   */
  put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<PhotoBlob | null>;
}

/** ADR-0003 D5: an external wait inside an account transaction has an operation deadline. */
export const BLOB_DEADLINE_MS = 15_000;
/** A Blob call passed its deadline (or its transaction ended); repeating it is safe (RETRY). */
export class BlobDeadlineError extends Error {
  readonly code = 'BLOB_DEADLINE';
  constructor() {
    super('BLOB_DEADLINE');
  }
}
/**
 * Runs one Blob call with an AbortSignal that fires at the deadline or when `outer` aborts (the
 * transaction's connection was lost). The call is also raced, so a store that ignores the
 * signal cannot keep the transaction waiting.
 */
export async function withBlobDeadline<T>(
  ms: number,
  outer: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BlobDeadlineError()), ms);
  const onOuter = () => controller.abort(new BlobDeadlineError());
  outer?.addEventListener('abort', onOuter, { once: true });
  if (outer?.aborted) onOuter();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new BlobDeadlineError());
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    const running = call(controller.signal);
    running.catch(() => undefined);
    return await Promise.race([running, aborted]);
  } catch (error) {
    // An SDK abort error after the deadline is the deadline.
    if (controller.signal.aborted) throw new BlobDeadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}
/** The photo view as the caller's access sees it (OD20); writers are not affected. */
const photoFor =
  (access: Access) =>
  <P extends PhotoDto>(p: P): P =>
    access === 'read' ? { ...p, ...withheldCoordinates(p) } : p;
export interface PhotoFile {
  bytes: Uint8Array;
  /** The media type the client declared; checked against the magic bytes. */
  mediaType: string;
}
export interface PhotoUpload {
  command: UploadPhotoCommand;
  photo: PhotoFile;
  thumbnail: PhotoFile | null;
}
export type PhotoUploadResult = PhotoDto & { deduplicated: boolean };

interface PhotoRow {
  id: string;
  projectId: string;
  businessDate: string;
  source: 'camera' | 'album';
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  blobKey: string;
  thumbBlobKey: string | null;
  thumbMediaType: string | null;
  thumbSha256: string | null;
  captureLat: string | null;
  captureLon: string | null;
  captureAccuracyM: string | null;
  captureFixAt: Date | null;
  deviceCapturedAt: Date | null;
  fileTakenAt: Date | null;
  fileTakenLocal: string | null;
  fileGpsLat: string | null;
  fileGpsLon: string | null;
  receivedAt: Date;
  uploadedByPersonId: string;
  workItemKey: string | null;
  issueId: string | null;
  linkVersion: number;
}
interface LinkRow {
  id: string;
  workItemKey: string | null;
  issueId: string | null;
}

// Report photos have a business date; the Phase 0 kinds without one are never served here.
// linkVersion counts link changes: every inserted link and every superseded one.
const PHOTO_SELECT = `SELECT p.id, p."projectId", p."businessDate"::text AS "businessDate", p.source, p."mediaType",
  p."sizeBytes"::int AS "sizeBytes", p.sha256, p."blobKey", p."thumbBlobKey", p."thumbMediaType", p."thumbSha256",
  p."captureLat"::text AS "captureLat", p."captureLon"::text AS "captureLon", p."captureAccuracyM"::text AS "captureAccuracyM",
  p."captureFixAt", p."deviceCapturedAt", p."fileTakenAt", p."fileTakenLocal",
  p."fileGpsLat"::text AS "fileGpsLat", p."fileGpsLon"::text AS "fileGpsLon", p."receivedAt", p."uploadedByPersonId",
  l."workItemKey", l."issueId",
  (SELECT count(*) + count(x."supersededAt") FROM "EvidenceLink" x
    WHERE x."orgId"=p."orgId" AND x."photoId"=p.id AND x."businessDate" IS NOT NULL)::int AS "linkVersion"
  FROM "PhotoEvidence" p
  LEFT JOIN "EvidenceLink" l ON l."orgId"=p."orgId" AND l."photoId"=p.id AND l."businessDate" IS NOT NULL AND l."supersededAt" IS NULL`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
function toLink(r: {
  workItemKey: string | null;
  issueId: string | null;
}): PhotoLinkDto | null {
  if (r.workItemKey !== null) return { type: 'item', id: r.workItemKey };
  if (r.issueId !== null) return { type: 'issue', id: r.issueId };
  return null;
}
function toDto(r: PhotoRow): PhotoDto {
  const capture =
    r.captureLat !== null &&
    r.captureLon !== null &&
    r.captureAccuracyM !== null &&
    r.captureFixAt !== null
      ? {
          lat: r.captureLat,
          lon: r.captureLon,
          accuracyM: r.captureAccuracyM,
          fixAt: r.captureFixAt.toISOString(),
        }
      : null;
  const gps =
    r.fileGpsLat !== null && r.fileGpsLon !== null
      ? { lat: r.fileGpsLat, lon: r.fileGpsLon }
      : null;
  const location: PhotoLocationKind = capture
    ? 'device'
    : gps
      ? 'file'
      : 'none';
  return {
    id: r.id,
    projectId: r.projectId,
    businessDate: r.businessDate,
    source: r.source,
    mediaType: r.mediaType,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    capture,
    deviceCapturedAt: iso(r.deviceCapturedAt),
    file: { takenLocal: r.fileTakenLocal, takenAt: iso(r.fileTakenAt), gps },
    location,
    // Exact for the stores' writer paths; every reader path goes through withheldCoordinates.
    coordinates: 'exact',
    hasThumbnail: r.thumbBlobKey !== null,
    receivedAt: r.receivedAt.toISOString(),
    uploadedByPersonId: r.uploadedByPersonId,
    link: toLink(r),
    linkVersion: r.linkVersion,
  };
}

/** The photos of a project's business day as they are now, in upload order. */
export async function photosOfDay(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<PhotoDto[]> {
  const r = await client.query<PhotoRow>(
    `${PHOTO_SELECT} WHERE p."orgId"=$1 AND p."projectId"=$2 AND p."businessDate"=$3::date ORDER BY p.seq`,
    [orgId, projectId, businessDate],
  );
  return r.rows.map(toDto);
}
/**
 * The photos a submitted revision froze, as a reader sees them (OD18): the stored photo with the
 * link it had in that revision, in the revision's order.
 */
export async function frozenPhotos(
  client: PoolClient,
  orgId: string,
  projectId: string,
  frozen: PhotoAsOfDto[],
): Promise<PhotoDto[]> {
  if (!frozen.length) return [];
  const r = await client.query<PhotoRow>(
    `${PHOTO_SELECT} WHERE p."orgId"=$1 AND p."projectId"=$2 AND p.id = ANY($3::uuid[]) AND p."businessDate" IS NOT NULL`,
    [orgId, projectId, frozen.map((f) => f.id)],
  );
  return frozenPhotoViews(frozen, r.rows.map(toDto));
}
/** The photos frozen in the latest submitted revision of a report day; none before a submission. */
async function latestFrozen(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<PhotoAsOfDto[]> {
  const r = await client.query<{ photos: PhotoAsOfDto[] | null }>(
    `SELECT r.snapshot->'photos' AS photos FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND d."scopeKey"=$4`,
    [orgId, projectId, businessDate, REPORT_SCOPE],
  );
  return r.rows[0]?.photos ?? [];
}
/** Whether a photo is frozen in any submitted revision of a report day of the project (OD18). */
async function isFrozen(
  client: PoolClient,
  orgId: string,
  projectId: string,
  photoId: string,
): Promise<boolean> {
  const r = await client.query<{ frozen: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId"
      WHERE r."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3
        AND r.snapshot->'photos' @> jsonb_build_array(jsonb_build_object('id', $4::text))) AS frozen`,
    [orgId, projectId, REPORT_SCOPE, photoId],
  );
  return r.rows[0]!.frozen;
}
/** The photo as the latest submitted revision that froze it has it; null if none did. */
async function latestFrozenAs(
  client: PoolClient,
  orgId: string,
  projectId: string,
  photoId: string,
): Promise<PhotoAsOfDto | null> {
  const r = await client.query<{ photo: PhotoAsOfDto }>(
    `SELECT e AS photo FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId"
      CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'photos') e
      WHERE r."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3
        AND r.snapshot->'photos' @> jsonb_build_array(jsonb_build_object('id', $4::text))
        AND e->>'id'=$4::text
      ORDER BY d."businessDate" DESC, r."revisionNumber" DESC LIMIT 1`,
    [orgId, projectId, REPORT_SCOPE, photoId],
  );
  return r.rows[0]?.photo ?? null;
}
/** What a submission freezes of a photo: source, position kind, times and the current link. */
export function photoAsOf(p: PhotoDto): PhotoAsOfDto {
  return {
    id: p.id,
    source: p.source,
    location: p.location,
    accuracyM: p.capture?.accuracyM ?? null,
    deviceCapturedAt: p.deviceCapturedAt,
    fileTakenAt: p.file.takenAt,
    fileTakenLocal: p.file.takenLocal,
    link: p.link,
  };
}
/**
 * The photos a submission takes as evidence: exactly one current link to an active work item of
 * the project or to one of its issues. Unlinked photos are staging only and are left out.
 */
export function submittedPhotos(
  photos: PhotoDto[],
  activeWorkItems: ReadonlySet<string>,
): PhotoDto[] {
  return photos.filter(
    (p) =>
      p.link !== null &&
      (p.link.type === 'issue' || activeWorkItems.has(p.link.id)),
  );
}
async function activeWorkItems(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<Set<string>> {
  const r = await client.query<{ key: string }>(
    `SELECT key FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND active`,
    [orgId, projectId],
  );
  return new Set(r.rows.map((x) => x.key));
}
/** Work items with at least one currently linked photo (coverage, rule 5). */
export function photographedItems(photos: PhotoDto[]): Set<string> {
  return new Set(
    photos.flatMap((p) => (p.link?.type === 'item' ? [p.link.id] : [])),
  );
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function checkFile(
  file: PhotoFile,
  accepted: readonly string[],
  maxBytes: number,
): PhotoFile {
  if (file.bytes.length > maxBytes) throw new ReportError('PHOTO_TOO_LARGE');
  if (
    !file.bytes.length ||
    !mediaTypeMatches(file.mediaType, file.bytes, accepted)
  )
    throw new ReportError('UNSUPPORTED_MEDIA');
  return file;
}
/** The fix as the rules see it; malformed parts were already refused by the contract. */
function location(c: CaptureFixInput | null): PhotoLocation | null {
  if (!c || c.lat === null || c.lon === null) return null;
  return {
    lat: Number(c.lat),
    lon: Number(c.lon),
    accuracyM: c.accuracyM === null ? null : Number(c.accuracyM),
    fixAt: c.fixAt,
  };
}

export class PhotoStore {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: PhotoBlobStore,
    private readonly options: { blobDeadlineMs?: number } = {},
  ) {}
  private blobCall<T>(
    client: PoolClient | null,
    call: (signal: AbortSignal) => Promise<T>,
  ) {
    return withBlobDeadline(
      this.options.blobDeadlineMs ?? BLOB_DEADLINE_MS,
      client ? transactionSignal(client) : undefined,
      call,
    );
  }

  // ---------- helpers ----------
  private async row(client: PoolClient, orgId: string, photoId: string) {
    const r = await client.query<PhotoRow>(
      `${PHOTO_SELECT} WHERE p."orgId"=$1 AND p.id=$2 AND p."businessDate" IS NOT NULL`,
      [orgId, photoId],
    );
    if (!r.rows[0]) throw new ReportError('NOT_FOUND');
    return r.rows[0];
  }
  /**
   * A photo the caller may see, else NOT_FOUND. A photo in a project the caller cannot access
   * is not found either (403 would confirm the id exists), for writers and readers alike; a
   * reader also only sees photos frozen in a submitted revision (OD18).
   */
  private async visible(
    client: PoolClient,
    actor: Actor,
    photoId: string,
  ): Promise<{ row: PhotoRow; access: Access }> {
    const row = await this.row(client, actor.orgId, photoId);
    let access: Access;
    try {
      ({ access } = await projectAccess(client, actor, row.projectId));
    } catch (error) {
      if (error instanceof ReportError && error.code === 'FORBIDDEN')
        throw new ReportError('NOT_FOUND');
      throw error;
    }
    if (
      access === 'read' &&
      !(await isFrozen(client, actor.orgId, row.projectId, row.id))
    )
      throw new ReportError('NOT_FOUND');
    return { row, access };
  }
  private async view(client: PoolClient, orgId: string, photoId: string) {
    return toDto(await this.row(client, orgId, photoId));
  }
  /** Current link and link version, under a per-photo lock so link changes apply one at a time. */
  private async linkState(client: PoolClient, orgId: string, photoId: string) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${orgId}:photo-link:${photoId}`],
    );
    const current = await client.query<LinkRow>(
      `SELECT id, "workItemKey", "issueId" FROM "EvidenceLink"
      WHERE "orgId"=$1 AND "photoId"=$2 AND "businessDate" IS NOT NULL AND "supersededAt" IS NULL`,
      [orgId, photoId],
    );
    const version = await client.query<{ n: number }>(
      `SELECT (count(*) + count("supersededAt"))::int AS n FROM "EvidenceLink"
      WHERE "orgId"=$1 AND "photoId"=$2 AND "businessDate" IS NOT NULL`,
      [orgId, photoId],
    );
    return { current: current.rows[0] ?? null, version: version.rows[0]!.n };
  }
  /** A link target is an active work item or a site-report issue of the photo's project. */
  private async assertTarget(
    client: PoolClient,
    orgId: string,
    projectId: string,
    link: PhotoLinkDto,
  ) {
    if (link.type === 'item') {
      const r = await client.query(
        `SELECT 1 FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND key=$3 AND active`,
        [orgId, projectId, link.id],
      );
      if (!r.rowCount) throw new ReportError('ITEM_NOT_FOUND');
    } else {
      const r = await client.query(
        `SELECT 1 FROM "Issue" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND kind=$4`,
        [orgId, projectId, link.id, ISSUE_KIND],
      );
      if (!r.rowCount) throw new ReportError('ISSUE_NOT_FOUND');
    }
  }
  private async insertLink(
    client: PoolClient,
    actor: Actor,
    photoId: string,
    businessDate: string,
    link: PhotoLinkDto,
  ) {
    await client.query(
      `INSERT INTO "EvidenceLink"(id,"orgId","updatedAt","updatedBy","coverageDescription","photoId","businessDate","workItemKey","issueId")
      VALUES($1,$2,now(),$3,'',$4,$5::date,$6,$7)`,
      [
        randomUUID(),
        actor.orgId,
        actor.accountId,
        photoId,
        businessDate,
        link.type === 'item' ? link.id : null,
        link.type === 'issue' ? link.id : null,
      ],
    );
  }
  private async supersede(client: PoolClient, actor: Actor, linkId: string) {
    const r = await client.query(
      `UPDATE "EvidenceLink" SET "supersededAt"=now(), "supersededBy"=$3
      WHERE "orgId"=$1 AND id=$2 AND "supersededAt" IS NULL`,
      [actor.orgId, linkId, actor.accountId],
    );
    if (r.rowCount !== 1) throw new ReportError('VERSION_CONFLICT');
  }

  // ---------- reads ----------
  async list(identity: Identity, projectId: string, businessDate: string) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { access } = await projectAccess(client, actor, projectId);
      // OD18: a reader gets only the photos of the latest submission, as it froze them.
      if (access === 'read')
        return {
          access,
          projectId,
          businessDate,
          photos: await frozenPhotos(
            client,
            actor.orgId,
            projectId,
            await latestFrozen(client, actor.orgId, projectId, businessDate),
          ),
          unlinkedPhotos: 0,
        };
      const photos = await photosOfDay(
        client,
        actor.orgId,
        projectId,
        businessDate,
      );
      const evidence = submittedPhotos(
        photos,
        await activeWorkItems(client, actor.orgId, projectId),
      );
      return {
        access,
        projectId,
        businessDate,
        photos,
        /** Photos a submission would leave out (no valid current link). */
        unlinkedPhotos: photos.length - evidence.length,
      };
    });
  }
  async get(identity: Identity, photoId: string) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { row, access } = await this.visible(client, actor, photoId);
      const photo = toDto(row);
      if (access === 'read') {
        // OD18: the reader sees the link the latest submission that froze it had.
        const frozen = await latestFrozenAs(
          client,
          actor.orgId,
          photo.projectId,
          photo.id,
        );
        if (!frozen) throw new ReportError('NOT_FOUND');
        return { access, photo: frozenPhotoViews([frozen], [photo])[0]! };
      }
      return { access, photo };
    });
  }
  /**
   * Photo or thumbnail bytes of a photo the caller may see (see `visible`); both are re-hashed
   * before serving. A writer gets the stored bytes unchanged. A reader (OD20) gets them without
   * location metadata (photo-strip); when that cannot be done safely (HEIF, or a structure the
   * stripper cannot follow) the bytes are not served to the reader at all: NOT_FOUND, and the
   * web shows the thumbnail instead.
   */
  async content(
    identity: Identity,
    photoId: string,
    which: 'photo' | 'thumbnail',
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const target = await inTransaction(
      this.pool,
      identity,
      async (client, actor) => {
        const { row, access } = await this.visible(client, actor, photoId);
        if (which === 'photo')
          return {
            key: row.blobKey,
            mediaType: row.mediaType,
            sha256: row.sha256,
            access,
          };
        if (
          row.thumbBlobKey === null ||
          row.thumbMediaType === null ||
          row.thumbSha256 === null
        )
          throw new ReportError('NOT_FOUND');
        return {
          key: row.thumbBlobKey,
          mediaType: row.thumbMediaType,
          sha256: row.thumbSha256,
          access,
        };
      },
    );
    const blob = await this.blobCall(null, (signal) =>
      this.blobs.get(target.key, signal),
    );
    if (!blob) throw new ReportError('NOT_FOUND');
    // Content addressing makes tampering or a mixed-up blob detectable; never serve it silently.
    // Checked on the stored bytes, before anything is removed for a reader.
    if (sha256(blob.bytes) !== target.sha256)
      throw new Error('Stored blob does not match its recorded hash');
    if (target.access === 'write')
      return { bytes: blob.bytes, mediaType: target.mediaType };
    const stripped = withoutLocationMetadata(blob.bytes);
    if (!stripped) throw new ReportError('NOT_FOUND');
    return { bytes: stripped, mediaType: target.mediaType };
  }

  // ---------- writes (project manager) ----------
  async upload(
    identity: Identity,
    input: PhotoUpload,
  ): Promise<PhotoUploadResult> {
    const { command } = input;
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, command.projectId);
      const photo = checkFile(input.photo, PHOTO_MEDIA_TYPES, PHOTO_MAX_BYTES);
      const thumb = input.thumbnail
        ? checkFile(input.thumbnail, THUMB_MEDIA_TYPES, THUMB_MAX_BYTES)
        : null;
      // Rule 8: an in-app capture without a usable device fix is not stored at all.
      const fix = location(command.capture);
      if (!photoAcceptable(command.source, fix))
        throw new ReportError('NEEDS_LOCATION');
      const hash = sha256(photo.bytes);
      const thumbHash = thumb ? sha256(thumb.bytes) : null;
      return idempotent(
        client,
        actor,
        'PHOTO_UPLOAD',
        command.clientMutationId,
        {
          ...command,
          sha256: hash,
          mediaType: photo.mediaType,
          thumbnail: thumb
            ? { sha256: thumbHash, mediaType: thumb.mediaType }
            : null,
        },
        async () => {
          await lockReportDay(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
          );
          const day = await client.query<{
            state: string;
            correctionReason: string | null;
          }>(
            `SELECT state, "correctionReason" FROM "DailyClose"
            WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "scopeKey"=$4`,
            [actor.orgId, project.id, command.businessDate, REPORT_SCOPE],
          );
          const d = day.rows[0];
          if (d?.state === 'SUBMITTED' && d.correctionReason === null)
            throw new ReportError('LOCKED');
          if (command.link)
            await this.assertTarget(
              client,
              actor.orgId,
              project.id,
              command.link,
            );
          // One writer per file: the same bytes uploaded twice at once still make one row.
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`${actor.orgId}:photo:${hash}`],
          );
          const existing = await client.query<{
            id: string;
            projectId: string | null;
            businessDate: string | null;
          }>(
            `SELECT id, "projectId", "businessDate"::text AS "businessDate" FROM "PhotoEvidence" WHERE "orgId"=$1 AND sha256=$2`,
            [actor.orgId, hash],
          );
          const prior = existing.rows[0];
          if (prior) {
            // The same file is one fact: it is not copied into another project or day.
            if (
              prior.projectId !== project.id ||
              prior.businessDate !== command.businessDate
            )
              throw new ReportError('PHOTO_ELSEWHERE');
            // Returned as it is: a duplicate never changes links (a delayed retry must not undo
            // a later unlink or relink); linking goes through link/unlink with expectedVersion.
            return {
              ...(await this.view(client, actor.orgId, prior.id)),
              deduplicated: true,
            };
          }

          const claims = readFileClaims(photo.bytes);
          const id = randomUUID();
          const blobKey = `${actor.orgId}/${hash}`;
          const thumbKey = thumbHash
            ? `${actor.orgId}/${thumbHash}.thumb`
            : null;
          await this.blobCall(client, (signal) =>
            this.blobs.put(blobKey, photo.bytes, photo.mediaType, signal),
          );
          if (thumb && thumbKey)
            await this.blobCall(client, (signal) =>
              this.blobs.put(thumbKey, thumb.bytes, thumb.mediaType, signal),
            );
          const camera = command.source === 'camera' ? command.capture : null;
          // The file's GPS is kept for album uploads only; an in-app capture relies on its fix.
          const gps = command.source === 'album' ? claims.gps : null;
          await client.query(
            `INSERT INTO "PhotoEvidence"(id,"orgId","updatedAt","updatedBy",sha256,"blobKey","mediaType","sizeBytes",
              "deviceCapturedAt","assignmentStatus","projectId","businessDate",source,
              "captureLat","captureLon","captureAccuracyM","captureFixAt",
              "fileTakenAt","fileTakenLocal","fileGpsLat","fileGpsLon",
              "thumbBlobKey","thumbMediaType","thumbSha256","uploadedByAccountId","uploadedByPersonId")
            VALUES($1,$2,now(),$3,$4,$5,$6,$7,$8,'ASSIGNED',$9,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$23,$3,$22)`,
            [
              id,
              actor.orgId,
              actor.accountId,
              hash,
              blobKey,
              photo.mediaType,
              photo.bytes.length,
              command.source === 'camera' ? command.takenAt : null,
              project.id,
              command.businessDate,
              command.source,
              camera?.lat ?? null,
              camera?.lon ?? null,
              camera?.accuracyM ?? null,
              camera?.fixAt ?? null,
              claims.takenAt,
              claims.takenLocal,
              gps?.lat ?? null,
              gps?.lon ?? null,
              thumbKey,
              thumb?.mediaType ?? null,
              actor.personId,
              thumbHash,
            ],
          );
          if (command.link)
            await this.insertLink(
              client,
              actor,
              id,
              command.businessDate,
              command.link,
            );
          const after = await this.view(client, actor.orgId, id);
          await audit(
            client,
            actor,
            { type: 'PHOTO', id, version: after.linkVersion },
            'PHOTO_UPLOAD',
            command.businessDate,
            null,
            {
              projectId: after.projectId,
              businessDate: after.businessDate,
              sha256: after.sha256,
              mediaType: after.mediaType,
              sizeBytes: after.sizeBytes,
              source: after.source,
              location: after.location,
              link: after.link,
            },
            command.clientMutationId,
          );
          return { ...after, deduplicated: false };
        },
        photoFor('write'),
      );
    });
  }

  async link(identity: Identity, command: LinkPhotoCommand): Promise<PhotoDto> {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { row: photo, access } = await this.visible(
        client,
        actor,
        command.photoId,
      );
      if (access !== 'write') throw new ReportError('READ_ONLY');
      return idempotent(
        client,
        actor,
        'PHOTO_LINK',
        command.clientMutationId,
        command,
        async () => {
          const state = await this.linkState(client, actor.orgId, photo.id);
          if (state.version !== command.expectedVersion)
            throw new ReportError('VERSION_CONFLICT');
          await this.assertTarget(
            client,
            actor.orgId,
            photo.projectId,
            command.link,
          );
          const before = state.current ? toLink(state.current) : null;
          if (
            before?.type === command.link.type &&
            before.id === command.link.id
          )
            return this.view(client, actor.orgId, photo.id);
          if (state.current)
            await this.supersede(client, actor, state.current.id);
          await this.insertLink(
            client,
            actor,
            photo.id,
            photo.businessDate,
            command.link,
          );
          const after = await this.view(client, actor.orgId, photo.id);
          await audit(
            client,
            actor,
            { type: 'PHOTO', id: photo.id, version: after.linkVersion },
            'PHOTO_LINK',
            photo.businessDate,
            { link: before },
            { link: after.link },
            command.clientMutationId,
          );
          return after;
        },
        photoFor(access),
      );
    });
  }

  async unlink(
    identity: Identity,
    command: UnlinkPhotoCommand,
  ): Promise<PhotoDto> {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { row: photo, access } = await this.visible(
        client,
        actor,
        command.photoId,
      );
      if (access !== 'write') throw new ReportError('READ_ONLY');
      return idempotent(
        client,
        actor,
        'PHOTO_UNLINK',
        command.clientMutationId,
        command,
        async () => {
          const state = await this.linkState(client, actor.orgId, photo.id);
          if (state.version !== command.expectedVersion)
            throw new ReportError('VERSION_CONFLICT');
          if (!state.current) throw new ReportError('NOT_LINKED');
          await this.supersede(client, actor, state.current.id);
          const after = await this.view(client, actor.orgId, photo.id);
          await audit(
            client,
            actor,
            { type: 'PHOTO', id: photo.id, version: after.linkVersion },
            'PHOTO_UNLINK',
            photo.businessDate,
            { link: toLink(state.current) },
            { link: null },
            command.clientMutationId,
          );
          return after;
        },
        photoFor(access),
      );
    });
  }
}
