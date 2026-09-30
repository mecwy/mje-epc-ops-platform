import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api.js';
import { ActionAborted } from '../report/day-store.js';
import { P, Q, dayServer, open, view, workspace } from './pm-day.fixture.js';

/*
 * #40 Codex round 2 (L5): one mutation lock per day, with an owner token, released only after
 * a successful post-write read; acquisition central and exception safe. Everything runs on the
 * real DayStore (useDay's logic), DraftSession, PmOwners / AdoptFlow and the workspace's real
 * binding (pmDayBinding, made once per project as App.tsx does). Assertions are behaviour: what
 * typing is accepted, what reaches the server, what is sent.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const shown = { basis: view('10').basis, value: '10' };
afterEach(() => vi.restoreAllMocks());

/** Never lost silently: an accepted typed value reaches the server once autosave runs. */
async function acceptedIsSaved(
  w: ReturnType<typeof workspace>,
  sv: ReturnType<typeof dayServer>,
  accepted: boolean,
  value: string,
  p = P,
) {
  await w.autosave(p);
  if (accepted) expect(sv.facts(p).people.workers).toBe(value);
}

describe('#40 round 2 finding 1 (P1): the lock is released only after a post-write read lands', () => {
  for (const reads of [1, 2] as const)
    it(`adopted; the read after it fails ${reads}× → the day stays locked until a Reload lands`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      const flow = w.flow();
      for (let i = 0; i < reads; i++)
        sv.readPlan.push(new ApiError('NETWORK', 0));
      expect((await flow.adopt('support', shown)).kind).toBe('ok');
      // Local facts and version are stale now: typing must wait.
      const accepted = w.type('7');
      await acceptedIsSaved(w, sv, accepted, '7');
      expect(w.conflicts()).toBe(0);
      expect(accepted).toBe(false);
      // Reload (the banner's button) until a read lands; then typing is on fresh facts.
      for (let i = 0; i < 3 && !w.type('7'); i++)
        await (
          w.store as { reloadLocked?: (e: unknown) => Promise<unknown> }
        ).reloadLocked?.(w.entry());
      await w.autosave();
      expect(sv.facts().people.workers).toBe('7');
      expect(sv.facts().qty.support).toBe('10');
      expect(w.conflicts()).toBe(0);
    });
});

describe("#40 round 2 finding 2: the adoption sends the version of the held session's own save", () => {
  it('typed 5 before "Use 10" → saved (version 1 → 2) → the adoption expects 2 and succeeds', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    expect(w.type('5')).toBe(true);
    const r = await w.flow().adopt('support', shown);
    expect(sv.adoptLog.map((c) => c.expectedVersion)).toEqual([2]);
    expect(r.kind).toBe('ok');
    expect(sv.facts().people.workers).toBe('5');
    expect(sv.facts().qty.support).toBe('10');
    expect(w.conflicts()).toBe(0);
  });
});

describe('#40 round 2 finding 3: one day command at a time (central acquisition)', () => {
  for (const other of ['noWork', 'submit'] as const)
    it(`an adoption unresolved; ${other} is refused BUSY and nothing is sent; the adoption keeps the day`, async () => {
      const sv = dayServer();
      const w = workspace(sv);
      await w.load();
      const flow = w.flow();
      // No answer (lost before the server decided): unresolved, the day stays held.
      sv.adoptPlan.push(new ApiError('NETWORK', 0));
      expect((await flow.adopt('support', shown)).kind).toBe('failed');
      const tried = await w[other]().then(
        () => 'sent',
        (e: unknown) => (e instanceof ActionAborted ? e.outcome : String(e)),
      );
      expect(sv.commands).toEqual([]);
      expect(tried).toBe('busy');
      // The adoption still holds the day: typing is still refused, its Retry still works.
      const accepted = w.type('7');
      await acceptedIsSaved(w, sv, accepted, '7');
      expect(accepted).toBe(false);
      expect((await flow.retry()).kind).toBe('ok');
      // Released now: the other command goes through.
      await w[other]();
      expect(sv.commands).toEqual([other]);
    });

  it('only the owner releases: another release while an adoption holds the day changes nothing', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    const flow = w.flow();
    sv.adoptPlan.push(new ApiError('NETWORK', 0));
    await flow.adopt('support', shown);
    // Another action's release (its own token) — e.g. a command that finished late.
    await (w.store.release as (e: unknown, owner?: string) => Promise<unknown>)(
      w.entry(),
      'act:another',
    );
    const accepted = w.type('7');
    await acceptedIsSaved(w, sv, accepted, '7');
    expect(accepted).toBe(false);
    expect((await flow.retry()).kind).toBe('ok');
    expect(w.type('7')).toBe(true);
  });

  it('a No work while an adoption is in flight: refused; the adoption finishes and frees the day', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    sv.adopt.hold = true;
    const use = w.flow().adopt('support', shown);
    await tick();
    const tried = await w.noWork().then(
      () => 'sent',
      (e: unknown) => (e instanceof ActionAborted ? e.outcome : String(e)),
    );
    open(sv.adopt);
    expect((await use).kind).toBe('ok');
    expect(sv.commands).toEqual([]);
    expect(tried).toBe('busy');
    expect(w.type('7')).toBe(true);
  });
});

describe('#40 round 2 finding 4: a throw anywhere in the lifecycle leaves no ownerless hold', () => {
  it('the pre-save throws (building its write key) → the day is free again, nothing owned', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    expect(w.type('5')).toBe(true);
    const flow = w.flow();
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('TEST key failure');
    });
    await expect(flow.adopt('support', shown)).rejects.toThrow(
      'TEST key failure',
    );
    await tick();
    expect(flow.active).toBeNull();
    expect(flow.canStart).toBe(true);
    // Typing works and is saved; a new adoption can start and succeeds.
    expect(w.type('6')).toBe(true);
    await w.autosave();
    expect(sv.facts().people.workers).toBe('6');
    expect((await flow.adopt('support', shown)).kind).toBe('ok');
  });

  it('building the adoption command throws (its key) → the day is read again and freed', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load();
    const flow = w.flow();
    vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new Error('TEST key failure');
    });
    await expect(flow.adopt('support', shown)).rejects.toThrow(
      'TEST key failure',
    );
    await tick();
    expect(sv.adoptLog).toEqual([]);
    expect(flow.canStart).toBe(true);
    expect(w.type('6')).toBe(true);
    await w.autosave();
    expect(sv.facts().people.workers).toBe('6');
  });
});

describe("#40 round 2 finding 5: the lock and its callbacks stay on their own project's day", () => {
  it('adoption on P in flight; the workspace renders Q; P is released on its own day, Q untouched', async () => {
    const sv = dayServer();
    const w = workspace(sv);
    await w.load(P);
    await w.load(Q);
    w.render(P);
    sv.adopt.hold = true;
    const use = w.flow(P).adopt('support', shown);
    await tick();
    w.render(Q); // the project changes (App renders Q's owners and binding)
    open(sv.adopt);
    expect((await use).kind).toBe('ok');
    await tick();
    // P was read again and freed: typing on P works and is saved on fresh facts.
    const onP = w.type('7', P);
    await acceptedIsSaved(w, sv, onP, '7', P);
    expect(onP).toBe(true);
    expect(sv.facts(P).qty.support).toBe('10');
    // Q was never locked or read over by P's settlement.
    expect(w.type('4', Q)).toBe(true);
    await w.autosave(Q);
    expect(sv.facts(Q).people.workers).toBe('4');
    expect(sv.facts(Q).qty.support).toBeUndefined();
    expect(w.conflicts()).toBe(0);
  });
});
