import { describe, expect, it } from 'vitest';
import {
  parseBusinessEvidenceCommand,
  parseEvidenceCoverage,
} from './business-evidence.js';

// All identifiers and quantities below are synthetic TEST data.
const uuid = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-06',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST-install',
};
const coverage = {
  scopeRef: uuid(4),
  withinScopeRef: uuid(4),
  qty: '10.000001',
  unit: 'TEST-m',
};
const bind = () => ({
  schemaVersion: 1,
  clientMutationId: uuid(5),
  target,
  expectedRevision: 2,
  expectedBasis: { linkSetId: uuid(6), version: 3 },
  operation: 'BIND',
  photo: { photoId: uuid(7), photoVersion: 4 },
  coverage,
});

describe('C05 strict business evidence boundary', () => {
  it('pins the complete C04 target, source revision and distinct association basis', () => {
    expect(parseBusinessEvidenceCommand(bind())).toEqual(bind());
  });
  it('accepts an explicit absent set and incomplete coverage without inventing zero', () => {
    const raw = {
      ...bind(),
      expectedBasis: null,
      coverage: { scopeRef: null, withinScopeRef: null, qty: null, unit: null },
    };
    expect(parseBusinessEvidenceCommand(raw)).toEqual(raw);
    expect(parseEvidenceCoverage({ ...coverage, qty: '0' }).qty).toBe('0');
  });
  it('unbinds one link without accepting quantity or photo replacement', () => {
    const raw = {
      schemaVersion: 1,
      clientMutationId: uuid(5),
      target,
      expectedRevision: 2,
      expectedBasis: { linkSetId: uuid(6), version: 3 },
      operation: 'UNBIND',
      linkId: uuid(8),
    };
    expect(parseBusinessEvidenceCommand(raw)).toEqual(raw);
    expect(() => parseBusinessEvidenceCommand({ ...raw, coverage })).toThrow();
  });
  it.each([
    'orgId',
    'role',
    'verified',
    'reviewDecision',
    'qty',
    'mediaVersion',
    'evidenceBasisRef',
  ])('rejects client-supplied %s', (key) => {
    expect(() =>
      parseBusinessEvidenceCommand({ ...bind(), [key]: 'TEST' }),
    ).toThrow();
  });
  it.each([
    { schemaVersion: 2 },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedBasis: { linkSetId: uuid(6), version: 0 } },
    { expectedBasis: { linkSetId: uuid(6), version: 3, linkVersion: 3 } },
    { photo: { photoId: uuid(7), photoVersion: 0 } },
    { photo: { photoId: uuid(7), photoVersion: 4, label: 'TEST' } },
    { target: { ...target, businessDate: '2026-02-30' } },
    { target: { ...target, foremanRevisionId: 'unknown' } },
    { target: { ...target, itemKey: '' } },
    { linkId: uuid(8) },
    { expectedBasis: undefined },
  ])('rejects malformed or cross-operation payload %#', (delta) => {
    expect(() =>
      parseBusinessEvidenceCommand({ ...bind(), ...delta }),
    ).toThrow();
  });
  it.each(['', 'unknown', 'na', '-1', '1e3', '1.1234567', 1, undefined])(
    'does not reinterpret coverage quantity %s',
    (qty) => {
      expect(() => parseEvidenceCoverage({ ...coverage, qty })).toThrow();
    },
  );
  it('uses the existing decimal input convention without floating point', () => {
    expect(parseEvidenceCoverage({ ...coverage, qty: '10,000001' }).qty).toBe(
      '10.000001',
    );
  });
});
