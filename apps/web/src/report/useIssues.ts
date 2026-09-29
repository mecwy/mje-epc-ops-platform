import { useCallback, useEffect, useRef, useState } from 'react';
import type { EscalationCategory } from '@mje/contracts';
import { ApiError, type IssueItem, type ReportApi } from '../api.js';

export interface NewIssue {
  title: string;
  category: EscalationCategory | '';
  escalate: boolean;
  controlled: boolean;
  workItemKey: string | null;
  dueOn: string | null;
  note: string;
}

/**
 * The issues of one project day for editing, plus the lag reminders (suggestions only; the
 * project manager decides). Actions run one at a time with the issue's current version; a
 * conflict reloads instead of overwriting. Issues have their own lifecycle: editing them
 * never changes a submitted report, whose snapshot keeps the issues as they stood.
 */
export function useIssues(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  onChanged: () => void,
  onError: (code: string) => void,
) {
  const [issues, setIssues] = useState<IssueItem[] | null>(null);
  const [lag, setLag] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const reads = useRef(0);
  // Queued actions read the version when they run, not when they were clicked.
  const current = useRef<IssueItem[] | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(async () => {
    const ticket = ++reads.current;
    try {
      const [list, suggestions] = await Promise.all([
        api.issues(projectId, businessDate),
        api.lag(projectId, businessDate),
      ]);
      if (ticket !== reads.current) return;
      current.current = list.issues;
      setIssues(list.issues);
      setLag(suggestions.suggestions.map((s) => s.workItemKey));
    } catch (e) {
      if (ticket === reads.current)
        onError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
    }
  }, [api, projectId, businessDate, onError]);

  useEffect(() => {
    setIssues(null);
    setLag([]);
    void load();
  }, [load]);

  const run = useCallback(
    (write: () => Promise<unknown>) => {
      const job = async () => {
        setBusy(true);
        try {
          await write();
          return true;
        } catch (e) {
          onError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
          return false;
        } finally {
          await load();
          onChanged();
          setBusy(false);
        }
      };
      const next = queue.current.then(job, job);
      queue.current = next.catch(() => undefined);
      return next;
    },
    [load, onChanged, onError],
  );
  const key = () => crypto.randomUUID();
  const find = (id: string) => current.current?.find((i) => i.id === id);

  return {
    issues,
    lag,
    busy,
    reload: load,
    create: (x: NewIssue) =>
      run(() =>
        api.createIssue({
          projectId,
          businessDate,
          clientMutationId: key(),
          ownerPersonId: null,
          ...x,
        }),
      ),
    note: (id: string, text: string) =>
      run(() =>
        api.noteIssue({
          issueId: id,
          businessDate,
          expectedVersion: find(id)?.version ?? 0,
          clientMutationId: key(),
          text,
        }),
      ),
    escalate: (
      id: string,
      escalate: boolean,
      category: EscalationCategory | '',
    ) =>
      run(() =>
        api.escalateIssue({
          issueId: id,
          expectedVersion: find(id)?.version ?? 0,
          clientMutationId: key(),
          escalate,
          category,
        }),
      ),
    close: (id: string) =>
      run(() =>
        api.closeIssue({
          issueId: id,
          businessDate,
          expectedVersion: find(id)?.version ?? 0,
          clientMutationId: key(),
        }),
      ),
    reopen: (id: string) =>
      run(() =>
        api.reopenIssue({
          issueId: id,
          businessDate,
          expectedVersion: find(id)?.version ?? 0,
          clientMutationId: key(),
        }),
      ),
    reply: (id: string, text: string) =>
      run(() =>
        api.replyIssue({
          issueId: id,
          businessDate,
          clientMutationId: key(),
          text,
        }),
      ),
    dismissLag: (workItemKey: string) =>
      run(() =>
        api.dismissLag({
          projectId,
          businessDate,
          workItemKey,
          clientMutationId: key(),
        }),
      ),
  };
}
export type IssuesHandle = ReturnType<typeof useIssues>;
