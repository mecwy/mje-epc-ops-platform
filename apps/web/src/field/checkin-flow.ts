import type {
  CaptureFixDto,
  CheckInResultDto,
  SelfieUploadDto,
} from '@mje/contracts';
import { siteToday } from '../report/format.js';
import type { LocateResult, NoFixReason } from '../report/geo.js';
import {
  attempt,
  checkFix,
  checkInEvent,
  recallToday,
  rememberToday,
  type TodayCheckIn,
} from './checkin.js';
import { FieldApiError, type DeviceApi } from './field-api.js';
import { FieldSession, type Outcome } from './session.js';

export type Phase =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'noFix'; reason: NoFixReason }
  | { kind: 'coarse'; fix: CaptureFixDto }
  | { kind: 'stale' }
  | { kind: 'sending'; fix: CaptureFixDto | null }
  | { kind: 'refused'; code: string; fix: CaptureFixDto | null }
  | {
      kind: 'unsettled';
      code: string;
      what: 'checkin' | 'selfie';
      fix: CaptureFixDto | null;
      /** The event's site day (check-in only). */
      day: string | null;
    };

export interface CheckInDeps {
  api: Pick<DeviceApi, 'checkIn' | 'uploadSelfie'>;
  deviceId: string;
  timeZone: string;
  storage: Storage | null;
  locate: () => Promise<LocateResult>;
  now: () => number;
  newKey: () => string;
  /** The device's token was refused as ended: the device page ends (FieldSession.end). */
  onEnded: (code: string) => void;
  notify: () => void;
}
/** A chosen selfie; `id` tells two choices apart even when their bytes are equal. */
export interface ChosenSelfie {
  id: number;
  image: Blob;
}

/**
 * The self check-in card's state (design §3), outside React so it is tested without a DOM.
 * Check-in and the selfie upload are separate command queues (IssueSession pattern), so a
 * retry always resends the command it belongs to. The shown result belongs to one site day;
 * after the site's midnight the card offers today's check-in again.
 */
export class CheckInFlow {
  phase: Phase = { kind: 'idle' };
  selfie: ChosenSelfie | null = null;
  staged: SelfieUploadDto | null = null;
  selfieOff = false;
  private done: TodayCheckIn | null = null;
  private chosen = 0;
  readonly checkins: FieldSession<null>;
  readonly uploads: FieldSession<null>;

  constructor(private readonly d: CheckInDeps) {
    const opts = { onEnded: d.onEnded };
    this.checkins = new FieldSession<null>(async () => null, d.notify, opts);
    this.uploads = new FieldSession<null>(async () => null, d.notify, opts);
  }

  /** The site's business date now (it changes at the site's midnight, not the phone's). */
  today(): string {
    return siteToday(this.d.timeZone, new Date(this.d.now()));
  }
  /** Today's check-in only: a result of an earlier site day is never shown as today's. */
  doneToday(): TodayCheckIn | null {
    const today = this.today();
    if (this.done?.businessDate === today) return this.done;
    return recallToday(this.d.storage, this.d.deviceId, today);
  }
  get busy() {
    return (
      this.checkins.busy ||
      this.uploads.busy ||
      this.phase.kind === 'locating' ||
      this.phase.kind === 'sending'
    );
  }
  /**
   * The selfie choice may change only while nothing is unresolved: a retry resends the
   * original upload or check-in, so a new choice would be shown but not sent.
   */
  get canChooseSelfie() {
    return (
      !this.busy &&
      this.uploads.pending === null &&
      this.checkins.pending === null
    );
  }
  /** Check-in waits for a chosen selfie to be uploaded (or removed). */
  get canCheckIn() {
    return (
      !this.busy &&
      this.checkins.pending === null &&
      (this.selfie === null || this.staged !== null)
    );
  }

  private set(p: Phase) {
    this.phase = p;
    this.d.notify();
  }
  private remember(r: TodayCheckIn) {
    rememberToday(this.d.storage, this.d.deviceId, r);
    this.done = r;
  }

  async checkIn(): Promise<void> {
    if (!this.canCheckIn) return;
    this.set({ kind: 'locating' });
    const located = await this.d.locate();
    if (!located.fix)
      return this.set({ kind: 'noFix', reason: located.reason });
    const fix = located.fix;
    const now = this.d.now();
    const check = checkFix(fix, now);
    if (check === 'coarse') return this.set({ kind: 'coarse', fix });
    if (check === 'stale') return this.set({ kind: 'stale' });
    const usable =
      this.staged && Date.parse(this.staged.expiresAt) > now
        ? this.staged.selfieId
        : null;
    const event = checkInEvent(fix, this.d.timeZone, now, usable);
    const key = this.d.newKey();
    this.set({ kind: 'sending', fix });
    this.finish(
      fix,
      event.businessDate,
      await this.checkins.act(
        () => ({
          key,
          send: () =>
            this.d.api.checkIn(key, () => attempt(key, event, this.d.now())),
        }),
        false,
      ),
    );
  }

  /** Resend the unresolved command unchanged (same key and event). */
  async retry(): Promise<void> {
    const p = this.phase;
    if (p.kind !== 'unsettled') return;
    if (p.what === 'selfie')
      return this.afterUpload(await this.uploads.retry<SelfieUploadDto>());
    this.set({ kind: 'sending', fix: p.fix });
    this.finish(
      p.fix,
      p.day ?? this.today(),
      await this.checkins.retry<CheckInResultDto>(),
    );
  }

  private finish(
    fix: CaptureFixDto | null,
    businessDate: string,
    r: Outcome<CheckInResultDto>,
  ) {
    if (r.kind === 'ok') {
      const v = r.value;
      this.remember({
        businessDate: v.businessDate,
        occurredAt: v.occurredAt,
        kind: v.kind,
        flags: v.flags,
        hasSelfie: v.hasSelfie,
        afterSubmission: v.afterSubmission,
        accuracyM: fix?.accuracyM ?? null,
      });
      this.selfie = null;
      this.staged = null;
      return this.set({ kind: 'idle' });
    }
    if (r.kind === 'failed')
      return this.set({
        kind: 'unsettled',
        code: r.code,
        what: 'checkin',
        fix,
        day: businessDate,
      });
    const existing = r.error instanceof FieldApiError ? r.error.existing : null;
    if (r.code === 'ALREADY_CHECKED_IN' && existing)
      this.remember({
        businessDate,
        occurredAt: existing.occurredAt,
        kind: existing.kind,
        flags: [],
        hasSelfie: false,
        afterSubmission: false,
        accuracyM: null,
      });
    // An expired or used selfie cannot be attached again: the choice is cleared, so the
    // person can take a new one or check in without it.
    if (r.code === 'SELFIE_EXPIRED') this.dropSelfie();
    if (r.code === 'FEATURE_OFF') {
      this.selfieOff = true;
      this.dropSelfie();
    }
    this.set({ kind: 'refused', code: r.code, fix });
  }

  /** A chosen, already-resized image; refused while an earlier upload is unresolved. */
  async chooseSelfie(image: Blob): Promise<boolean> {
    if (!this.canChooseSelfie) return false;
    this.selfie = { id: ++this.chosen, image };
    this.staged = null;
    const key = this.d.newKey();
    this.set({ kind: 'idle' });
    this.afterUpload(
      await this.uploads.act(
        () => ({ key, send: () => this.d.api.uploadSelfie(key, image) }),
        false,
      ),
    );
    return true;
  }
  /**
   * Remove the chosen selfie and give up an unresolved upload of it (the server may still
   * have stored it; an unattached selfie is deleted after an hour).
   */
  removeSelfie() {
    if (this.uploads.busy || this.checkins.pending) return;
    this.uploads.discard();
    this.dropSelfie();
    if (this.phase.kind === 'unsettled' && this.phase.what === 'selfie')
      this.set({ kind: 'idle' });
    else this.d.notify();
  }
  private dropSelfie() {
    this.selfie = null;
    this.staged = null;
  }
  private afterUpload(r: Outcome<SelfieUploadDto>) {
    if (r.kind === 'ok') {
      this.staged = r.value;
      return this.set({ kind: 'idle' });
    }
    if (r.kind === 'failed')
      return this.set({
        kind: 'unsettled',
        code: r.code,
        what: 'selfie',
        fix: null,
        day: null,
      });
    if (r.code === 'FEATURE_OFF') this.selfieOff = true;
    this.dropSelfie();
    this.set({ kind: 'refused', code: r.code, fix: null });
  }
  /** An image that could not be read or resized is refused on the phone. */
  unreadable() {
    this.set({ kind: 'refused', code: 'UNSUPPORTED_MEDIA', fix: null });
  }
}
