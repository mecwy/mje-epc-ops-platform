import { useEffect, useReducer, useRef } from 'react';
import type { ReportApi } from '../api.js';
import { IssueSession } from './issue-session.js';

export type { NewIssue, IssueOutcome } from './issue-session.js';

/**
 * The IssueSession of the shown project day. Sessions live for the whole workspace, one per
 * day, so an action still running for a day that was left completes against that day only
 * and never touches the day now on screen. After each change the day view is reloaded.
 */
export function useIssues(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  onChanged: () => void,
  /** The day's state and revision: issues and lag reminders reload when they change. */
  dayStamp: string,
) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sessions = useRef(new Map<string, IssueSession>());
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const key = `${projectId}:${businessDate}`;
  let session = sessions.current.get(key);
  if (!session) {
    session = new IssueSession(api, projectId, businessDate, rerender);
    sessions.current.set(key, session);
  }
  const current = session;
  useEffect(() => {
    void current.load();
  }, [current, dayStamp]);

  const after = async <T>(p: Promise<T>) => {
    const r = await p;
    changed.current();
    return r;
  };
  return {
    session: current,
    issues: current.issues,
    lag: current.lag,
    busy: current.busy,
    error: current.error,
    pending: current.pending !== null,
    needsRetry: current.needsRetry,
    reload: () => current.load(),
    retry: () => after(current.retry()),
    create: (x: Parameters<IssueSession['create']>[0]) =>
      after(current.create(x)),
    note: (id: string, text: string) => after(current.note(id, text)),
    escalate: (...a: Parameters<IssueSession['escalate']>) =>
      after(current.escalate(...a)),
    close: (id: string) => after(current.close(id)),
    reopen: (id: string) => after(current.reopen(id)),
    reply: (id: string, text: string) => after(current.reply(id, text)),
    dismissLag: (workItemKey: string) => after(current.dismissLag(workItemKey)),
  };
}
export type IssuesHandle = ReturnType<typeof useIssues>;
