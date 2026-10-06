import { describe, it, expect } from 'vitest';
import {
  parseBusinessEvidenceQuery,
  parseBusinessEvidenceManifest,
  parseBusinessEvidenceReceipt,
} from './business-evidence-service.js';
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-06',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST_WORK',
};
const basis = { linkSetId: uuid(4), version: 1 };
const raw = { scopeRef: null, withinScopeRef: null, qty: null, unit: null };
const photo = { photoId: uuid(5), photoVersion: 1, linkId: uuid(6) };
const manifest = {
  target,
  basis,
  state: 'PARTIAL',
  coverage: raw,
  photos: [photo],
};
describe('C05 service decoders', () => {
  it('accepts exact source target and receipt', () => {
    expect(parseBusinessEvidenceQuery(target)).toEqual(target);
    expect(
      parseBusinessEvidenceReceipt({
        target,
        basis,
        manifestId: uuid(7),
        daySeq: 42,
        changed: false,
      }).changed,
    ).toBe(false);
  });
  it.each(['orgId', 'role', 'qty', 'daySeq', 'manifestId'])(
    'rejects client read authority/cut field %s',
    (field) =>
      expect(() =>
        parseBusinessEvidenceQuery({ ...target, [field]: uuid(8) }),
      ).toThrow(),
  );
  it('rejects invalid calendar dates and array query values', () => {
    expect(() =>
      parseBusinessEvidenceQuery({ ...target, businessDate: '2026-02-30' }),
    ).toThrow();
    expect(() =>
      parseBusinessEvidenceQuery({ ...target, crewId: [target.crewId] }),
    ).toThrow();
  });
  it('preserves raw null coverage without fabricating C04 whole coverage', () => {
    const parsed = parseBusinessEvidenceManifest(manifest);
    expect(parsed.associationCoverage).toEqual(raw);
    expect(parsed.evidence.coverage).toBeNull();
  });
  it('preserves explicit zero and original decimal spelling', () => {
    const coverage = {
      scopeRef: uuid(8),
      withinScopeRef: uuid(8),
      qty: '0.000000',
      unit: 'm',
    };
    expect(
      parseBusinessEvidenceManifest({ ...manifest, coverage })
        .associationCoverage,
    ).toEqual(coverage);
  });
  it.each([0, 1000001, 1.5])('rejects invalid media version %s', (n) =>
    expect(() =>
      parseBusinessEvidenceManifest({
        ...manifest,
        photos: [{ ...photo, photoVersion: n }],
      }),
    ).toThrow(),
  );
  it('rejects duplicate links/photos and unknown manifest fields', () => {
    expect(() =>
      parseBusinessEvidenceManifest({ ...manifest, photos: [photo, photo] }),
    ).toThrow();
    expect(() =>
      parseBusinessEvidenceManifest({ ...manifest, actualQty: '10' }),
    ).toThrow();
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid sequence %s',
    (daySeq) =>
      expect(() =>
        parseBusinessEvidenceReceipt({
          target,
          basis,
          manifestId: uuid(7),
          daySeq,
          changed: false,
        }),
      ).toThrow(),
  );
});
