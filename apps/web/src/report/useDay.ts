import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { NoWorkReason } from '@mje/contracts';
import {
  ApiError,
  type DayView,
  type ReportApi,
  type ReportContent,
} from '../api.js';
import { DraftSession, type FlushOutcome } from './draft.js';
import { setFact } from './model.js';

export type { SaveState } from './draft.js';
const AUTOSAVE_MS = 700;

export class ActionAborted extends Error {
  constructor(public readonly outcome: FlushOutcome) {
    super(outcome);
  }
}

/**
 * One project day for the screens. Each day owns its DraftSession, so a save in flight for
 * one day can never touch another. Reloads keep unsaved local edits; only an explicit
 * conflict replaces them with the server state. Submitted days read the frozen revision.
 */
export function useDay(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  onConflict: () => void,
) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [day, setDay] = useState<DayView | null>(null);
  const [frozen, setFrozen] = useState<ReportContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<DraftSession | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflict = useRef(onConflict);
  conflict.current = onConflict;

  /** Server view of the day. Local edits survive unless `replace` (after a conflict). */
  const refresh = useCallback(
    async (s: DraftSession, replace: boolean) => {
      const d = await api.day(s.projectId, s.businessDate);
      if (session.current !== s) return;
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
      if (session.current !== s) return;
      if (replace || !s.dirty) s.reset(d.version, d.facts);
      setDay(d);
      setFrozen(content);
    },
    [api],
  );

  useEffect(() => {
    const previous = session.current;
    // Unsaved edits of the day being left are saved to that day, not dropped.
    if (previous?.dirty) void previous.flush();
    if (timer.current) clearTimeout(timer.current);
    const s = new DraftSession(
      projectId,
      businessDate,
      0,
      emptyFacts(),
      (c) => api.saveFacts(c),
      rerender,
    );
    session.current = s;
    setDay(null);
    setFrozen(null);
    setError(null);
    api
      .day(projectId, businessDate)
      .then(async (d) => {
        if (session.current !== s) return;
        s.reset(d.version, d.facts);
        const content =
          d.state === 'submitted' && d.currentRevisionNumber > 0
            ? (
                await api.revision(
                  projectId,
                  businessDate,
                  d.currentRevisionNumber,
                )
              ).snapshot
            : null;
        if (session.current !== s) return;
        setDay(d);
        setFrozen(content);
      })
      .catch(
        (e) =>
          session.current === s &&
          setError(e instanceof ApiError ? e.code : 'REQUEST_FAILED'),
      );
    // `api` is stable for a signed-in session; a language change does not reload the day.
  }, [api, projectId, businessDate]);

  const afterFlush = useCallback(
    async (s: DraftSession, outcome: FlushOutcome) => {
      if (outcome === 'conflict') {
        conflict.current();
        await refresh(s, true);
      } else if (outcome === 'ok' && !s.dirty) await refresh(s, false);
    },
    [refresh],
  );

  const flush = useCallback(async (): Promise<FlushOutcome> => {
    const s = session.current;
    if (!s) return 'ok';
    if (timer.current) clearTimeout(timer.current);
    const outcome = await s.flush();
    await afterFlush(s, outcome);
    return outcome;
  }, [afterFlush]);

  const edit = useCallback(
    (path: string, value: string | null) => {
      const s = session.current;
      if (!s) return;
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
      s.edit(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  /** Run an action only on exactly what the user sees, fully saved; otherwise abort. */
  const act = useCallback(
    async (fn: (version: number) => Promise<unknown>) => {
      const s = session.current;
      if (!s) throw new ActionAborted('failed');
      if (timer.current) clearTimeout(timer.current);
      const outcome = await s.settle();
      if (outcome !== 'ok') {
        await afterFlush(s, outcome);
        throw new ActionAborted(outcome);
      }
      try {
        await fn(s.version);
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.code === 'VERSION_CONFLICT' || e.code === 'LOCKED')
        ) {
          conflict.current();
          await refresh(s, true);
        }
        throw e;
      }
      await refresh(s, true);
    },
    [afterFlush, refresh],
  );

  const s = session.current;
  const ready = day !== null && s !== null;
  const base = () => ({
    projectId,
    businessDate,
    clientMutationId: crypto.randomUUID(),
  });
  return {
    day,
    /** Submitted days: the frozen revision. Otherwise: the live view with the local facts. */
    read: ready ? (frozen ?? { ...day, facts: s.facts }) : null,
    facts: ready ? s.facts : null,
    save: s?.state ?? 'idle',
    error,
    edit,
    flush,
    reload: () => (s ? refresh(s, false) : Promise.resolve()),
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
