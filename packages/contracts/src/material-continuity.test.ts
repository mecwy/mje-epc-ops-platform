import { it, expect } from 'vitest';
import {
  parseAdmitMaterialUse,
  parseInitializeMaterialScope,
} from './material-continuity.js';
const id = '10000000-0000-4000-8000-000000000001';
const opening = {
  projectId: id,
  clientMutationId: id,
  materialItemId: id,
  materialKey: 'TESTMounts',
  specification: 'TEST',
  unit: 'set',
  workPackageId: 'TEST',
  scopeVersion: '1',
  ownership: 'TEST owner',
  custody: 'TEST custodian',
  location: 'TEST B5',
  openingDate: '2031-01-01',
  openingCutoffAt: '2031-01-01T00:00:00+01:00',
  openingQuantity: '500',
  openingBasis: 'TEST documented handover',
};
it('requires a dated independent opening basis and rejects client authority or estimates', () => {
  expect(parseInitializeMaterialScope(opening).openingQuantity).toBe('500');
  expect(() =>
    parseInitializeMaterialScope({ ...opening, openingBasis: '' }),
  ).toThrow();
  expect(() =>
    parseInitializeMaterialScope({ ...opening, orgId: id }),
  ).toThrow();
  expect(() =>
    parseInitializeMaterialScope({
      ...opening,
      openingQuantity: '100000000000000',
    }),
  ).toThrow();
  expect(
    parseInitializeMaterialScope({
      ...opening,
      openingQuantity: null,
      openingBasis: '',
    }).openingQuantity,
  ).toBeNull();
});
it('binds admission to source revision/fact and refuses duplicates, quantity and actor injection', () => {
  const c = {
    projectId: id,
    businessDate: '2031-01-01',
    clientMutationId: id,
    scopeId: id,
    expectedVersion: 1,
    records: [
      {
        sourceBusinessDate: '2031-01-01',
        revisionNumber: 1,
        useFactId: id,
        issueId: null,
        dueAt: null,
      },
    ],
  };
  expect(parseAdmitMaterialUse(c).records).toHaveLength(1);
  expect(() =>
    parseAdmitMaterialUse({ ...c, records: [...c.records, ...c.records] }),
  ).toThrow();
  expect(() =>
    parseAdmitMaterialUse({
      ...c,
      records: [{ ...c.records[0], quantity: '368' }],
    }),
  ).toThrow();
  expect(() => parseAdmitMaterialUse({ ...c, actorId: id })).toThrow();
});
