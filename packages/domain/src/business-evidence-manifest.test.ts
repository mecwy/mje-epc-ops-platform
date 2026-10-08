import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  businessEvidenceSnapshotCut,
  frozenEvidenceManifest,
} from './business-evidence-manifest.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: id(1),
  businessDate: '2026-10-06',
  crewId: id(2),
  foremanRevisionId: id(3),
  itemKey: 'TEST_WORK',
};
const manifest = {
  target,
  id: id(4),
  basis: { linkSetId: id(5), version: 1 },
  daySeq: 5,
};
describe('frozen evidence identity', () => {
  it('never acquires present evidence when a historical snapshot lacks its cut', () => {
    expect(frozenEvidenceManifest(undefined, target, 7)).toBeNull();
    expect(
      frozenEvidenceManifest({ asOfSeq: 7, manifests: [] }, target, 7),
    ).toBeNull();
  });
  it('uses only the exact revision and recorded manifest basis', () => {
    const cut = { asOfSeq: 7, manifests: [manifest] };
    expect(frozenEvidenceManifest(cut, target, 7)).toEqual({
      id: manifest.id,
      basis: manifest.basis,
    });
    expect(
      frozenEvidenceManifest(cut, { ...target, foremanRevisionId: id(6) }, 7),
    ).toBeNull();
  });
  it.each([
    null,
    { asOfSeq: 8, manifests: [manifest] },
    { asOfSeq: 7, manifests: [{ ...manifest, daySeq: 8 }] },
    { asOfSeq: 7, manifests: [manifest, manifest] },
    {
      asOfSeq: 7,
      manifests: [{ ...manifest, target: { ...target, projectId: id(9) } }],
    },
  ])(
    'refuses a malformed, future, duplicated or foreign-project cut',
    (cut) => {
      expect(() => frozenEvidenceManifest(cut, target, 7)).toThrow();
    },
  );
  it('takes the SQL cut from the report owner and preserves immutable basis', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...manifest, daySeq: '5' }] }));
    const cut = await businessEvidenceSnapshotCut(
      { query } as unknown as PoolClient,
      id(8),
      target.projectId,
      target.businessDate,
      7,
    );
    expect(cut).toEqual({ asOfSeq: 7, manifests: [manifest] });
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining('v."daySeq"<=$4'),
      [id(8), target.projectId, target.businessDate, 7],
    ]);
  });
});
