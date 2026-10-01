import type { DayFactsDto } from '@mje/contracts';
import {
  ApiError,
  type DayView,
  type ReportApi,
  type ReportContent,
} from '../api.js';
import { DraftSession, leaf, type FlushOutcome } from './draft.js';
import { ReadFence } from '../read-fence.js';
import { UNSETTLED } from '../field/session.js';
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
/**
 * What a command under the lock did, as known: 'saved' only for a confirmed success;
 * 'refused' for a definite refusal; 'unknown' when no answer (or a throw) left it open.
 */
export type CommandOutcome = 'saved' | 'refused' | 'unknown';
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
  /** The day's read fence (the shared one): applied vs superseded, freshness, barrier. */
  fence: ReadFence;
  /**
   * The day's one mutation lock (AGENTS.md, C63): the owner token of the command holding it
   * (a submission, a correction, no-work, a foreman adoption), or null. Edits and autosave
   * wait while it is held; only its owner releases it, and only once a read after the write
   * has landed.
   */
  lock: string | null;
  /** The lock's post-write read failed: the day stays locked until a read lands (Reload). */
  stale: boolean;
  /** What the command under the lock did, for the page's wording while `stale`. */
  staleOutcome: CommandOutcome;
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
        fence: new ReadFence(),
        lock: null,
        stale: false,
        staleOutcome: 'unknown',
      };
      this.entries.set(k, e);
    }
    return e;
  }
  all(): DayEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Read the day from the server; `replace` only after a conflict or a finished command. The
   * shared fence decides: 'applied' (this response is now the day), 'superseded' (a newer
   * response was applied, or local edits were accepted after a barrier since this read
   * started: nothing changes), or 'failed'.
   */
  async read(
    e: DayEntry,
    replace: boolean,
  ): Promise<'applied' | 'superseded' | 'failed'> {
    const s = e.session;
    const ticket = e.fence.begin();
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
      if (
        !e.fence.current(ticket) ||
        !e.fence.mayOverwrite(ticket, s.editGeneration) ||
        (!replace && d.version < s.version) // older than what we already saved
      )
        return 'superseded';
      // Fresh only when the editable session took these facts: a read that adopt() refuses
      // (unsaved or conflicting edits) is applied to the view but never unlocks a day.
      const took = replace
        ? (s.reset(d.version, d.facts), true)
        : s.adopt(d, startedAt);
      e.fence.settle(ticket, true, took);
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
      return 'applied';
    } catch (err) {
      if (e.fence.settle(ticket, false) === 'applied')
        e.error = err instanceof ApiError ? err.code : 'REQUEST_FAILED';
      return 'failed';
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
  /**
   * Free the lock without a read: only by its owner, and only when nothing was written under
   * it. From here on, reads started earlier may not overwrite what is typed (the barrier).
   */
  abandon(e: DayEntry, owner: string) {
    if (e.lock !== owner) return;
    e.session.release();
    e.fence.barrier(e.session.editGeneration);
    e.lock = null;
    e.stale = false;
    this.notify();
  }
  /** Free the lock once a read started after the write has been applied (the fence). */
  private async freeWhenFresh(e: DayEntry, owner: string): Promise<boolean> {
    if (e.lock !== owner) return false;
    if (!e.fence.fresh) {
      e.stale = true;
      this.notify();
      return false;
    }
    this.abandon(e, owner);
    return true;
  }
  /**
   * Release after a command: only by the lock's owner, and only once a read started after the
   * command has been applied. A superseded or failed read never frees it: the day stays locked
   * (`stale`, worded by `outcome`) until `reloadLocked` lands one.
   */
  async release(
    e: DayEntry,
    owner: string,
    outcome: CommandOutcome = 'unknown',
  ): Promise<boolean> {
    if (e.lock !== owner) return false;
    e.fence.wrote();
    e.staleOutcome = outcome;
    await this.read(e, true);
    return this.freeWhenFresh(e, owner);
  }
  /** The Refresh of a day locked after a failed post-write read. */
  async reloadLocked(e: DayEntry): Promise<boolean> {
    const owner = e.lock;
    if (owner === null || !e.stale)
      return (await this.read(e, false)) !== 'failed';
    await this.read(e, true);
    return this.freeWhenFresh(e, owner);
  }

  /**
   * Hold the day for a command owned outside it (a foreman adoption): acquire, then save what
   * was typed. On 'ok' the day stays locked for `owner` and `version` is the version of that
   * save (the held session's own), which the command must send. If the save conflicted, the
   * day stays locked until its replacement read is applied (then it is free); any other
   * failure frees it (nothing was written).
   */
  async hold(
    e: DayEntry,
    owner: string,
  ): Promise<{ outcome: ActionOutcome; version: number }> {
    if (!this.acquire(e, owner))
      return { outcome: 'busy', version: e.session.version };
    try {
      const outcome = await e.session.hold();
      if (outcome === 'conflict') {
        // Refused: the day changed elsewhere. Edits stay refused until its read is applied.
        this.hooks.conflict();
        await this.release(e, owner, 'refused');
      } else if (outcome !== 'ok') this.abandon(e, owner);
      return { outcome, version: e.session.version };
    } catch (err) {
      // A throw before anything was sent under the lock (the pre-save itself threw).
      this.abandon(e, owner);
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
    let outcome: CommandOutcome = 'unknown';
    try {
      await fn(held.version);
      outcome = 'saved';
    } catch (err) {
      // Refused for certain only when answered at once: after a lost attempt (a transport
      // resend) the earlier send may have been recorded, so it stays unknown.
      if (
        err instanceof ApiError &&
        !UNSETTLED.has(err.code) &&
        !err.afterLostAttempt
      )
        outcome = 'refused';
      if (
        err instanceof ApiError &&
        (err.code === 'VERSION_CONFLICT' || err.code === 'LOCKED')
      )
        this.hooks.conflict();
      throw err;
    } finally {
      await this.release(e, owner, outcome);
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
  /**
   * Fill a retained input in again, as an edit of the user's (autosaved on the day's current
   * version); refused while the day is locked. Nothing else ever writes a retained input.
   */
  refill(e: DayEntry, path: string): boolean {
    if (e.lock !== null) return false;
    const r = e.session.retained.find((x) => x.path === path);
    if (!r) return false;
    if (leaf(e.session.facts, path) === r.mine) {
      e.session.dismiss(path);
      return true;
    }
    return this.edit(e, path, r.mine);
  }
  /** Drop a retained input without writing it. */
  dismiss(e: DayEntry, path: string) {
    e.session.dismiss(path);
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
