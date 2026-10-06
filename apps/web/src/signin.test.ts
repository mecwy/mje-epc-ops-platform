import { parseFacts } from '@mje/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { DayFactsDto, SaveFactsCommand } from '@mje/contracts';
import { workspaceRecovery } from './App.js';
import { DraftSession } from './report/draft.js';
import { reconcileDraft } from './report/useDay.js';
import {
  INTERACTION_KEY,
  RESUME_LIMITS,
  ResumeKeeper,
  chooseInteraction,
  clearStaleInteraction,
  isFactsShape,
  readResume,
  renewal,
  restoreDecision,
  saveResume,
  signInFailure,
  type DraftStash,
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

const facts = (qty: Record<string, string>): DayFactsDto => ({
  weather: '',
  temperature: '',
  qty,
  cumulative: {},
  narrative: { construction: '', quality: '', safety: '' },
  people: {},
  presence: {},
  machinery: {},
  materials: {},
  milestones: {},
  noWork: null,
  updated: {},
});

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

const NOW = Date.UTC(2026, 8, 30, 8);
const draft = (businessDate: string, qty = '12'): DraftStash => ({
  projectId: 'p2',
  businessDate,
  version: 4,
  facts: facts({ a: qty }),
});
const place = { projectId: 'p2', date: '2026-09-29', view: 'field' as const };

describe('resume state', () => {
  const state: ResumeState = {
    ...place,
    drafts: [draft('2026-09-29')],
    savedAt: NOW,
  };
  it.each([1, 2, 3, 4] as const)(
    'round-trips source cells through a sign-in resume without converting blank or raw text (V%s)',
    (schemaVersion) => {
      const s = memoryStore();
      const saved = draft('2025-03-10');
      saved.facts.sourceReport = parseFacts({
        ...saved.facts,
        sourceReport: {
          documents: {
            testDoc: {
              sha256: 'b'.repeat(64),
              label: 'TEST sign-in source',
              format: 'docx',
            },
          },
          peopleTotal: {
            raw: ' \n ',
            state: 'blank',
            at: { document: 'testDoc', table: 0, row: 0, cell: 0, gridSpan: 2 },
          },
          workPercent: {},
          materials: {},
          ...(schemaVersion !== 1
            ? {
                schemaVersion,
                ...(schemaVersion === 4
                  ? {
                      personnelRemarks: {
                        installer: {
                          raw: ' ',
                          state: 'blank',
                          at: {
                            document: 'testDoc',
                            table: 3,
                            row: 1,
                            cell: 4,
                          },
                        },
                      },
                    }
                  : {}),
                ...(schemaVersion >= 3
                  ? {
                      milestones: {
                        testMilestone: {
                          reportedDelayDays: {
                            raw: ' ',
                            state: 'blank' as const,
                            at: {
                              document: 'testDoc',
                              table: 1,
                              row: 1,
                              cell: 3,
                            },
                          },
                        },
                      },
                    }
                  : {}),
                reportedNextPlan: {
                  targetBusinessDate: '2025-03-11',
                  quantities: {
                    testWork: {
                      raw: ' 23 ',
                      state: 'value' as const,
                      at: { document: 'testDoc', table: 2, row: 1, cell: 7 },
                    },
                  },
                },
              }
            : { schemaVersion: 1 as const }),
        },
      }).sourceReport!;
      const withSource = { ...state, drafts: [saved] };
      expect(saveResume(s, withSource)).toBe(true);
      expect(readResume(s, NOW)).toEqual(withSource);
      expect(
        readResume(s, NOW)?.drafts[0]?.facts.sourceReport?.peopleTotal?.raw,
      ).toBe(' \n ');
    },
  );
  it('reads project, date, view and drafts without removing them', () => {
    const s = memoryStore();
    expect(saveResume(s, state)).toBe(true);
    expect([...s.data.keys()].join()).not.toMatch(/token|msal/i);
    expect(readResume(s, NOW)).toEqual(state);
    expect(readResume(s, NOW)).toEqual(state);
  });
  it('keeps unsaved text the server would refuse, drops malformed drafts', () => {
    const s = memoryStore();
    const odd = draft('2026-09-28', '12,5 approx');
    saveResume(s, {
      ...state,
      drafts: [
        ...state.drafts,
        odd,
        { ...draft('2026-09-27'), version: 1.5 },
        { ...draft('2026-09-26'), businessDate: 'today' },
        { ...draft('2026-09-25'), facts: {} as DayFactsDto },
        {
          ...draft('2026-09-24'),
          facts: { ...facts({}), qty: { a: 12 } } as unknown as DayFactsDto,
        },
      ],
    });
    expect(readResume(s, NOW)?.drafts).toEqual([...state.drafts, odd]);
  });
  it('drops and removes malformed, too old, future or oversized state', () => {
    const cases: [string, number][] = [
      ['{not json', NOW],
      [JSON.stringify({ ...state, view: 'admin' }), NOW],
      [JSON.stringify({ ...state, savedAt: undefined }), NOW],
      [JSON.stringify(state), NOW + RESUME_LIMITS.maxAgeMs + 1],
      [JSON.stringify(state), NOW - 1],
      [
        JSON.stringify({
          ...state,
          drafts: Array.from({ length: RESUME_LIMITS.maxDrafts + 1 }, () =>
            draft('2026-09-29'),
          ),
        }),
        NOW,
      ],
      ['x'.repeat(RESUME_LIMITS.maxBytes + 1), NOW],
    ];
    for (const [raw, now] of cases) {
      const s = memoryStore({ 'mje-resume': raw });
      expect(readResume(s, now)).toBeNull();
      expect(s.data.size).toBe(0);
    }
  });
  it('refuses to store more than the limits or into an unusable store', () => {
    const s = memoryStore();
    const many = Array.from({ length: RESUME_LIMITS.maxDrafts + 1 }, (_, i) =>
      draft(`2026-08-${String((i % 28) + 1).padStart(2, '0')}`),
    );
    expect(saveResume(s, { ...state, drafts: many })).toBe(false);
    const huge = draft('2026-09-29', 'x'.repeat(RESUME_LIMITS.maxBytes));
    expect(saveResume(s, { ...state, drafts: [huge] })).toBe(false);
    expect(s.data.size).toBe(0);
    expect(saveResume(null, state)).toBe(false);
    const full = {
      ...memoryStore(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveResume(full, state)).toBe(false);
    expect(readResume(null, NOW)).toBeNull();
  });
  it('checks the facts shape', () => {
    expect(isFactsShape(facts({ a: 'abc' }))).toBe(true);
    expect(
      isFactsShape({ ...facts({}), noWork: { reason: 'rain', note: '' } }),
    ).toBe(true);
    expect(isFactsShape({ ...facts({}), presence: { x: 'maybe' } })).toBe(
      false,
    );
    expect(isFactsShape({ ...facts({}), narrative: null })).toBe(false);
    expect(isFactsShape([])).toBe(false);
  });
});

describe('ResumeKeeper', () => {
  const stashed = (s: ReturnType<typeof memoryStore>, drafts: DraftStash[]) =>
    saveResume(s, { ...place, drafts, savedAt: NOW });

  it('keeps the stash through a cancelled sign-in and restores it after the retry', () => {
    const s = memoryStore();
    stashed(s, [draft('2026-09-29')]);
    // Return 1: sign-in cancelled, the workspace never opens.
    const cancelled = new ResumeKeeper(s, NOW + 1000);
    expect(cancelled.state?.date).toBe('2026-09-29');
    // Return 2: the retry succeeds.
    const retried = new ResumeKeeper(s, NOW + 60_000);
    retried.opened();
    expect(retried.state?.view).toBe('field');
    expect(retried.draft('p2', '2026-09-29')).toEqual(draft('2026-09-29'));
    retried.resolved(draft('2026-09-29'));
    expect(s.data.size).toBe(0);
  });

  it('clears the place once the workspace opened when there is no draft', () => {
    const s = memoryStore();
    stashed(s, []);
    const k = new ResumeKeeper(s, NOW);
    expect(s.data.size).toBe(1);
    k.opened();
    expect(s.data.size).toBe(0);
  });

  it('carries drafts of days not opened yet into the next renewal', () => {
    const s = memoryStore();
    stashed(s, [draft('2026-09-28'), draft('2026-09-29')]);
    const k = new ResumeKeeper(s, NOW);
    k.opened();
    k.taken(draft('2026-09-29')); // opened and applied; now unsaved in its session
    const unsaved = [draft('2026-09-29', '13')];
    expect(k.save(place, unsaved, NOW + 5000)).toBe(true);
    const next = new ResumeKeeper(s, NOW + 10_000);
    expect(next.state?.drafts).toEqual([draft('2026-09-28'), unsaved[0]]);
    expect(next.state?.savedAt).toBe(NOW + 5000);
  });

  it('snapshots both mounted projects and a not-yet-opened day through one renewal', async () => {
    const s = memoryStore();
    const first = draft('2026-09-29', '11');
    const second = { ...draft('2026-09-29', '19'), projectId: 'p9' };
    const unopened = { ...draft('2026-09-28', '4'), projectId: 'p9' };
    stashed(s, [unopened]);
    const k = new ResumeKeeper(s, NOW);
    k.retainWritableProjects(['p2', 'p9']);
    const one = {
      flush: vi.fn(async () => 'ok' as const),
      unsaved: () => [first],
    };
    const two = {
      flush: vi.fn(async () => 'ok' as const),
      unsaved: () => [second],
    };
    const workspaces = new Map([
      ['p2', one],
      ['p9', two],
    ]);
    const recovery = workspaceRecovery(workspaces);
    const redirect = vi.fn(async () => {});
    const flow = renewal({
      flush: recovery.flush,
      snapshot: () => k.save(place, recovery.unsaved(), NOW + 1),
      redirect,
    });
    expect(await flow.start()).toBe('done');
    expect(one.flush).toHaveBeenCalledOnce();
    expect(two.flush).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledOnce();
    const reloaded = new ResumeKeeper(s, NOW + 2);
    reloaded.retainWritableProjects(['p2', 'p9']);
    reloaded.opened();
    reloaded.opened();
    expect(reloaded.draft('p2', first.businessDate)).toEqual(first);
    expect(reloaded.draft('p9', second.businessDate)).toEqual(second);
    reloaded.resolved(first);
    expect(readResume(s, NOW + 2)?.drafts).toEqual([unopened, second]);
  });
  it('does not reintroduce revoked or read-only project drafts into a new snapshot', () => {
    const s = memoryStore();
    const inaccessible = { ...draft('2026-09-29'), projectId: 'p9' };
    stashed(s, [draft('2026-09-29'), inaccessible]);
    const k = new ResumeKeeper(s, NOW);
    k.retainWritableProjects(['p2']);
    expect(k.draft('p9', inaccessible.businessDate)).toBeNull();
    expect(k.save(place, [inaccessible], NOW + 1)).toBe(true);
    expect(readResume(s, NOW + 1)?.drafts).toEqual([draft('2026-09-29')]);
  });
  it('blocks redirect if combined workspace drafts exceed the bounded stash', async () => {
    const s = memoryStore();
    const k = new ResumeKeeper(s, NOW);
    const workspaces = new Map(
      Array.from({ length: RESUME_LIMITS.maxDrafts + 1 }, (_, n) => {
        const projectId = 'TEST-project-' + n;
        return [
          projectId,
          {
            flush: async () => 'ok' as const,
            unsaved: () => [{ ...draft('2026-09-29'), projectId }],
          },
        ] as const;
      }),
    );
    k.retainWritableProjects([...workspaces.keys()]);
    const recovery = workspaceRecovery(workspaces);
    const redirect = vi.fn(async () => {});
    const flow = renewal({
      flush: recovery.flush,
      snapshot: () => k.save(place, recovery.unsaved(), NOW + 1),
      redirect,
    });
    expect(await flow.start()).toBe('unsaved');
    expect(redirect).not.toHaveBeenCalled();
  });
  it('retains another project pending draft when the second workspace mounts', () => {
    const s = memoryStore();
    const first = draft('2026-09-29');
    const second = { ...draft('2026-09-29', '19'), projectId: 'p9' };
    stashed(s, [first, second]);
    const k = new ResumeKeeper(s, NOW);
    k.opened();
    k.opened();
    expect(k.draft('p2', first.businessDate)).toEqual(first);
    expect(k.draft('p9', second.businessDate)).toEqual(second);
    expect(readResume(s, NOW)?.drafts).toEqual([first, second]);
  });
  it('drops inaccessible drafts only after the authorised writable-project read', () => {
    const s = memoryStore();
    stashed(s, [
      draft('2026-09-29'),
      { ...draft('2026-09-29'), projectId: 'p9' },
    ]);
    const k = new ResumeKeeper(s, NOW);
    k.retainWritableProjects(['p2']);
    k.opened();
    expect(k.pendingCount).toBe(1);
    expect(readResume(s, NOW)?.drafts).toEqual([draft('2026-09-29')]);
  });
});

describe('renewal', () => {
  const deferred = () => {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('starts one flush, snapshot and redirect for repeated clicks', async () => {
    const flush = deferred();
    const steps = {
      flush: vi.fn(() => flush.promise),
      snapshot: vi.fn(() => true),
      redirect: vi.fn(async () => {}),
    };
    const r = renewal(steps);
    const first = r.start();
    expect(r.busy).toBe(true); // taken before the flush
    await expect(r.start()).resolves.toBe('busy');
    flush.resolve();
    await expect(first).resolves.toBe('done');
    expect(steps.flush).toHaveBeenCalledOnce();
    expect(steps.snapshot).toHaveBeenCalledOnce();
    expect(steps.redirect).toHaveBeenCalledOnce();
  });

  it('allows a retry after a failed redirect or a back-forward return', async () => {
    const leaving = deferred();
    const redirect = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('user_cancelled'))
      .mockImplementationOnce(() => leaving.promise)
      .mockResolvedValue();
    const r = renewal({
      flush: async () => {},
      snapshot: () => true,
      redirect,
    });
    await expect(r.start()).rejects.toThrow('user_cancelled');
    expect(r.busy).toBe(false);
    void r.start(); // leaves for Microsoft; the page is frozen
    await vi.waitFor(() => expect(redirect).toHaveBeenCalledTimes(2));
    await expect(r.start()).resolves.toBe('busy');
    r.reset(); // pageshow from the back-forward cache
    await expect(r.start()).resolves.toBe('done');
    expect(redirect).toHaveBeenCalledTimes(3);
  });

  it('does not redirect when the unsaved state cannot be kept', async () => {
    const redirect = vi.fn(async () => {});
    const r = renewal({
      flush: async () => {},
      snapshot: () => false,
      redirect,
    });
    await expect(r.start()).resolves.toBe('unsaved');
    expect(redirect).not.toHaveBeenCalled();
    expect(r.busy).toBe(false);
  });

  it('bounds the flush', async () => {
    const redirect = vi.fn(async () => {});
    const r = renewal({
      flush: () => new Promise(() => {}),
      snapshot: () => true,
      redirect,
      flushMs: 10,
    });
    await expect(r.start()).resolves.toBe('done');
    expect(redirect).toHaveBeenCalledOnce();
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

describe('round 2 regressions', () => {
  const stashed = (s: ReturnType<typeof memoryStore>, drafts: DraftStash[]) =>
    saveResume(s, { ...place, drafts, savedAt: NOW });
  const unsavedOf = (d: DraftSession): DraftStash => ({
    projectId: d.projectId,
    businessDate: d.businessDate,
    version: d.version,
    facts: d.facts,
  });
  const session = (
    businessDate: string,
    version: number,
    write: (c: SaveFactsCommand) => Promise<{ version: number }> = () =>
      new Promise(() => {}),
  ) =>
    new DraftSession(
      'p2',
      businessDate,
      version,
      facts({}),
      write as never,
      () => {},
    );

  it('a day read that lands after the renewal snapshot keeps the other unsaved day', async () => {
    const s = memoryStore();
    const A = draft('2026-09-28', '12'); // stashed; its day is still loading
    stashed(s, [A]);
    const keeper = new ResumeKeeper(s, NOW);
    keeper.opened();
    // Day B has unsaved text (its write cannot land without a token).
    const b = session('2026-09-29', 7);
    b.edit(facts({ b: 'five' }));
    // Renewal: snapshot of B plus the pending A, then the redirect starts.
    expect(keeper.save(place, [unsavedOf(b)], NOW + 1000)).toBe(true);
    // A's day read arrives now: the server already has A's facts.
    const a = session('2026-09-28', 0);
    a.reset(5, A.facts);
    const conflict = vi.fn();
    reconcileDraft(keeper, a, conflict, () => {});
    expect(conflict).not.toHaveBeenCalled();
    // Return from Microsoft: B is still there; A (saved) is not.
    const back = new ResumeKeeper(s, NOW + 60_000);
    expect(back.state?.drafts).toEqual([unsavedOf(b)]);
    expect(back.state?.view).toBe('field');
  });

  it('a re-applied draft stays stored until its write is acknowledged', async () => {
    const s = memoryStore();
    const A = draft('2026-09-28', '12');
    stashed(s, [A]);
    const keeper = new ResumeKeeper(s, NOW);
    keeper.opened();
    let ack: (v: { version: number }) => void = () => {};
    const a = session(
      '2026-09-28',
      0,
      () => new Promise((resolve) => (ack = resolve)),
    );
    a.reset(4, facts({ a: '1' })); // server unchanged since A was typed
    reconcileDraft(
      keeper,
      a,
      () => {},
      () => {},
    );
    expect(a.facts).toEqual(A.facts);
    expect(keeper.draft('p2', '2026-09-28')).toBeNull(); // not offered again
    expect(readResume(s, NOW)?.drafts).toEqual([A]); // still kept
    ack({ version: 5 });
    await vi.waitFor(() => expect(s.data.size).toBe(0));
  });

  it('fresh edits stay recoverable when the old stash is past the age limit', () => {
    const s = memoryStore();
    stashed(s, [draft('2026-09-28')]);
    const keeper = new ResumeKeeper(s, NOW);
    keeper.opened();
    const later = NOW + RESUME_LIMITS.maxAgeMs + 1;
    const fresh = draft('2026-09-29', '13');
    expect(keeper.save(place, [fresh], later)).toBe(true);
    expect(readResume(s, later + 1)?.drafts).toEqual([fresh]);
  });

  it('the size limit counts UTF-8 bytes, not characters', () => {
    const text = '混'.repeat(200_000); // 200 000 characters, 600 000 bytes
    const big = {
      ...draft('2026-09-29'),
      facts: { ...facts({}), weather: text },
    };
    const s = memoryStore();
    expect(saveResume(s, { ...place, drafts: [big], savedAt: NOW })).toBe(
      false,
    );
    const raw = JSON.stringify({ ...place, drafts: [big], savedAt: NOW });
    const t = memoryStore({ 'mje-resume': raw });
    expect(readResume(t, NOW)).toBeNull();
    const fits = {
      ...big,
      facts: { ...facts({}), weather: '混'.repeat(1000) },
    };
    expect(saveResume(s, { ...place, drafts: [fits], savedAt: NOW })).toBe(
      true,
    );
  });
});
