import { useEffect, useReducer } from 'react';
import type { SiteSessions } from './site-sessions.js';

/** Re-render when any People-page session changes. */
export function useSessions(sessions: SiteSessions) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => sessions.subscribe(rerender), [sessions]);
}
