import type { DayFactsDto } from '@mje/contracts';
import {
  ApiError,
  type DayView,
  type ReportApi,
  type ReportContent,
} from '../api.js';
import { DraftSession, type FlushOutcome } from './draft.js';
import { setFact } from './model.js';
import { restoreDecision, type DraftStash } from '../signin.js';

/** Where stashed drafts wait until their day is read (see ResumeKeeper). */
export interface DraftRecovery {
  draft(projectId: string, businessDate: string): DraftStash | null;
  taken(stash: DraftStash): void;
  resolved(stash: DraftStash): void;
}

/**
 * A day was just read into `s` (nothing unsaved): reconcile the draft stashed for it. Saved or
 * conflicting drafts are resolved at once; a re-applied one only when its write is answered
 * (acknowledged or refused as a conflict), so until then a renewal keeps it.
 */
export function reconcileDraft(
  recovery: DraftRecovery | undefined,
  s: DraftSession,
  onConflict: () => void,
  afterFlush: (outcome: FlushOutcome) => void,
) {
  const stash = recovery?.draft(s.projectId, s.businessDate);
  if (!recovery || !stash || s.dirty) return;
  const decision = restoreDecision(stash, s);
  if (decision === 'apply') {
    if (!s.edit(stash.facts)) return; // held by an action: try on the next read
    recovery.taken(stash);
    void s.flush().then((outcome) => {
      if (outcome === 'ok' || outcome === 'conflict') recovery.resolved(stash);
      afterFlush(outcome);
    });
    return;
  }
  recovery.resolved(stash);
  if (decision === 'conflict') onConflict();
}

export type ActionOutcome = FlushOutcome | 'busy';
export class ActionAborted extends Error {
  constructor(public readonly outcome: ActionOutcome) {
    super(outcome);
  }
}

/** Everything known about one project day; entries outlive navigation. */
export interface DayEntry {
  session: DraftSession;
  day: DayView | null;
  frozen: ReportContent | null;
  error: string | null;
  /** Only the newest read of a day may be applied. */
  reads: number;
  /**
   * The day's one mutation lock (AGENTS.md, C63): the owner token of the command holding it
   * (a submission, a correction, no-work, a foreman adoption), or null. Edits and autosave
   * wait while it is held; only its owner releases it, and only once a read after the write
   * has landed.
   */
  lock: string | null;
  /** The lock's post-write read failed: the day stays locked until a read lands (Reload). */
  stale: boolean;
}

export const AUTOSAVE_MS = 700;
let tokens = 0;
/** A fresh owner token for one command's hold of a day. */
export const ownerToken = (what: string) => `${what}:${++tokens}`;

/**
 * Project days for the screens, independent of React (useDay is its hook). Each day keeps its
 * own DraftSession for the life of the workspace, so leaving a day never abandons its unsaved
 * or failed edits: they are retried on return. Reads are fenced: an older response never
 * replaces newer acknowledged facts.
 *
 * Every command on a day goes through one guarded acquisition of the day's lock (`acquire`):
 * a second command while another owner holds it gets BUSY and sends nothing. While held, the
 * day refuses edits and autosave does not run. The holder's own pre-save waits for any save in
 * flight (the DraftSession sends one write at a time). A lock is released only by its owner
 * token and only after a read following the write has landed; if that read fails the day stays
 * locked (`stale`) and offers a reload. Acquisition, pre-save, send and reread are exception
 * safe: a throw frees the day or leaves it with its owner's Retry / Give up.
 */
export class DayStore {
  private readonly entries = new Map<string, DayEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Kept current by the hook (callbacks change between renders). */
  hooks: { conflict: () => void; recovery: DraftRecovery | undefined } = {
    conflict: () => {},
    recovery: undefined,
  };

  constructor(
    private readonly api: Pick<ReportApi, 'day' | 'revision' | 'saveFacts'>,
    private readonly notify: () => void,
  ) {}

  entry(projectId: string, date: string): DayEntry {
    const k = `${projectId}:${date}`;
    let e = this.entries.get(k);
    if (!e) {
      const session: DraftSession = new DraftSession(
        projectId,
        date,
        0,
        emptyFacts(),
        (c) => this.api.saveFacts(c),
        this.notify,
      );
      e = {
        session,
        day: null,
        frozen: null,
        error: null,
        reads: 0,
        lock: null,
        stale: false,
      };
      this.entries.set(k, e);
    }
    return e;
  }
  all(): DayEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Read the day from the server; `replace` only after a conflict or a finished command.
   * Resolves true once a read has landed (this one, or a newer one that superseded it).
   */
  async read(e: DayEntry, replace: boolean): Promise<boolean> {
    const s = e.session;
    const ticket = ++e.reads;
    const startedAt = s.editGeneration;
    try {
      const d = await this.api.day(s.projectId, s.businessDate);
      const content =
        d.state === 'submitted' && d.currentRevisionNumber > 0
          ? (
              await this.api.revision(
                s.projectId,
                s.businessDate,
                d.currentRevisionNumber,
              )
            ).snapshot
          : null;
      if (ticket !== e.reads) return true;
      if (!replace && d.version < s.version) return true; // older than what we already saved
      if (replace) s.reset(d.version, d.facts);
      else s.adopt(d, startedAt);
      e.day = d;
      e.frozen = content;
      e.error = null;
      // Only against a read the session took (not refused by adopt), else wait for the next.
      if (s.version === d.version && e.lock === null)
        reconcileDraft(
          this.hooks.recovery,
          s,
          () => this.hooks.conflict(),
          (o) => void this.settleAfter(e, o),
        );
      return true;
    } catch (err) {
      if (ticket === e.reads)
        e.error = err instanceof ApiError ? err.code : 'REQUEST_FAILED';
      return false;
    } finally {
      this.notify();
    }
  }

  async settleAfter(e: DayEntry, outcome: FlushOutcome) {
    if (outcome === 'conflict') {
      this.hooks.conflict();
      await this.read(e, true);
    } else if (outcome === 'ok' && !e.session.dirty) await this.read(e, false);
  }

  // ---------- the day's one mutation lock ----------

  /** Take the day's lock for `owner`; false (BUSY) when another owner holds it. */
  acquire(e: DayEntry, owner: string): boolean {
    if (e.lock !== null && e.lock !== owner) return false;
    e.lock = owner;
    this.cancelAutosave();
    this.notify();
    return true;
  }
  /** Free the lock without a read: only when nothing was written under it. */
  private unlock(e: DayEntry, owner: string) {
    if (e.lock !== owner) return;
    e.session.release();
    e.lock = null;
    e.stale = false;
    this.notify();
  }
  /**
   * Release after a write: only by the lock's owner, and only once a fresh read of the day has
   * landed. If the read fails the day stays locked (`stale`) until `reloadLocked` lands one.
   */
  async release(e: DayEntry, owner: string): Promise<boolean> {
    if (e.lock !== owner) return false;
    const landed = await this.read(e, true);
    if (e.lock !== owner) return false;
    if (!landed) {
      e.stale = true;
      this.notify();
      return false;
    }
    this.unlock(e, owner);
    return true;
  }
  /** The Reload of a day locked after a failed post-write read. */
  async reloadLocked(e: DayEntry): Promise<boolean> {
    return e.lock !== null && e.stale
      ? this.release(e, e.lock)
      : this.read(e, false);
  }

  /**
   * Hold the day for a command owned outside it (a foreman adoption): acquire, then save what
   * was typed. On 'ok' the day stays locked for `owner` and `version` is the version of that
   * save (the held session's own), which the command must send. Anything else frees it.
   */
  async hold(
    e: DayEntry,
    owner: string,
  ): Promise<{ outcome: ActionOutcome; version: number }> {
    if (!this.acquire(e, owner))
      return { outcome: 'busy', version: e.session.version };
    try {
      const outcome = await e.session.hold();
      if (outcome !== 'ok') {
        this.unlock(e, owner);
        await this.settleAfter(e, outcome);
      }
      return { outcome, version: e.session.version };
    } catch (err) {
      // A throw before anything was sent under the lock (the pre-save itself threw).
      this.unlock(e, owner);
      throw err;
    }
  }

  /** Run a day command (submit, no-work, corrections) under the lock, on exactly what is saved. */
  async act(
    e: DayEntry,
    fn: (version: number) => Promise<unknown>,
  ): Promise<void> {
    const owner = ownerToken('act');
    const held = await this.hold(e, owner);
    if (held.outcome !== 'ok') throw new ActionAborted(held.outcome);
    try {
      await fn(held.version);
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'VERSION_CONFLICT' || err.code === 'LOCKED')
      )
        this.hooks.conflict();
      throw err;
    } finally {
      await this.release(e, owner);
    }
  }

  // ---------- typing and autosave ----------

  /** A typed value; refused while the day is locked (the page shows it read-only then). */
  edit(e: DayEntry, path: string, value: string | null): boolean {
    if (e.lock !== null) return false;
    const s = e.session;
    let next: DayFactsDto =
      path === 'noWork'
        ? { ...s.facts, noWork: null }
        : setFact(s.facts, path, value ?? '');
    if (path.startsWith('qty.'))
      next = setFact(
        next,
        `updated.${path.slice(4)}`,
        new Date().toISOString(),
      );
    if (!s.edit(next)) return false;
    this.cancelAutosave();
    this.timer = setTimeout(() => void this.flush(e), AUTOSAVE_MS);
    return true;
  }
  /** Save what was typed; never while the day is locked (its holder saves first). */
  async flush(e: DayEntry): Promise<FlushOutcome> {
    this.cancelAutosave();
    if (e.lock !== null) return e.session.dirty ? 'failed' : 'ok';
    const outcome = await e.session.flush();
    await this.settleAfter(e, outcome);
    return outcome;
  }
  cancelAutosave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export function emptyFacts(): DayFactsDto {
  return {
    weather: '',
    temperature: '',
    qty: {},
    cumulative: {},
    narrative: { construction: '', quality: '', safety: '' },
    people: {},
    presence: {},
    machinery: {},
    materials: {},
    milestones: {},
    noWork: null,
    updated: {},
  };
}
