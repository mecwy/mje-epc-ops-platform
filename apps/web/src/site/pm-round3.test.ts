import { createElement, type FunctionComponent, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { dayServer, open, view, workspace } from './pm-day.fixture.js';

/*
 * #40 Codex round 3 (focused round 4: the read fence). The real DayStore (useDay's logic),
 * DraftSession, AdoptFlow and pmDayBinding, wired as App.tsx wires them; the fence itself is
 * the shared ReadFence (its matrix is read-fence.test.ts). Assertions are behaviour: what
 * typing is accepted, what reaches the server, what the page says.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const shown = { basis: view('10').basis, value: '10' };
const wrap = (el: ReactNode) =>
  renderToString(createElement(I18nProvider, null, el));

describe('#40 round 3 finding 1 (P1): overlapping Refreshes never unlock stale state or erase an edit', () => {
  for (const order of ['first answers first', 'second answers first'] as const)
    it(`adopted, its read failed; Refresh twice with delayed answers (${order}); 7 typed in between`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      sv.readPlan.push(new ApiError('NETWORK', 0));
      expect((await w.flow().adopt('support', shown)).kind).toBe('ok');
      const e = w.entry();
      sv.read.hold = true;
      const r1 = w.store.reloadLocked(e);
      const r2 = w.store.reloadLocked(e);
      await tick();
      if (order === 'first answers first') {
        sv.answerOldestRead();
        await r1;
      } else {
        sv.answerNewestRead();
        await r2;
      }
      await tick();
      const accepted = w.type('7');
      sv.read.hold = false;
      open(sv.read);
      await Promise.all([r1, r2]);
      await tick();
      await w.autosave();
      // Never lost silently: an accepted 7 reaches the server, with no conflict.
      if (accepted) expect(sv.facts().people.workers).toBe('7');
      expect(w.conflicts()).toBe(0);
      // And the day is editable on fresh facts once a read started after the write applied.
      if (!accepted) {
        expect(w.type('7')).toBe(true);
        await w.autosave();
        expect(sv.facts().people.workers).toBe('7');
      }
      expect(sv.facts().qty.support).toBe('10');
    });
});

describe('#40 round 3 finding 2: pre-save conflict recovery keeps the day locked until its read applies', () => {
  for (const read of ['delayed', 'fails, then Refresh'] as const)
    it(`typed 5, another person saved, "Use 10" → the pre-save conflicts; recovery read ${read}; 8 typed meanwhile`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      sv.otherSave();
      expect(w.type('5')).toBe(true);
      if (read === 'delayed') sv.read.hold = true;
      else sv.readPlan.push(new ApiError('NETWORK', 0));
      const use = w.flow().adopt('support', shown);
      await tick();
      await tick();
      const accepted = w.type('8');
      if (read === 'delayed') {
        sv.read.hold = false;
        open(sv.read);
      }
      expect((await use).kind).toBe('failed');
      expect(sv.adoptLog).toEqual([]);
      if (read === 'fails, then Refresh') {
        // Still locked (typing refused) until a read is applied.
        const during = w.type('9');
        if (during) {
          await w.autosave();
          expect(sv.facts().people.workers).toBe('9');
        }
        expect(during).toBe(false);
        await w.store.reloadLocked(w.entry());
      }
      await w.autosave();
      if (accepted) expect(sv.facts().people.workers).toBe('8');
      expect(accepted).toBe(false);
      // Free on the fresh read: typing works and is saved.
      expect(w.type('8')).toBe(true);
      await w.autosave();
      expect(sv.facts().people.workers).toBe('8');
    });
});

type Recovery = FunctionComponent<{ h: object }>;
/**
 * The locked-day recovery as the page renders it. Where report/DayRecovery exists it is used
 * in every view. At e0eb445 it did not: App.tsx rendered, only on the main (non-task) path,
 * `{h.stale && <div className="banner warn">{t('dayRereadFailed')} <button>Refresh</button>}`,
 * and nothing on the Fill / Check task views (their early return); that is rendered instead.
 */
async function recovery() {
  const mod = (await import('../report/DayRecovery.js').catch(() => null)) as {
    DayRecovery?: Recovery;
  } | null;
  if (mod?.DayRecovery) return { main: mod.DayRecovery, task: mod.DayRecovery };
  const { useI18n } = await import('../i18n.js');
  const Old: Recovery = ({ h }) => {
    const { t } = useI18n();
    return (h as { stale: boolean }).stale
      ? createElement(
          'div',
          { className: 'banner warn' },
          t('dayRereadFailed'),
          ' ',
          createElement('button', { type: 'button' }, t('pm_reload')),
        )
      : null;
  };
  return { main: Old, task: (() => null) as Recovery };
}

/** A day whose command answered `answer` and whose post-command read failed. */
async function lockedAfter(answer: 'ok' | 'refused' | 'lost') {
  const sv = dayServer();
  const w = workspace(sv);
  await w.load();
  if (answer === 'refused') sv.commandPlan.push(new ApiError('READ_ONLY', 403));
  if (answer === 'lost') sv.commandPlan.push('lost');
  sv.readPlan.push(new ApiError('NETWORK', 0));
  await w.noWork().catch(() => {});
  const e = w.entry();
  const h = {
    stale: e.stale,
    staleOutcome: (e as { staleOutcome?: string }).staleOutcome,
    reloadLocked: () => w.store.reloadLocked(e),
  };
  return { sv, w, h };
}

describe("#40 round 3 finding 3: Fill and Check show the locked day's recovery with Refresh", () => {
  it('a task view (Fill / Check) of a day locked after a failed reread shows why and Refresh', async () => {
    const { w, h } = await lockedAfter('ok');
    const R = await recovery();
    const html = wrap(createElement(R.task, { h }));
    expect(html).toMatch(/could not be read again/);
    expect(html).toMatch(/>Refresh</);
    // Refresh frees it once a read lands.
    await h.reloadLocked();
    expect(w.type('7')).toBe(true);
  });
});

describe('#40 round 3 finding 4: the wording follows what the command did', () => {
  for (const [answer, says] of [
    ['ok', /The change was saved, but the day could not be read again/],
    ['refused', /The change was refused and not saved/],
    ['lost', /It is not known whether the change was saved/],
  ] as const)
    it(`no-work ${answer}, then its read fails → "${says.source.slice(0, 30)}…"`, async () => {
      const { h } = await lockedAfter(answer);
      const R = await recovery();
      const html = wrap(createElement(R.main, { h }));
      expect(html).toMatch(says);
      if (answer !== 'ok') expect(html).not.toMatch(/The change was saved/);
    });
});
