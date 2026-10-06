/** Synthetic TEST inputs only. No site reports, identities or photos. */
import { describe, expect, it } from 'vitest';
import { InvalidReportInput } from './parse.js';
import {
  parseCompletionEvidenceBasis,
  parseCompletionReviewTarget,
  parseReviewForemanCommand,
} from './manager-review.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-05',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST_work',
};
const basis = { linkSetId: uuid(4), version: 1 };
const command = {
  schemaVersion: 1,
  clientMutationId: uuid(5),
  target,
  expectedRevision: 1,
  expectedVersion: 0,
  decision: 'CONFIRM_SCOPE',
  coverage: { kind: 'WHOLE' },
  evidenceBasis: basis,
  reason: '',
  method: 'TEST direct observation',
  limitations: '',
};

describe('completion review boundary: references, not another quantity source', () => {
  it('keeps the exact revision/item and a separate evidence version', () => {
    expect(parseReviewForemanCommand(command)).toEqual(command);
    expect(
      parseCompletionReviewTarget({
        ...target,
        projectId: uuid(1).toUpperCase(),
      }),
    ).toEqual(target);
  });

  it('whole review contains no client quantity; partial keeps decimal precision', () => {
    const partial = parseReviewForemanCommand({
      ...command,
      coverage: { kind: 'PARTIAL', scopeRef: uuid(6), qty: '12,000001' },
    });
    expect(partial.coverage).toEqual({
      kind: 'PARTIAL',
      scopeRef: uuid(6),
      qty: '12.000001',
    });
    expect(() =>
      parseReviewForemanCommand({
        ...command,
        coverage: { kind: 'WHOLE', qty: '100' },
      }),
    ).toThrow(InvalidReportInput);
  });

  it.each([
    '',
    'unknown',
    'na',
    '-1',
    '1e2',
    'NaN',
    '1.0000001',
    '100000000000000',
    1,
  ])('refuses a non-quantity partial value: %s', (qty) => {
    expect(() =>
      parseReviewForemanCommand({
        ...command,
        coverage: { kind: 'PARTIAL', scopeRef: uuid(6), qty },
      }),
    ).toThrow(InvalidReportInput);
  });

  it('preserves an explicit partial zero instead of converting it to a blank', () => {
    expect(
      parseReviewForemanCommand({
        ...command,
        coverage: { kind: 'PARTIAL', scopeRef: uuid(6), qty: '0' },
      }).coverage,
    ).toEqual({ kind: 'PARTIAL', scopeRef: uuid(6), qty: '0' });
  });

  it.each(['RETURN', 'INCONCLUSIVE'] as const)(
    '%s allows missing evidence but requires a concrete reason and no confirmation quantity',
    (decision) => {
      const input = {
        ...command,
        decision,
        coverage: null,
        evidenceBasis: null,
        reason: ' TEST missing scope ',
        method: '',
      };
      expect(parseReviewForemanCommand(input)).toEqual({
        ...input,
        reason: 'TEST missing scope',
      });
      expect(() =>
        parseReviewForemanCommand({ ...input, reason: '  ' }),
      ).toThrow(InvalidReportInput);
      expect(() =>
        parseReviewForemanCommand({ ...input, coverage: { kind: 'WHOLE' } }),
      ).toThrow(InvalidReportInput);
    },
  );

  it('requires a real evidence set and method for confirmation', () => {
    for (const patch of [
      { evidenceBasis: null },
      { method: ' ' },
      { coverage: null },
      { evidenceBasis: { ...basis, version: 0 } },
    ])
      expect(() => parseReviewForemanCommand({ ...command, ...patch })).toThrow(
        InvalidReportInput,
      );
  });

  it.each([
    'orgId',
    'role',
    'actorPersonId',
    'canWrite',
    'authority',
    'verifiedQty',
  ])('CG-I01: rejects forged %s at root and nested boundaries', (key) => {
    for (const input of [
      { ...command, [key]: 'TEST forged' },
      { ...command, target: { ...target, [key]: 'TEST forged' } },
      { ...command, evidenceBasis: { ...basis, [key]: 'TEST forged' } },
      { ...command, coverage: { kind: 'WHOLE', [key]: 'TEST forged' } },
    ])
      expect(() => parseReviewForemanCommand(input)).toThrow(
        InvalidReportInput,
      );
  });

  it('does not echo rejected secret key names in errors', () => {
    const secretKey = 'TEST_PRIVATE_KEY_NAME';
    try {
      parseReviewForemanCommand({
        ...command,
        target: { ...target, [secretKey]: 'TEST' },
      });
      expect.fail('must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidReportInput);
      expect(String(error)).not.toContain(secretKey);
      expect((error as InvalidReportInput).field).toBe('target.extra');
    }
  });

  it.each([
    { schemaVersion: 2 },
    { schemaVersion: '1' },
    { expectedRevision: 0 },
    { expectedVersion: -1 },
    { expectedVersion: 0.1 },
    { expectedVersion: 1_000_001 },
    { decision: 'ADOPT' },
    { decision: 'ACCEPT_QUALITY' },
    { reason: 'x'.repeat(501) },
    { target: { ...target, businessDate: '2026-02-30' } },
    { target: { ...target, foremanRevisionId: 'TEST missing revision' } },
    { target: { ...target, itemKey: '1-invalid' } },
  ])('refuses malformed or unrelated commands: %j', (patch) => {
    expect(() => parseReviewForemanCommand({ ...command, ...patch })).toThrow(
      InvalidReportInput,
    );
  });

  it('schema/key fields are mandatory and missing nulls are not silently invented', () => {
    for (const key of Object.keys(command)) {
      const missing = { ...command } as Record<string, unknown>;
      delete missing[key];
      expect(() => parseReviewForemanCommand(missing)).toThrow(
        InvalidReportInput,
      );
    }
  });

  it('does not grant D2 historical correction rights through date parsing', () => {
    expect(
      parseCompletionReviewTarget({ ...target, businessDate: '2020-01-01' })
        .businessDate,
    ).toBe('2020-01-01');
    // A review reference may be historical. This parser does not implement a field write.
    expect(() =>
      parseCompletionEvidenceBasis({
        ...basis,
        returnedCorrectionAllowed: true,
      }),
    ).toThrow(InvalidReportInput);
  });

  it('does not mutate a parsed caller object or retain nested aliases', () => {
    const before = structuredClone(command);
    const parsed = parseReviewForemanCommand(command);
    parsed.target.itemKey = 'TEST_changed';
    expect(command).toEqual(before);
    expect(parsed.evidenceBasis).not.toBe(command.evidenceBasis);
  });
});
