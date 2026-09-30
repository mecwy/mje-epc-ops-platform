import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { DayRecovery } from '../report/DayRecovery.js';
import type { DayEntry } from '../report/day-store.js';
import { dayServer, open, view, workspace } from './pm-day.fixture.js';

/*
 * #40 round 4 (the two P2s left on the read-fence recovery path), on the real DayStore,
 * DraftSession, AdoptFlow and pmDayBinding wired as App.tsx wires them. Assertions are
 * behaviour: what typing is accepted, what reaches the server, what the page says.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const shown = { basis: view('10').basis, value: '10' };
const recovery = (e: DayEntry, reloadLocked = async () => true) =>
  renderToString(
    createElement(
      I18nProvider,
      null,
      createElement(DayRecovery, {
        h: { stale: e.stale, staleOutcome: e.staleOutcome, reloadLocked },
      }) as ReactNode,
    ),
  );

type Order = 'replacement read first' | 'navigation read first';
describe('round 4 finding 1: a conflicted day stays locked until its replacement facts are in the editable session', () => {
  for (const order of [
    'replacement read first',
    'navigation read first',
  ] as Order[])
    for (const aOk of [true, false])
      for (const bOk of [true, false])
        it(`pre-save conflict; replacement read A ${aOk ? 'ok' : 'fails'}, navigation read B ${bOk ? 'ok' : 'fails'}; ${order}`, async () => {
          const sv = dayServer();
          const w = workspace(sv);
          await w.load();
          // Another writer moves the day on (1 → 2); the PM types 5, then "Use 10".
          sv.otherSave();
          expect(w.type('5')).toBe(true);
          sv.read.hold = true;
          const use = w.flow().adopt('support', shown);
          await tick();
          await tick();
          // Leaving the day and coming back: useDay's ordinary read (B), started after A.
          const nav = w.load();
          await tick();
          const answer = async (which: 'A' | 'B') => {
            if (!(which === 'A' ? aOk : bOk))
              sv.readPlan.push(new ApiError('NETWORK', 0));
            if (which === 'A') sv.answerOldestRead();
            else sv.answerNewestRead();
            await tick();
            await tick();
          };
          if (order === 'replacement read first') {
            await answer('A');
            await answer('B');
          } else {
            await answer('B');
            await answer('A');
          }
          sv.read.hold = false;
          open(sv.read);
          expect((await use).kind).toBe('failed');
          await nav;
          expect(sv.adoptLog).toEqual([]);
          const e = w.entry();
          // Never free on facts the editable session did not take.
          if (e.lock === null) {
            expect(e.session.version).toBe(sv.version());
            expect(e.stale).toBe(false);
          } else expect(e.stale).toBe(true);
          // 8 typed now: if accepted, it reaches the server (no conflict drops it).
          const conflicts = w.conflicts();
          const accepted = w.type('8');
          await w.autosave();
          if (accepted) {
            expect(sv.facts().people.workers).toBe('8');
            expect(w.conflicts()).toBe(conflicts);
          } else {
            // Locked with Refresh; Refresh reads the replacement in, then typing is saved.
            expect(recovery(e)).toMatch(/>Refresh</);
            await w.store.reloadLocked(e);
            expect(w.type('8')).toBe(true);
            await w.autosave();
            expect(sv.facts().people.workers).toBe('8');
          }
        });
});

describe('round 4 finding 2: a refusal after a lost attempt keeps the recovery wording uncertain', () => {
  it('adoption committed (10) but its answer lost; Retry refused READ_ONLY; the read after fails → "not known"', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    sv.adoptPlan.push('lost');
    const flow = w.flow();
    expect((await flow.adopt('support', shown)).kind).toBe('failed');
    expect(sv.facts().qty.support).toBe('10');
    sv.adoptPlan.push(new ApiError('READ_ONLY', 403));
    sv.readPlan.push(new ApiError('NETWORK', 0));
    const r = await flow.retry();
    expect(r.kind === 'rejected' && r.uncertain).toBe(true);
    const e = w.entry();
    expect(e.stale).toBe(true);
    const html = recovery(e);
    expect(html).toMatch(/It is not known whether the change was saved/);
    expect(html).not.toMatch(/refused and not saved/);
  });

  for (const [afterLostAttempt, says] of [
    [true, /It is not known whether the change was saved/],
    [false, /The change was refused and not saved/],
  ] as const)
    it(`a day command refused READ_ONLY ${afterLostAttempt ? 'after a transport resend' : 'at once (control)'}; the read after fails`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      sv.commandPlan.push(new ApiError('READ_ONLY', 403, afterLostAttempt));
      sv.readPlan.push(new ApiError('NETWORK', 0));
      await expect(w.noWork()).rejects.toThrow('READ_ONLY');
      const html = recovery(w.entry());
      expect(html).toMatch(says);
      if (afterLostAttempt) expect(html).not.toMatch(/refused and not saved/);
    });
});

describe('#42 round 1 (P1): a second release never re-authorizes an older replacement read', () => {
  for (const path of ['a second adoption', 'a day command'] as const)
    it(`Refresh twice, A frees the day, 7 typed, ${path} fails its pre-save (NETWORK), then B lands`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      // 1. Adopt; the read after it fails (the day stays locked).
      sv.readPlan.push(new ApiError('NETWORK', 0));
      expect((await w.flow().adopt('support', shown)).kind).toBe('ok');
      const e = w.entry();
      expect(e.stale).toBe(true);
      // 2. Refresh twice: replacement reads A and B, both held.
      sv.read.hold = true;
      const a = w.store.reloadLocked(e);
      const b = w.store.reloadLocked(e);
      await tick();
      // 3. A answers first: the day is free; B stays in flight.
      sv.answerOldestRead();
      await a;
      await tick();
      expect(e.lock).toBeNull();
      // 4. 7 typed, then the second command before autosave.
      expect(w.type('7')).toBe(true);
      // 5. Its pre-save fails (NETWORK): nothing is sent, the lock is abandoned.
      sv.savePlan.push(new ApiError('NETWORK', 0));
      if (path === 'a second adoption')
        expect((await w.flow().adopt('support', shown)).kind).toBe('failed');
      else await expect(w.noWork()).rejects.toThrow();
      expect(sv.adoptLog).toHaveLength(1);
      expect(sv.commands).toEqual([]);
      expect(e.lock).toBeNull();
      // 6. B lands: it started before the first barrier, so it may not erase the 7.
      sv.read.hold = false;
      open(sv.read);
      await b;
      await tick();
      expect(e.session.facts.people.workers).toBe('7');
      await w.autosave();
      expect(sv.facts().people.workers).toBe('7');
      expect(sv.facts().qty.support).toBe('10');
    });
});
