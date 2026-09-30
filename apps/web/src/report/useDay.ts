import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { NoWorkReason } from '@mje/contracts';
import {
  ApiError,
  type DayView,
  type ReportApi,
  type ReportContent,
} from '../api.js';
import { DraftSession, type FlushOutcome } from './draft.js';
import { photoAsOf, setFact } from './model.js';
import { restoreDecision, type DraftStash } from '../signin.js';

export type { SaveState } from './draft.js';
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
const AUTOSAVE_MS = 700;

export class ActionAborted extends Error {
  constructor(public readonly outcome: FlushOutcome) {
    super(outcome);
  }
}

/** Everything known about one project day; entries outlive navigation. */
interface Entry {
  session: DraftSession;
  day: DayView | null;
  frozen: ReportContent | null;
  error: string | null;
  /** Only the newest read of a day may be applied. */
  reads: number;
  busy: boolean;
}

/**
 * Project days for the screens. Each day keeps its own DraftSession for the life of the
 * workspace, so leaving a day never abandons its unsaved or failed edits: they are retried
 * on return. Reads are fenced: an older response never replaces newer acknowledged facts.
 * While an action runs the day refuses edits, so the action's result is what the user saw.
 */
export function useDay(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  onConflict: () => void,
  /** Unsaved facts put aside before a sign-in redirect; each is reconciled on its first read. */
  recovery?: DraftRecovery,
) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const entries = useRef(new Map<string, Entry>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflict = useRef(onConflict);
  conflict.current = onConflict;
  const key = `${projectId}:${businessDate}`;
  const recover = useRef(recovery);
  const afterRestore = useRef<(e: Entry, o: FlushOutcome) => Promise<void>>(
    async () => {},
  );

  const entryFor = useCallback(
    (pid: string, date: string): Entry => {
      const k = `${pid}:${date}`;
      let e = entries.current.get(k);
      if (!e) {
        const session: DraftSession = new DraftSession(
          pid,
          date,
          0,
          emptyFacts(),
          (c) => api.saveFacts(c),
          rerender,
        );
        e = {
          session,
          day: null,
          frozen: null,
          error: null,
          reads: 0,
          busy: false,
        };
        entries.current.set(k, e);
      }
      return e;
    },
    [api],
  );

  /** Read the day from the server; `replace` only after a conflict or a finished action. */
  const read = useCallback(
    async (e: Entry, replace: boolean) => {
      const s = e.session;
      const ticket = ++e.reads;
      const startedAt = s.editGeneration;
      try {
        const d = await api.day(s.projectId, s.businessDate);
        const content =
          d.state === 'submitted' && d.currentRevisionNumber > 0
            ? (
                await api.revision(
                  s.projectId,
                  s.businessDate,
                  d.currentRevisionNumber,
                )
              ).snapshot
            : null;
        if (ticket !== e.reads) return;
        if (!replace && d.version < s.version) return; // older than what we already saved
        if (replace) s.reset(d.version, d.facts);
        else s.adopt(d, startedAt);
        e.day = d;
        e.frozen = content;
        e.error = null;
        // Only against a read the session took (not refused by adopt), else wait for the next.
        if (s.version === d.version)
          reconcileDraft(
            recover.current,
            s,
            () => conflict.current(),
            (o) => void afterRestore.current(e, o),
          );
      } catch (err) {
        if (ticket === e.reads)
          e.error = err instanceof ApiError ? err.code : 'REQUEST_FAILED';
      }
      rerender();
    },
    [api],
  );

  const settleAfter = useCallback(
    async (e: Entry, outcome: FlushOutcome) => {
      if (outcome === 'conflict') {
        conflict.current();
        await read(e, true);
      } else if (outcome === 'ok' && !e.session.dirty) await read(e, false);
    },
    [read],
  );
  afterRestore.current = settleAfter;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const e = entryFor(projectId, businessDate);
    // Returning to a day with unsaved or failed edits retries them; otherwise re-read it.
    if (e.session.dirty) void e.session.flush().then((o) => settleAfter(e, o));
    else void read(e, false);
    rerender();
    return () => {
      // Leaving: send what was typed to its own day; the entry keeps any failure for return.
      if (e.session.dirty)
        void e.session.flush().then(async (o) => {
          if (o === 'conflict') await read(e, true);
        });
    };
  }, [entryFor, read, settleAfter, projectId, businessDate]);

  const flush = useCallback(async (): Promise<FlushOutcome> => {
    const e = entries.current.get(key);
    if (!e) return 'ok';
    if (timer.current) clearTimeout(timer.current);
    const outcome = await e.session.flush();
    await settleAfter(e, outcome);
    return outcome;
  }, [key, settleAfter]);

  const edit = useCallback(
    (path: string, value: string | null) => {
      const e = entries.current.get(key);
      if (!e || e.busy) return;
      const s = e.session;
      let next =
        path === 'noWork'
          ? { ...s.facts, noWork: null }
          : setFact(s.facts, path, value ?? '');
      if (path.startsWith('qty.'))
        next = setFact(
          next,
          `updated.${path.slice(4)}`,
          new Date().toISOString(),
        );
      if (!s.edit(next)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [key, flush],
  );

  /** Run an action only on exactly what the user sees, fully saved, with edits frozen. */
  const act = useCallback(
    async (fn: (version: number) => Promise<unknown>) => {
      const e = entries.current.get(key);
      if (!e) throw new ActionAborted('failed');
      const s = e.session;
      if (timer.current) clearTimeout(timer.current);
      e.busy = true;
      rerender();
      try {
        const outcome = await s.settle();
        if (outcome !== 'ok') {
          await settleAfter(e, outcome);
          throw new ActionAborted(outcome);
        }
        s.locked = true;
        try {
          await fn(s.version);
        } catch (err) {
          if (
            err instanceof ApiError &&
            (err.code === 'VERSION_CONFLICT' || err.code === 'LOCKED')
          ) {
            conflict.current();
            await read(e, true);
          }
          throw err;
        }
        await read(e, true);
      } finally {
        s.locked = false;
        e.busy = false;
        rerender();
      }
    },
    [key, read, settleAfter],
  );

  /**
   * Hold a day for a command owned outside it (a foreman adoption, C62): everything typed is
   * saved first, then the day refuses edits (read-only) until `release`. A failed save frees
   * it again and is settled like any other (a conflict reloads it and says so).
   */
  const hold = useCallback(
    async (date: string): Promise<FlushOutcome> => {
      const e = entryFor(projectId, date);
      if (date === businessDate && timer.current) clearTimeout(timer.current);
      e.busy = true;
      rerender();
      const outcome = await e.session.hold();
      if (outcome !== 'ok') {
        await settleAfter(e, outcome);
        e.busy = false;
        rerender();
      }
      return outcome;
    },
    [entryFor, projectId, businessDate, settleAfter],
  );
  /** Read a held day again (nothing was typed meanwhile) and free it for editing. */
  const release = useCallback(
    async (date: string) => {
      const e = entryFor(projectId, date);
      try {
        await read(e, true);
      } finally {
        e.session.release();
        e.busy = false;
        rerender();
      }
    },
    [entryFor, projectId, read],
  );

  const e = entries.current.get(key);
  const s = e?.session;
  // Only a day read for this very date is shown; never another day's content.
  const day = e?.day && e.day.businessDate === businessDate ? e.day : null;
  const ready = day !== null && s !== undefined;
  const base = () => ({
    projectId,
    businessDate,
    clientMutationId: crypto.randomUUID(),
  });
  return {
    day,
    /** Submitted days: the frozen revision. Otherwise: the live view with the local facts. */
    read: ready
      ? (e!.frozen ?? {
          ...day,
          facts: s.facts,
          photos: day.photos.filter((p) => p.link).map(photoAsOf),
        })
      : null,
    facts: ready ? s.facts : null,
    save: s?.state ?? 'idle',
    busy: e?.busy ?? false,
    error: e?.error ?? null,
    edit,
    flush,
    hold,
    release,
    /** Every day of this workspace with facts the server has not acknowledged. */
    unsaved: (): DraftStash[] =>
      [...entries.current.values()]
        .filter((x) => x.session.dirty)
        .map(({ session: d }) => ({
          projectId: d.projectId,
          businessDate: d.businessDate,
          version: d.version,
          facts: d.facts,
        })),
    reload: () => (e ? read(e, false) : Promise.resolve()),
    submit: () => act((v) => api.submit({ ...base(), expectedVersion: v })),
    noWork: (reason: NoWorkReason, note: string) =>
      act((v) => api.noWork({ ...base(), expectedVersion: v, reason, note })),
    startCorrection: (reason: string) =>
      act((v) =>
        api.startCorrection({ ...base(), expectedVersion: v, reason }),
      ),
    cancelCorrection: () =>
      act((v) => api.cancelCorrection({ ...base(), expectedVersion: v })),
  };
}
export type DayHandle = ReturnType<typeof useDay>;

function emptyFacts() {
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
