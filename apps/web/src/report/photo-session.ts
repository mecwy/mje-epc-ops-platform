import type {
  CaptureFixDto,
  LinkPhotoCommand,
  PhotoDto,
  PhotoLinkDto,
  PhotoSourceDto,
  UnlinkPhotoCommand,
} from '@mje/contracts';
import { ApiError, type Access, type ReportApi } from '../api.js';
import type { LocateResult, NoFixReason } from './geo.js';
import { checkPhotoFile } from './thumbnail.js';

type PhotoApi = Pick<
  ReportApi,
  'photos' | 'uploadPhoto' | 'linkPhoto' | 'unlinkPhoto'
>;
export interface PhotoDeps {
  newId: () => string;
  /** Start a device fix now (U2.1 rule 8); see geo.locate. */
  locate: () => Promise<LocateResult>;
  thumbnail: (file: Blob) => Promise<Blob | null>;
  /** Device clock, ISO-8601. */
  now: () => string;
  /** A stored upload, with the thumbnail made here (so it need not be fetched back). */
  uploaded?: (photo: PhotoDto, thumb: Blob | null) => void;
}
/** A picture file as the input gave it. */
export interface PickedFile extends Blob {
  readonly type: string;
  readonly size: number;
}

export type JobState =
  'locating' | 'noLocation' | 'queued' | 'sending' | 'failed' | 'rejected';
/**
 * One upload. Its key, bytes, thumbnail, fix and link are fixed when it is created, so every
 * retry resends exactly the same request (the server replays or dedupes by sha256).
 */
export interface UploadJob {
  key: string;
  source: PhotoSourceDto;
  link: PhotoLinkDto | null;
  file: Blob | null;
  mediaType: string;
  thumb: Blob | null;
  fix: CaptureFixDto | null;
  takenAt: string | null;
  state: JobState;
  /** 0–100 while sending. */
  progress: number;
  /** A rejection code, 'NETWORK' when the outcome is unknown, or why no fix was obtained. */
  error: string | NoFixReason | null;
}
/** A camera capture in progress: the fix is started when the camera is opened. */
export interface Capture {
  link: PhotoLinkDto | null;
  fix: Promise<LocateResult>;
}
type Pending =
  | { kind: 'link'; command: LinkPhotoCommand }
  | { kind: 'unlink'; command: UnlinkPhotoCommand };
export type PhotoOutcome = 'ok' | 'failed' | 'rejected';

/** Link errors a retry cannot change; anything else leaves the outcome unknown. */
const LINK_DEFINITE = new Set([
  'VERSION_CONFLICT',
  'READ_ONLY',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'ITEM_NOT_FOUND',
  'ISSUE_NOT_FOUND',
  'NOT_LINKED',
  'IDEMPOTENCY_KEY_REUSED',
]);
/** Upload errors a retry cannot change: the photo was not stored. */
const UPLOAD_DEFINITE = new Set([
  'NEEDS_LOCATION',
  'PHOTO_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'PHOTO_ELSEWHERE',
  'LOCKED',
  'READ_ONLY',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'ITEM_NOT_FOUND',
  'ISSUE_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
]);
const sameLink = (a: PhotoLinkDto | null, b: PhotoLinkDto | null) =>
  a === null || b === null ? a === b : a.type === b.type && a.id === b.id;

/**
 * The photos of one project day, kept for the life of the workspace (never shared with another
 * day), in the IssueSession pattern:
 * - reads are ticketed; a read that started before the last write never replaces what that
 *   write produced, and a link command is only built from a read that landed after it;
 * - link/unlink run one at a time with the photo's current linkVersion; a command whose
 *   outcome is unknown keeps its key and is resent unchanged by retry();
 * - uploads run one at a time in their own queue (they do not depend on link versions); an
 *   upload whose outcome is unknown keeps its key and bytes for retryUpload().
 */
export class PhotoSession {
  photos: PhotoDto[] | null = null;
  /** Photos a submission would leave out; null until a read has landed (unknown, not 0). */
  unlinked: number | null = null;
  access: Access | null = null;
  jobs: UploadJob[] = [];
  busy = false;
  /** As IssueSession: last definite rejection, 'NETWORK', 'STALE', 'SAVED_STALE', 'CONFLICT_STALE'. */
  error: string | null = null;
  pending: Pending | null = null;
  private reads = 0;
  private applied = 0;
  private writtenAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private uploads: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: PhotoApi,
    readonly projectId: string,
    readonly businessDate: string,
    private readonly notify: () => void,
    private readonly deps: PhotoDeps,
  ) {}

  async load(): Promise<boolean> {
    const ticket = ++this.reads;
    try {
      const list = await this.api.photos(this.projectId, this.businessDate);
      if (ticket <= this.applied) return false;
      // Started before the last write settled: it may predate that write. Only the first
      // read of the day is taken that way (there is nothing newer to protect yet).
      if (ticket <= this.writtenAt && this.photos !== null) return false;
      this.applied = ticket;
      this.photos = list.photos;
      this.unlinked = list.unlinkedPhotos;
      this.access = list.access;
      return true;
    } catch {
      return false;
    } finally {
      this.notify();
    }
  }

  /** True once a read started after the last write has been applied (bounded re-reads). */
  private async fresh(): Promise<boolean> {
    for (let i = 0; i < 3 && this.applied <= this.writtenAt; i++)
      await this.load();
    return this.applied > this.writtenAt;
  }
  private wrote() {
    this.writtenAt = this.reads;
  }
  /**
   * Show what a write returned at once (the stored photo as it now is). A read that started
   * before the write can no longer replace it (see load); the next fresh read confirms it.
   */
  private upsert(p: PhotoDto) {
    if (!this.photos) return;
    const at = this.photos.findIndex((x) => x.id === p.id);
    this.photos =
      at < 0
        ? [...this.photos, p]
        : this.photos.map((x, i) => (i === at ? p : x));
  }

  find(id: string) {
    return this.photos?.find((p) => p.id === id) ?? null;
  }
  /** Current photos linked to one work item or issue. */
  linked(type: PhotoLinkDto['type'], id: string): PhotoDto[] {
    return (this.photos ?? []).filter(
      (p) => p.link?.type === type && p.link.id === id,
    );
  }
  /** Work items that currently have a linked photo; null while unknown. */
  photographed(): Set<string> | null {
    if (!this.photos) return null;
    return new Set(
      this.photos.flatMap((p) => (p.link?.type === 'item' ? [p.link.id] : [])),
    );
  }

  get needsRetry() {
    return (
      this.pending !== null ||
      this.error === 'STALE' ||
      this.error === 'SAVED_STALE' ||
      this.error === 'CONFLICT_STALE'
    );
  }

  // ---------- link / unlink ----------

  /** Resend an unresolved link command unchanged (same key), or reload a stale list. */
  retry(): Promise<PhotoOutcome> {
    return this.enqueue(async () => {
      if (this.pending) return this.send(this.pending);
      if (!(await this.fresh())) return 'failed';
      if (this.needsRetry) this.error = null;
      this.notify();
      return 'ok';
    });
  }

  /** Link a photo to a work item or issue, or unlink it (target null). */
  link(photoId: string, target: PhotoLinkDto | null): Promise<PhotoOutcome> {
    return this.enqueue(async () => {
      if (this.pending) {
        this.error = 'NETWORK';
        this.notify();
        return 'failed';
      }
      if (!(await this.fresh())) {
        this.error = 'STALE';
        this.notify();
        return 'failed';
      }
      const photo = this.find(photoId);
      if (!photo) {
        this.error = 'NOT_FOUND';
        this.notify();
        return 'rejected';
      }
      if (sameLink(photo.link, target)) return 'ok';
      const base = {
        photoId,
        clientMutationId: this.deps.newId(),
        expectedVersion: photo.linkVersion,
      };
      return this.send(
        target
          ? { kind: 'link', command: { ...base, link: target } }
          : { kind: 'unlink', command: base },
      );
    });
  }

  private async send(p: Pending): Promise<PhotoOutcome> {
    this.pending = p;
    this.busy = true;
    this.notify();
    try {
      const result =
        p.kind === 'link'
          ? await this.api.linkPhoto(p.command)
          : await this.api.unlinkPhoto(p.command);
      this.pending = null;
      this.error = null;
      this.wrote();
      this.upsert(result);
      if (!(await this.fresh())) this.error = 'SAVED_STALE';
      return 'ok';
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      if (LINK_DEFINITE.has(code)) {
        this.pending = null;
        this.wrote();
        this.error =
          (await this.fresh()) || code !== 'VERSION_CONFLICT'
            ? code
            : 'CONFLICT_STALE';
        return 'rejected';
      }
      this.error = 'NETWORK';
      return 'failed';
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---------- uploads ----------

  /** Opening the in-app camera starts the fix at once (the user may take a while). */
  beginCapture(link: PhotoLinkDto | null): Capture {
    return { link, fix: this.deps.locate() };
  }

  private newJob(
    source: PhotoSourceDto,
    link: PhotoLinkDto | null,
    file: PickedFile,
  ): UploadJob {
    const refused = checkPhotoFile(file);
    const job: UploadJob = {
      key: this.deps.newId(),
      source,
      link,
      file: refused ? null : file,
      mediaType: file.type,
      thumb: null,
      fix: null,
      takenAt: null,
      state: refused ? 'rejected' : source === 'camera' ? 'locating' : 'queued',
      progress: 0,
      error: refused,
    };
    this.jobs = [...this.jobs, job];
    this.notify();
    return job;
  }

  /**
   * An in-app photo: it is uploaded only with a device fix. Without one it is kept here, not
   * sent, with the reason, until relocate() gets a fix or the user discards it.
   */
  async addCamera(capture: Capture, file: PickedFile): Promise<void> {
    const takenAt = this.deps.now();
    const job = this.newJob('camera', capture.link, file);
    if (job.state === 'rejected') return;
    job.takenAt = takenAt;
    const [thumb, located] = await Promise.all([
      this.deps.thumbnail(file),
      capture.fix,
    ]);
    job.thumb = thumb;
    this.placeFix(job, located);
  }
  /** Try the fix again for a photo kept without one; the photo and its key are unchanged. */
  async relocate(key: string): Promise<void> {
    const job = this.jobs.find((j) => j.key === key);
    if (!job || job.state !== 'noLocation') return;
    job.state = 'locating';
    job.error = null;
    this.notify();
    this.placeFix(job, await this.deps.locate());
  }
  private placeFix(job: UploadJob, located: LocateResult) {
    if (!this.jobs.includes(job)) return; // discarded meanwhile
    if (located.fix === null) {
      job.state = 'noLocation';
      job.error = located.reason;
      this.notify();
      return;
    }
    job.fix = located.fix;
    job.state = 'queued';
    this.notify();
    this.schedule(job);
  }

  /** Album photos: never the uploader's position or clock; the server reads the file's own. */
  async addAlbum(files: PickedFile[], link: PhotoLinkDto | null) {
    const jobs = files.map((f) => this.newJob('album', link, f));
    for (const job of jobs) {
      if (job.state !== 'queued' || !job.file) continue;
      job.thumb = await this.deps.thumbnail(job.file);
      this.schedule(job);
    }
  }

  /** Resend an upload whose outcome is unknown: same key, bytes, thumbnail, fix and link. */
  retryUpload(key: string) {
    const job = this.jobs.find((j) => j.key === key);
    if (!job || job.state !== 'failed') return;
    job.state = 'queued';
    job.error = null;
    this.notify();
    this.schedule(job);
  }
  /**
   * Drop a kept upload. One whose outcome was unknown may have been stored, so the list is
   * read again rather than assumed.
   */
  discard(key: string) {
    const job = this.jobs.find((j) => j.key === key);
    if (!job || job.state === 'sending' || job.state === 'queued') return;
    this.jobs = this.jobs.filter((j) => j !== job);
    this.notify();
    if (job.state === 'failed') void this.load();
  }

  private schedule(job: UploadJob) {
    const run = () => this.upload(job);
    this.uploads = this.uploads.then(run, run);
  }

  private async upload(job: UploadJob): Promise<void> {
    if (job.state !== 'queued' || !job.file || !this.jobs.includes(job)) return;
    job.state = 'sending';
    job.progress = 0;
    this.notify();
    try {
      const stored = await this.api.uploadPhoto(
        {
          projectId: this.projectId,
          businessDate: this.businessDate,
          clientMutationId: job.key,
          source: job.source,
          photo: job.file,
          mediaType: job.mediaType,
          thumbnail: job.thumb,
          fix: job.source === 'camera' ? job.fix : null,
          takenAt: job.source === 'camera' ? job.takenAt : null,
          link: job.link,
        },
        (percent) => {
          job.progress = percent;
          this.notify();
        },
      );
      // A deduplicated upload returns the stored photo, whose thumbnail may differ.
      if (!stored.deduplicated) this.deps.uploaded?.(stored, job.thumb);
      const { deduplicated: _, ...photo } = stored;
      void _;
      this.jobs = this.jobs.filter((j) => j !== job);
      this.wrote();
      this.upsert(photo);
      if (!(await this.fresh())) this.error = 'SAVED_STALE';
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      if (UPLOAD_DEFINITE.has(code)) {
        // Not stored: nothing to resend. The bytes are released.
        job.state = 'rejected';
        job.error = code;
        job.file = null;
        job.thumb = null;
        if (code === 'LOCKED') void this.load();
      } else {
        job.state = 'failed';
        job.error = 'NETWORK';
      }
    } finally {
      this.notify();
    }
  }

  /** Jobs shown with one work item or issue (null: the unlinked ones). */
  jobsFor(link: PhotoLinkDto | null): UploadJob[] {
    return this.jobs.filter((j) => sameLink(j.link, link));
  }
}
