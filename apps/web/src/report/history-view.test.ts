import { describe, expect, it } from 'vitest';
import type { RevisionView } from '../api.js';
import { historyReducer } from './history-view.js';

const rev = (n: number) => ({ n }) as unknown as RevisionView;

describe('history view', () => {
  it('shows only the answer for the version opened last', () => {
    let s = historyReducer(null, { type: 'open', n: 1, ticket: 1 });
    s = historyReducer(s, { type: 'open', n: 2, ticket: 2 });
    s = historyReducer(s, { type: 'loaded', ticket: 1, rev: rev(1) });
    expect(s).toEqual({ n: 2, ticket: 2, rev: null, failed: false });
    s = historyReducer(s, { type: 'failed', ticket: 1 });
    expect(s?.failed).toBe(false);
    s = historyReducer(s, { type: 'loaded', ticket: 2, rev: rev(2) });
    expect(s?.rev).toEqual(rev(2));
  });

  it('a late answer after closing (back, another day, a task) does not reopen it', () => {
    let s = historyReducer(null, { type: 'open', n: 1, ticket: 1 });
    s = historyReducer(s, { type: 'close' });
    expect(historyReducer(s, { type: 'loaded', ticket: 1, rev: rev(1) })).toBe(
      null,
    );
    expect(historyReducer(s, { type: 'failed', ticket: 1 })).toBe(null);
  });
});
