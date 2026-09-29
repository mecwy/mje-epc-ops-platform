import type { RevisionView } from '../api.js';

/** A submitted version opened read-only from the history. */
export interface Viewing {
  n: number;
  ticket: number;
  rev: RevisionView | null;
  failed: boolean;
}
export type HistoryAction =
  | { type: 'open'; n: number; ticket: number }
  | { type: 'loaded'; ticket: number; rev: RevisionView }
  | { type: 'failed'; ticket: number }
  | { type: 'close' };

/**
 * Only the answer for the version opened last is shown: a late answer for an earlier click,
 * or one arriving after the view was closed (back, another day, a task started), is dropped.
 */
export function historyReducer(
  s: Viewing | null,
  a: HistoryAction,
): Viewing | null {
  switch (a.type) {
    case 'open':
      return { n: a.n, ticket: a.ticket, rev: null, failed: false };
    case 'loaded':
      return s && s.ticket === a.ticket ? { ...s, rev: a.rev } : s;
    case 'failed':
      return s && s.ticket === a.ticket ? { ...s, failed: true } : s;
    case 'close':
      return null;
  }
}
