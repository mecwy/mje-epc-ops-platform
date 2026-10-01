import { useCallback, useEffect, useReducer, useState } from 'react';
import type { NoWorkReason } from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { photoAsOf } from './model.js';
import { DayStore, type DraftRecovery } from './day-store.js';
import type { DraftStash } from '../signin.js';

export type { SaveState } from './draft.js';
export {
  ActionAborted,
  reconcileDraft,
  type DraftRecovery,
} from './day-store.js';

/**
 * Project days for the screens (the logic is DayStore's; this hook binds it to React). Each day
 * keeps its own DraftSession for the life of the workspace; every command on a day takes the
 * day's one mutation lock (DayStore.acquire), and edits wait while it is held.
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
  const [store] = useState(() => new DayStore(api, rerender));
  store.hooks = { conflict: onConflict, recovery };

  useEffect(() => {
    store.cancelAutosave();
    const e = store.entry(projectId, businessDate);
    // Returning to a day with unsaved or failed edits retries them; otherwise re-read it.
    if (e.session.dirty && e.lock === null) void store.flush(e);
    else void store.read(e, false);
    rerender();
    return () => {
      // Leaving: send what was typed to its own day; the entry keeps any failure for return.
      if (e.session.dirty && e.lock === null) void store.flush(e);
    };
  }, [store, projectId, businessDate]);

  const e = store.entry(projectId, businessDate);
  const flush = useCallback(() => store.flush(e), [store, e]);
  const edit = useCallback(
    (path: string, value: string | null) => void store.edit(e, path, value),
    [store, e],
  );
  const s = e.session;
  // Only a day read for this very date is shown; never another day's content.
  const day = e.day && e.day.businessDate === businessDate ? e.day : null;
  const ready = day !== null;
  const base = () => ({
    projectId,
    businessDate,
    clientMutationId: crypto.randomUUID(),
  });
  return {
    /** The workspace's day store (the PM's foreman adoption binds to it, pmDayBinding). */
    store,
    day,
    /** Submitted days: the frozen revision. Otherwise: the live view with the local facts. */
    read: ready
      ? (e.frozen ?? {
          ...day,
          facts: s.facts,
          photos: day.photos.filter((p) => p.link).map(photoAsOf),
        })
      : null,
    facts: ready ? s.facts : null,
    save: s.state,
    /** The day's lock is held (a command runs or is unresolved): the page is read-only. */
    busy: e.lock !== null,
    /** The lock's post-write read failed: the day waits for `reloadLocked`. */
    stale: e.stale,
    /** What the command under the lock did (the wording while `stale`). */
    staleOutcome: e.staleOutcome,
    error: e.error,
    edit,
    flush,
    /** Every day of this workspace with facts the server has not acknowledged. */
    unsaved: (): DraftStash[] =>
      store
        .all()
        .filter((x) => x.session.dirty)
        .map(({ session: d }) => ({
          projectId: d.projectId,
          businessDate: d.businessDate,
          version: d.version,
          facts: d.facts,
        })),
    reload: () => store.read(e, false),
    /** Inputs a conflict reload set aside: filled in again or ignored by the user, never auto-written. */
    retained: s.retained,
    refill: (path: string) => store.refill(e, path),
    dismiss: (path: string) => store.dismiss(e, path),
    reloadLocked: () => store.reloadLocked(e),
    submit: () =>
      store.act(e, (v) => api.submit({ ...base(), expectedVersion: v })),
    noWork: (reason: NoWorkReason, note: string) =>
      store.act(e, (v) =>
        api.noWork({ ...base(), expectedVersion: v, reason, note }),
      ),
    startCorrection: (reason: string) =>
      store.act(e, (v) =>
        api.startCorrection({ ...base(), expectedVersion: v, reason }),
      ),
    cancelCorrection: () =>
      store.act(e, (v) =>
        api.cancelCorrection({ ...base(), expectedVersion: v }),
      ),
  };
}
export type DayHandle = ReturnType<typeof useDay>;
