import type {
  CaptureFixDto,
  CheckInResultDto,
  ProxyCheckInCommand,
} from '@mje/contracts';
import { siteToday } from '../report/format.js';
import type { LocateResult, NoFixReason } from '../report/geo.js';
import { checkFix } from './checkin.js';
import { FieldApiError, type DeviceApi } from './field-api.js';
import { FieldSession, type Outcome } from './session.js';

export interface ProxyDone {
  occurredAt: string | null;
  kind: string;
  flags: string[];
}
export type ProxyPhase =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'noFix'; reason: NoFixReason }
  | { kind: 'coarse'; accuracyM: string }
  | { kind: 'stale' }
  | { kind: 'sending' }
  | { kind: 'refused'; code: string }
  | { kind: 'unsettled'; code: string };

export interface ProxyDeps {
  api: Pick<DeviceApi, 'proxyCheckIn'>;
  deviceId: string;
  timeZone: string;
  storage: Storage | null;
  locate: () => Promise<LocateResult>;
  now: () => number;
  newKey: () => string;
  onEnded: (code: string) => void;
  notify: () => void;
}
const KEY = 'mje-field-proxy';
const REUSE_MS = 90_000;

/**
 * The foreman's crew check-in (design §3 "foreman proxy"): the foreman's own fix and clock,
 * for a member of the foreman's current crew, one person at a time. A lost answer is resent
 * unchanged (same key and event); the fence is judged by the server on the foreman's fix.
 * Results are remembered per site day only to show them (no device read of check-ins, C45).
 */
export class ProxyFlow {
  /** Whose check-in is running, unresolved or refused last, and how it stands. */
  person: string | null = null;
  phase: ProxyPhase = { kind: 'idle' };
  readonly queue: FieldSession<null>;
  /** A fix good enough for the whole crew (≤ 100 m, ≤ 2 min old) is reused. */
  private fix: CaptureFixDto | null = null;
  private day: string | null = null;
  /** The site day of the unresolved check-in's event. */
  private eventDay: string | null = null;
  private done: Record<string, ProxyDone> = {};

  constructor(private readonly d: ProxyDeps) {
    this.queue = new FieldSession<null>(async () => null, d.notify, {
      onEnded: d.onEnded,
    });
  }
  today(): string {
    return siteToday(this.d.timeZone, new Date(this.d.now()));
  }
  /** Today's result for a member, from this visit or this phone's memory of today. */
  doneFor(personId: string): ProxyDone | null {
    this.sync();
    return this.done[personId] ?? null;
  }
  get busy() {
    return (
      this.queue.busy ||
      this.phase.kind === 'locating' ||
      this.phase.kind === 'sending'
    );
  }
  /** Another member can be checked in only once the unresolved one is settled or retried. */
  canStart(personId: string): boolean {
    return (
      !this.busy &&
      this.queue.pending === null &&
      this.doneFor(personId) === null
    );
  }

  private sync() {
    const today = this.today();
    if (this.day === today) return;
    this.day = today;
    this.done = {};
    try {
      const raw = this.d.storage?.getItem(`${KEY}:${this.d.deviceId}`);
      const saved = raw
        ? (JSON.parse(raw) as { day?: unknown; done?: unknown })
        : null;
      if (saved?.day === today && saved.done && typeof saved.done === 'object')
        this.done = saved.done as Record<string, ProxyDone>;
    } catch {
      /* nothing remembered */
    }
  }
  private remember(personId: string, day: string, r: ProxyDone) {
    this.sync();
    if (day !== this.day) return;
    this.done[personId] = r;
    try {
      this.d.storage?.setItem(
        `${KEY}:${this.d.deviceId}`,
        JSON.stringify({ day, done: this.done }),
      );
    } catch {
      /* shown for this visit only */
    }
  }
  private set(personId: string, p: ProxyPhase) {
    this.person = personId;
    this.phase = p;
    this.d.notify();
  }

  private async fixNow(personId: string): Promise<CaptureFixDto | null> {
    const now = this.d.now();
    // Reused only while well inside the 2-minute limit (T1 is judged at occurredAt).
    if (this.fix && now - Date.parse(this.fix.fixAt) <= REUSE_MS)
      return this.fix;
    this.set(personId, { kind: 'locating' });
    const r = await this.d.locate();
    if (!r.fix) {
      this.set(personId, { kind: 'noFix', reason: r.reason });
      return null;
    }
    const check = checkFix(r.fix, this.d.now());
    if (check === 'coarse') {
      this.set(personId, { kind: 'coarse', accuracyM: r.fix.accuracyM });
      return null;
    }
    if (check === 'stale') {
      this.set(personId, { kind: 'stale' });
      return null;
    }
    this.fix = r.fix;
    return r.fix;
  }

  async checkIn(personId: string): Promise<void> {
    if (!this.canStart(personId)) return;
    const fix = await this.fixNow(personId);
    if (!fix) return;
    const now = this.d.now();
    const occurred = new Date(Math.max(now, Date.parse(fix.fixAt)));
    const event = {
      personId,
      businessDate: siteToday(this.d.timeZone, occurred),
      occurredAt: occurred.toISOString(),
      fix,
    };
    const key = this.d.newKey();
    this.eventDay = event.businessDate;
    this.set(personId, { kind: 'sending' });
    const build = (): ProxyCheckInCommand => ({
      ...event,
      clientMutationId: key,
      deviceSentAt: new Date(
        Math.max(this.d.now(), Date.parse(event.occurredAt)),
      ).toISOString(),
    });
    this.finish(
      personId,
      event.businessDate,
      await this.queue.act(
        () => ({ key, send: () => this.d.api.proxyCheckIn(key, build) }),
        false,
      ),
    );
  }
  /** Resend the unresolved check-in unchanged. */
  async retry(): Promise<void> {
    const personId = this.person;
    if (!personId || !this.queue.pending) return;
    this.set(personId, { kind: 'sending' });
    this.finish(
      personId,
      this.eventDay ?? this.today(),
      await this.queue.retry<CheckInResultDto>(),
    );
  }

  private finish(personId: string, day: string, r: Outcome<CheckInResultDto>) {
    if (r.kind === 'ok') {
      this.remember(personId, r.value.businessDate, {
        occurredAt: r.value.occurredAt,
        kind: r.value.kind,
        flags: r.value.flags,
      });
      return this.set(personId, { kind: 'idle' });
    }
    if (r.kind === 'failed')
      return this.set(personId, { kind: 'unsettled', code: r.code });
    const existing = r.error instanceof FieldApiError ? r.error.existing : null;
    if (r.code === 'ALREADY_CHECKED_IN' && existing)
      this.remember(personId, day, {
        occurredAt: existing.occurredAt,
        kind: existing.kind,
        flags: [],
      });
    // A fence or accuracy refusal is about the foreman's fix: locate afresh next time.
    if (
      r.code === 'GEOFENCE_OUTSIDE' ||
      r.code === 'LOCATION_TOO_COARSE' ||
      r.code === 'FIX_TIME_INVALID'
    )
      this.fix = null;
    this.set(personId, { kind: 'refused', code: r.code });
  }
}
