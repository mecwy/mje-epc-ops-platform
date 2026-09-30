import { describe, expect, it } from 'vitest';
import type { DayFactsDto } from '@mje/contracts';
import {
  INTERACTION_KEY,
  chooseInteraction,
  clearStaleInteraction,
  restoreDecision,
  saveResume,
  signInFailure,
  takeResume,
  type ResumeState,
} from './signin.js';

function memoryStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const facts = (qty: Record<string, string>) =>
  ({
    weather: '',
    qty,
    narrative: { construction: '' },
  }) as unknown as DayFactsDto;

describe('chooseInteraction', () => {
  it('redirects on phones, in-app browsers and ordinary desktop tabs', () => {
    expect(chooseInteraction({ embedded: false, finePointer: false })).toBe(
      'redirect',
    );
    expect(chooseInteraction({ embedded: false, finePointer: true })).toBe(
      'redirect',
    );
    expect(chooseInteraction({ embedded: true, finePointer: false })).toBe(
      'redirect',
    );
  });
  it('uses a popup only for a page embedded in a frame on a desktop', () => {
    expect(chooseInteraction({ embedded: true, finePointer: true })).toBe(
      'popup',
    );
  });
});

describe('signInFailure', () => {
  const err = (errorCode: string, extra: object = {}) => ({
    name: 'BrowserAuthError',
    errorCode,
    errorMessage: '',
    ...extra,
  });
  it.each([
    ['user_cancelled', 'signInCancelled'],
    ['popup_window_error', 'signInBlocked'],
    ['redirect_in_iframe', 'signInBlocked'],
    ['interaction_in_progress', 'signInBusy'],
    ['no_network_connectivity', 'signInNetwork'],
    ['timed_out', 'signInNetwork'],
    ['state_mismatch', 'signInInterrupted'],
    ['no_token_request_cache_error', 'signInInterrupted'],
    ['access_denied', 'signInRejected'],
  ])('%s → %s', (code, key) => {
    expect(signInFailure(err(code))).toEqual({ key, code });
  });
  it('shows the AADSTS number of a server refusal, never its message text', () => {
    const f = signInFailure({
      name: 'ServerError',
      errorCode: 'something_new',
      errorMessage:
        'AADSTS50020: User account person@example.com from identity provider does not exist',
    });
    expect(f).toEqual({ key: 'signInRejected', code: 'AADSTS50020' });
  });
  it('falls back to the generic message; odd codes are not shown', () => {
    expect(signInFailure(new Error('boom'))).toEqual({
      key: 'signInFailed',
      code: null,
    });
    expect(signInFailure(err('constructor')).key).toBe('signInFailed');
    expect(signInFailure(err('<b>x</b>')).code).toBeNull();
    expect(signInFailure(null).key).toBe('signInFailed');
  });
});

describe('clearStaleInteraction', () => {
  it('removes a lock this app left', () => {
    const s = memoryStore({
      [INTERACTION_KEY]: JSON.stringify({ clientId: 'app', type: 'signin' }),
    });
    expect(clearStaleInteraction(s, 'app')).toBe(true);
    expect(s.data.has(INTERACTION_KEY)).toBe(false);
  });
  it('removes an unreadable lock', () => {
    const s = memoryStore({ [INTERACTION_KEY]: 'app' });
    expect(clearStaleInteraction(s, 'app')).toBe(true);
    expect(s.data.size).toBe(0);
  });
  it("leaves another app's lock and other keys alone", () => {
    const other = JSON.stringify({ clientId: 'other', type: 'signin' });
    const s = memoryStore({ [INTERACTION_KEY]: other, keep: '1' });
    expect(clearStaleInteraction(s, 'app')).toBe(false);
    expect(s.data.get(INTERACTION_KEY)).toBe(other);
    expect(s.data.get('keep')).toBe('1');
    expect(clearStaleInteraction(memoryStore(), 'app')).toBe(false);
  });
});

describe('resume state', () => {
  const state: ResumeState = {
    projectId: 'p2',
    date: '2026-09-29',
    view: 'field',
    drafts: [
      {
        projectId: 'p2',
        businessDate: '2026-09-29',
        version: 4,
        facts: facts({ a: '12' }),
      },
    ],
  };
  it('restores project, date, view and drafts once', () => {
    const s = memoryStore();
    expect(saveResume(s, state)).toBe(true);
    expect([...s.data.keys()].join()).not.toMatch(/token|msal/i);
    expect(takeResume(s)).toEqual(state);
    expect(takeResume(s)).toBeNull();
  });
  it('drops malformed state and malformed drafts', () => {
    const s = memoryStore();
    s.setItem('mje-resume', '{not json');
    expect(takeResume(s)).toBeNull();
    saveResume(s, { ...state, view: 'admin' as 'field' });
    expect(takeResume(s)).toBeNull();
    saveResume(s, {
      ...state,
      drafts: [
        ...state.drafts,
        { ...state.drafts[0]!, version: 1.5 },
        { ...state.drafts[0]!, businessDate: 'today' },
      ],
    });
    expect(takeResume(s)?.drafts).toEqual(state.drafts);
  });
  it('reports a store that cannot keep it', () => {
    expect(saveResume(null, state)).toBe(false);
    const full = {
      ...memoryStore(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveResume(full, state)).toBe(false);
    expect(takeResume(null)).toBeNull();
  });
});

describe('restoreDecision', () => {
  const stash = {
    projectId: 'p',
    businessDate: '2026-09-29',
    version: 4,
    facts: facts({ a: '12', b: '3' }),
  };
  it('re-applies unsaved facts when the day has not moved on', () => {
    expect(
      restoreDecision(stash, { version: 4, facts: facts({ a: '1' }) }),
    ).toBe('apply');
  });
  it('does nothing when the last write already landed (key order ignored)', () => {
    expect(
      restoreDecision(stash, { version: 5, facts: facts({ b: '3', a: '12' }) }),
    ).toBe('saved');
  });
  it('never overwrites a newer server state', () => {
    expect(
      restoreDecision(stash, { version: 5, facts: facts({ a: '9' }) }),
    ).toBe('conflict');
  });
});
