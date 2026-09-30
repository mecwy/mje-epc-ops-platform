import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  parseForemanAdoptCommand,
  parseForemanReportCommand,
} from './index.js';

const id = '4f7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f70';
const crew = '5a7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f71';
const report = (rows: unknown, extra: Record<string, unknown> = {}) => ({
  clientMutationId: id,
  businessDate: '2026-09-30',
  crewId: crew,
  expectedRevision: 0,
  rows,
  note: 'TEST',
  occurredAt: '2026-09-30T08:00:00.000Z',
  ...extra,
});

describe('foreman report command', () => {
  it('keeps blanks, tokens and raw numbers for the server to classify', () => {
    const c = parseForemanReportCommand(
      report([
        { itemKey: 'support', qty: '12,5' },
        { itemKey: 'rail', qty: '' },
        { itemKey: 'modules', qty: 'unknown' },
        { itemKey: 'cable', qty: 'abc' },
      ]),
    );
    expect(c.rows.map((r) => r.qty)).toEqual(['12,5', '', 'unknown', 'abc']);
    expect(c.expectedRevision).toBe(0);
  });
  it('a duplicate item key is refused, never merged', () => {
    expect(() =>
      parseForemanReportCommand(
        report([
          { itemKey: 'support', qty: '1' },
          { itemKey: 'support', qty: '2' },
        ]),
      ),
    ).toThrow(InvalidReportInput);
  });
  it('refuses a non-string quantity, a bad key, a long note, a bad time or too many rows', () => {
    for (const bad of [
      report([{ itemKey: 'support', qty: 1 }]),
      report([{ itemKey: '1bad', qty: '1' }]),
      report([], { note: 'x'.repeat(501) }),
      report([], { occurredAt: '2026-09-30 08:00' }),
      report([], { crewId: 'nope' }),
      report(
        Array.from({ length: 501 }, (_, i) => ({ itemKey: `k${i}`, qty: '' })),
      ),
    ])
      expect(() => parseForemanReportCommand(bad)).toThrow(InvalidReportInput);
  });
});

describe('foreman adopt command', () => {
  const adopt = (basis: unknown) => ({
    projectId: id,
    businessDate: '2026-09-30',
    clientMutationId: id,
    item: 'support',
    expectedVersion: 3,
    basis,
  });
  it('carries the exact basis: roster version, expected crews, revisions (null = none)', () => {
    const c = parseForemanAdoptCommand(
      adopt({
        rosterVersion: 7,
        expectedCrews: [crew.toUpperCase()],
        revisions: [{ crewId: crew, n: null }],
      }),
    );
    expect(c.basis).toEqual({
      rosterVersion: 7,
      expectedCrews: [crew],
      revisions: [{ crewId: crew, n: null }],
    });
  });
  it('refuses a missing or malformed basis', () => {
    for (const basis of [
      undefined,
      { rosterVersion: 1, expectedCrews: 'x', revisions: [] },
      { rosterVersion: -1, expectedCrews: [], revisions: [] },
      { rosterVersion: 1, expectedCrews: [], revisions: [{ crewId: crew }] },
    ])
      expect(() => parseForemanAdoptCommand(adopt(basis))).toThrow(
        InvalidReportInput,
      );
  });
});
