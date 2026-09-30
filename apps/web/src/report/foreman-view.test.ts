import { describe, expect, it } from 'vitest';
import type { ForemanBasisDto } from '@mje/contracts';
import type { ForemanDayView } from '../api.js';
import { itemView } from './foreman-view.js';

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
});
