import { describe, expect, it } from 'vitest';
import type { ForemanAdoptCommand, ForemanBasisDto } from '@mje/contracts';
import { ApiError, type ForemanDayView } from '../api.js';
import { AdoptFlow, adoptBlock, itemView, sameBasis } from './foreman-adopt.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const basis = (n: number | null, roster = 3): ForemanBasisDto => ({
  rosterVersion: roster,
  expectedCrews: ['cB', 'cA'],
  revisions: [
    { crewId: 'cA', n: 1 },
    { crewId: 'cB', n },
  ],
});
const view = (
  status: 'COMPLETE' | 'PARTIAL' | 'ALL_NA' | 'OVERFLOW',
  value: string | null,
  b = basis(1),
): ForemanDayView => ({
  rosterVersion: b.rosterVersion,
  expectedCrews: [
    { crewId: 'cA', code: 'A', name: 'TEST A', hasForeman: true },
    { crewId: 'cB', code: 'B', name: 'TEST B', hasForeman: false },
  ],
  revisions: [],
  items: {
    support: {
      status,
      value,
      atLeast: status === 'PARTIAL' ? '10' : null,
      crews: {
        cA: { status: 'VALUE', qty: '10', expected: true },
        cB:
          status === 'COMPLETE'
            ? { status: 'ZERO', qty: '0', expected: true }
            : { status: 'MISSING_REPORT', qty: null, expected: true },
      },
    },
  },
  adoptions: [],
  basis: b,
  expectedCrewsChanged: null,
});

describe('foreman totals beside the PM figure', () => {
  it('shows each expected crew, a crew without a foreman as missing, and completeness', () => {
    const v = itemView(view('PARTIAL', null), 'support')!;
    expect(v.status).toBe('PARTIAL');
    expect(v.atLeast).toBe('10');
    expect(v.crews.map((c) => [c.name, c.status, c.hasForeman])).toEqual([
      ['TEST A', 'VALUE', true],
      ['TEST B', 'MISSING_REPORT', false],
    ]);
    expect(itemView(view('PARTIAL', null), 'other')).toBeNull();
  });
  it('adoption is explicit and refused unless complete, by a writer, on an open day', () => {
    const ok = itemView(view('COMPLETE', '10'), 'support')!;
    expect(adoptBlock(ok, { canWrite: true, dayState: 'draft' })).toBeNull();
    expect(
      adoptBlock(ok, { canWrite: true, dayState: 'correcting' }),
    ).toBeNull();
    expect(adoptBlock(ok, { canWrite: true, dayState: 'submitted' })).toBe(
      'locked',
    );
    expect(adoptBlock(ok, { canWrite: false, dayState: 'draft' })).toBe(
      'readOnly',
    );
    for (const s of ['PARTIAL', 'ALL_NA', 'OVERFLOW'] as const)
      expect(
        adoptBlock(itemView(view(s, null), 'support')!, {
          canWrite: true,
          dayState: 'draft',
        }),
      ).toBe('notComplete');
    // An explicit 0 from every crew is a complete total and can be used.
    const zero = itemView(view('COMPLETE', '0'), 'support')!;
    expect(adoptBlock(zero, { canWrite: true, dayState: 'draft' })).toBeNull();
  });
  it('compares bases by roster version, crews and revisions, in any order', () => {
    expect(
      sameBasis(basis(1), { ...basis(1), expectedCrews: ['cA', 'cB'] }),
    ).toBe(true);
    expect(sameBasis(basis(1), basis(2))).toBe(false);
    expect(sameBasis(basis(1), basis(1, 4))).toBe(false);
    expect(sameBasis(basis(null), basis(1))).toBe(false);
  });
});

function harness(initial: ForemanDayView) {
  let day = { foreman: initial as ForemanDayView | null, version: 5 };
  const sent: { c: ForemanAdoptCommand; settle: (e?: Error) => void }[] = [];
  let reloads = 0;
  let flushOutcome = 'ok';
  let n = 0;
  const flow = new AdoptFlow(
    {
      api: {
        adoptForeman: (c) =>
          new Promise((resolve, reject) =>
            sent.push({ c, settle: (e) => (e ? reject(e) : resolve({})) }),
          ),
      },
      projectId: 'p',
      businessDate: '2026-10-02',
      hold: async () => flushOutcome,
      current: () => day,
      release: async () => {
        reloads++;
      },
    },
    () => {},
    () => `k${++n}`,
  );
  return {
    flow,
    sent,
    reloads: () => reloads,
    setDay: (f: ForemanDayView, v = 5) => (day = { foreman: f, version: v }),
    setFlush: (o: string) => (flushOutcome = o),
  };
}

describe('the PM adopts exactly the total seen (AdoptFlow)', () => {
  it('sends the basis and total shown, with the day version after saving typed facts', async () => {
    const h = harness(view('COMPLETE', '10'));
    const r = h.flow.adopt('support', { basis: basis(1), value: '10' });
    await tick();
    expect(h.sent[0]!.c).toEqual({
      projectId: 'p',
      businessDate: '2026-10-02',
      clientMutationId: 'k1',
      item: 'support',
      expectedVersion: 5,
      basis: basis(1),
    });
    h.sent[0]!.settle();
    expect((await r).kind).toBe('ok');
    expect(h.reloads()).toBe(1);
  });
  it('a total that changed before sending is shown as changed and nothing is sent', async () => {
    const h = harness(view('COMPLETE', '10'));
    h.setDay(view('COMPLETE', '12', basis(2)));
    expect(
      await h.flow.adopt('support', { basis: basis(1), value: '10' }),
    ).toEqual({
      kind: 'changed',
    });
    expect(h.sent).toHaveLength(0);
    expect(h.flow.changed['support']).toBe('10');
    // Adopting the new total, seen, clears the notice and sends.
    const r = h.flow.adopt('support', { basis: basis(2), value: '12' });
    await tick();
    expect(h.flow.changed['support']).toBeUndefined();
    h.sent[0]!.settle();
    expect((await r).kind).toBe('ok');
  });
  it('FOREMAN_TOTAL_CHANGED: nothing adopted, the day is reread and the new total shown beside the one seen', async () => {
    const h = harness(view('COMPLETE', '10'));
    const r = h.flow.adopt('support', { basis: basis(1), value: '10' });
    await tick();
    h.sent[0]!.settle(new ApiError('FOREMAN_TOTAL_CHANGED', 409));
    expect(await r).toMatchObject({
      kind: 'rejected',
      code: 'FOREMAN_TOTAL_CHANGED',
    });
    expect(h.reloads()).toBe(1);
    expect(h.flow.changed['support']).toBe('10');
    // No automatic resend: the next adoption is a new, explicit one.
    expect(h.sent).toHaveLength(1);
  });
  it('a lost answer is resent unchanged (same key); nothing else starts meanwhile', async () => {
    const h = harness(view('COMPLETE', '10'));
    const r = h.flow.adopt('support', { basis: basis(1), value: '10' });
    await tick();
    h.sent[0]!.settle(new ApiError('NETWORK', 0));
    expect((await r).kind).toBe('failed');
    expect(h.flow.owned.unresolved).toMatchObject({
      item: 'support',
      value: '10',
    });
    expect(
      (await h.flow.adopt('support', { basis: basis(1), value: '10' })).kind,
    ).toBe('failed');
    expect(h.sent).toHaveLength(1);
    const again = h.flow.retry();
    await tick();
    // Same key = byte-identical body (#39 round 1 finding 2).
    expect(JSON.stringify(h.sent[1]!.c)).toBe(JSON.stringify(h.sent[0]!.c));
    h.sent[1]!.settle();
    expect((await again).kind).toBe('ok');
  });
  it('typed facts that cannot be saved stop the adoption', async () => {
    const h = harness(view('COMPLETE', '10'));
    h.setFlush('conflict');
    expect(
      (await h.flow.adopt('support', { basis: basis(1), value: '10' })).kind,
    ).toBe('failed');
    expect(h.sent).toHaveLength(0);
  });
});
