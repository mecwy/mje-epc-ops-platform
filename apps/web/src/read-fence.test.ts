import { describe, expect, it } from 'vitest';
import { ReadFence } from './read-fence.js';

/*
 * The shared read fence (AGENTS.md: read fences live only here), as a full matrix: two reads A
 * (started first) and B after a write × order (sequential / overlapping, A lands first /
 * overlapping, B lands first) × each response success or failure × an edit accepted after the
 * barrier (the day unlocked) or not. Checked for every case:
 * - a response is applied iff no newer-started response was applied before it;
 * - `fresh` is true iff a response started after the write was applied successfully, and a
 *   superseded response never changes it;
 * - after a barrier with an edit, a read started before it may not overwrite; one started
 *   after it may; without an edit both may.
 */

type Order =
  'sequential' | 'overlapping, A lands first' | 'overlapping, B lands first';
const ORDERS: Order[] = [
  'sequential',
  'overlapping, A lands first',
  'overlapping, B lands first',
];

describe('ReadFence: applied / superseded × order × success / failure × edit after the barrier', () => {
  for (const order of ORDERS)
    for (const aOk of [true, false])
      for (const bOk of [true, false])
        for (const edited of [false, true])
          it(`${order} · A ${aOk ? 'ok' : 'fails'} · B ${bOk ? 'ok' : 'fails'} · ${edited ? 'edited' : 'not edited'} after the barrier`, () => {
            const f = new ReadFence();
            f.wrote();
            let generation = 0;
            const verdicts: Record<string, string> = {};
            let barrier: number | null = null;
            let a: number;
            let b: number;
            const land = (name: 'A' | 'B', t: number, ok: boolean) => {
              const freshBefore = f.fresh;
              const v = f.settle(t, ok);
              verdicts[name] = v;
              if (v === 'superseded') expect(f.fresh).toBe(freshBefore);
              // The first applied success frees the day: the barrier, then maybe an edit.
              if (v === 'applied' && ok && barrier === null) {
                f.barrier(generation);
                barrier = t;
                if (edited) generation++;
              }
            };
            if (order === 'sequential') {
              a = f.begin();
              land('A', a, aOk);
              b = f.begin();
              land('B', b, bOk);
            } else {
              a = f.begin();
              b = f.begin();
              if (order === 'overlapping, A lands first') {
                land('A', a, aOk);
                land('B', b, bOk);
              } else {
                land('B', b, bOk);
                land('A', a, aOk);
              }
            }
            // Applied iff nothing newer was applied before it.
            expect(verdicts.B).toBe('applied');
            expect(verdicts.A).toBe(
              order === 'overlapping, B lands first' ? 'superseded' : 'applied',
            );
            // Fresh iff an applied response succeeded.
            const appliedOk = bOk || (aOk && verdicts.A === 'applied');
            expect(f.fresh).toBe(appliedOk);
            // The barrier: reads started before it may not overwrite an edit made after it.
            if (barrier !== null) {
              const before = f.mayOverwrite(a, generation);
              const later = f.begin();
              expect(f.mayOverwrite(later, generation)).toBe(true);
              if (edited) expect(before).toBe(false);
              else expect(before).toBe(true);
              // B: after the barrier only when the reads were sequential and A set it.
              expect(f.mayOverwrite(b, generation)).toBe(
                order === 'sequential' && barrier === a ? true : !edited,
              );
            }
          });

  it('supersedeAll fences every read in flight; later reads apply', () => {
    const f = new ReadFence();
    const a = f.begin();
    f.supersedeAll();
    expect(f.settle(a, true)).toBe('superseded');
    expect(f.fresh).toBe(false);
    const b = f.begin();
    expect(f.settle(b, true)).toBe('applied');
    expect(f.fresh).toBe(true);
  });

  it('a read started before a write is never fresh for it', () => {
    const f = new ReadFence();
    const a = f.begin();
    f.wrote();
    expect(f.settle(a, true)).toBe('applied');
    expect(f.fresh).toBe(false);
    expect(f.settle(f.begin(), true)).toBe('applied');
    expect(f.fresh).toBe(true);
  });
  it('an applied response the local state refused supersedes older ones but is never fresh', () => {
    const f = new ReadFence();
    f.wrote();
    const a = f.begin();
    const b = f.begin();
    // B lands first; its data was refused (unsaved edits, say): applied, not landed.
    expect(f.settle(b, true, false)).toBe('applied');
    expect(f.fresh).toBe(false);
    // The older A can no longer be applied, so nothing has made the fence fresh.
    expect(f.settle(a, true)).toBe('superseded');
    expect(f.fresh).toBe(false);
    // Only a later read whose data is taken does.
    expect(f.settle(f.begin(), true, true)).toBe('applied');
    expect(f.fresh).toBe(true);
  });
  // #42 round 1 (P1): successive barriers. Two or three lock/release cycles; after each
  // barrier an edit is accepted or not; reads outstanding from every epoch (started before
  // barrier 1, between barriers, after the last). A read may overwrite at the end iff no
  // barrier it started before was followed by an accepted edit.
  for (const cycles of [2, 3])
    for (let mask = 0; mask < 1 << cycles; mask++) {
      const edits = [...Array(cycles).keys()].map((i) => (mask >> i) & 1);
      it(`${cycles} barriers · edited after each: ${edits.join('')}`, () => {
        const f = new ReadFence();
        let generation = 0;
        const reads: number[] = [];
        const barriers: { ticket: number; generation: number }[] = [];
        for (let i = 0; i < cycles; i++) {
          reads.push(f.begin()); // outstanding from the epoch before barrier i
          f.barrier(generation);
          barriers.push({ ticket: reads[reads.length - 1]!, generation });
          if (edits[i]) generation++;
        }
        reads.push(f.begin()); // after the last barrier
        for (const t of reads) {
          const barred = barriers.some(
            (b) => t <= b.ticket && generation !== b.generation,
          );
          expect(f.mayOverwrite(t, generation), `read ${t}`).toBe(!barred);
        }
      });
    }
});
