import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  parseCreateCrewCommand,
  parseEntryCommand,
  parseRosterChangesCommand,
} from './index.js';

const code = 'abcdefghij_-KLMNOPQRST';
const id = '4f7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f70';

describe('entry code', () => {
  it('entry takes a 128-bit code and nothing shorter', () => {
    expect(parseEntryCommand({ code })).toEqual({ code });
    expect(() => parseEntryCommand({ code: code.slice(1) })).toThrow(
      InvalidReportInput,
    );
    expect(() => parseEntryCommand({ code: `${code}x` })).toThrow(
      InvalidReportInput,
    );
  });
});

describe('roster commands', () => {
  const base = {
    projectId: id,
    clientMutationId: id,
    expectedRosterVersion: 0,
  };
  it('crew code and name are bounded', () => {
    expect(
      parseCreateCrewCommand({ ...base, code: 'C-1', name: ' A ' }).name,
    ).toBe('A');
    expect(() =>
      parseCreateCrewCommand({ ...base, code: '-x', name: 'A' }),
    ).toThrow(InvalidReportInput);
  });
  it('changes are opens and closes; times are instants or now', () => {
    const cmd = parseRosterChangesCommand({
      ...base,
      changes: [
        { op: 'close', assignmentId: id, at: '2026-10-05T12:00:00Z' },
        { op: 'open', crewId: id, personId: id, role: 'MEMBER', from: null },
      ],
    });
    expect(cmd.changes).toEqual([
      { op: 'close', assignmentId: id, at: '2026-10-05T12:00:00Z' },
      { op: 'open', crewId: id, personId: id, role: 'MEMBER', from: null },
    ]);
    for (const changes of [
      [],
      [{ op: 'open', crewId: id, personId: id, role: 'BOSS' }],
      [{ op: 'close', assignmentId: id, at: '2026-02-30T00:00:00Z' }],
      [
        { op: 'close', assignmentId: id },
        { op: 'close', assignmentId: id },
      ],
    ])
      expect(() => parseRosterChangesCommand({ ...base, changes })).toThrow(
        InvalidReportInput,
      );
  });
});
