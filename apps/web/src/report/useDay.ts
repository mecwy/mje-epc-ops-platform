import { useCallback, useEffect, useRef, useState } from 'react';
import type { DayFactsDto, NoWorkReason } from '@mje/contracts';
import {
  ApiError,
  type DayView,
  type ReportApi,
  type ReportContent,
} from '../api.js';
import { savable, setFact } from './model.js';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';
const newId = () => crypto.randomUUID();

/**
 * One project day. Edits autosave (debounced) with expectedVersion; only one write is in
 * flight and later edits follow it. A version conflict reloads the day instead of overwriting.
 * Submitted content is read from the frozen revision, never recomputed.
 */
export function useDay(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  onConflict: () => void,
) {
  const [day, setDay] = useState<DayView | null>(null);
  const [read, setRead] = useState<ReportContent | null>(null);
  const [facts, setFacts] = useState<DayFactsDto | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const version = useRef(0);
  const latest = useRef<DayFactsDto | null>(null);
  const sent = useRef<DayFactsDto | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `${projectId}:${businessDate}`;
  const current = useRef(key);
  current.current = key;

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api.day(projectId, businessDate);
      if (current.current !== key) return;
      const content =
        d.state === 'submitted' && d.currentRevisionNumber > 0
          ? (
              await api.revision(
                projectId,
                businessDate,
                d.currentRevisionNumber,
              )
            ).snapshot
          : d;
      if (current.current !== key) return;
      version.current = d.version;
      latest.current = d.facts;
      sent.current = d.facts;
      setDay(d);
      setRead(content);
      setFacts(d.facts);
      setSave('idle');
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
    }
  }, [api, projectId, businessDate, key]);

  useEffect(() => {
    setDay(null);
    setRead(null);
    setFacts(null);
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    while (inflight.current) await inflight.current;
    const f = latest.current;
    if (!f || f === sent.current) return;
    if (!savable(f)) {
      setSave('invalid');
      return;
    }
    const run = (async () => {
      setSave('saving');
      try {
        const r = await api.saveFacts({
          projectId,
          businessDate,
          expectedVersion: version.current,
          clientMutationId: newId(),
          facts: f,
        });
        version.current = r.version;
        sent.current = f;
        setDay((d) => (d ? { ...d, version: r.version, state: r.state } : d));
        setSave('saved');
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.code === 'VERSION_CONFLICT' || e.code === 'LOCKED')
        ) {
          onConflict();
          await load();
        } else setSave('failed');
      }
    })();
    inflight.current = run;
    await run;
    inflight.current = null;
    if (latest.current !== sent.current && savable(latest.current!))
      await flush();
  }, [api, projectId, businessDate, load, onConflict]);

  const edit = useCallback(
    (path: string, value: string) => {
      setFacts((prev) => {
        if (!prev) return prev;
        let next = setFact(prev, path, value);
        if (path.startsWith('qty.'))
          next = setFact(
            next,
            `updated.${path.slice(4)}`,
            new Date().toISOString(),
          );
        latest.current = next;
        return next;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 700);
    },
    [flush],
  );

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      await flush();
      try {
        await fn();
      } catch (e) {
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
          onConflict();
        await load();
        throw e;
      }
      await load();
    },
    [flush, load, onConflict],
  );
  const base = () => ({ projectId, businessDate, clientMutationId: newId() });
  return {
    day,
    read,
    facts,
    save,
    error,
    reload: load,
    edit,
    flush,
    submit: () =>
      act(() => api.submit({ ...base(), expectedVersion: version.current })),
    noWork: (reason: NoWorkReason, note: string) =>
      act(() =>
        api.noWork({
          ...base(),
          expectedVersion: version.current,
          reason,
          note,
        }),
      ),
    startCorrection: (reason: string) =>
      act(() =>
        api.startCorrection({
          ...base(),
          expectedVersion: version.current,
          reason,
        }),
      ),
    cancelCorrection: () =>
      act(() =>
        api.cancelCorrection({ ...base(), expectedVersion: version.current }),
      ),
  };
}
export type DayHandle = ReturnType<typeof useDay>;
