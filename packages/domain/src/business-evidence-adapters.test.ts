import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Actor } from './store-kit.js';
import { businessEvidencePorts } from './business-evidence-adapters.js';
const actor: Actor = {
  orgId: 'TEST_org',
  accountId: 'TEST_account',
  personId: 'TEST_person',
  authzVersion: 1,
  decidedAt: '2026-10-08T00:00:00Z',
};
const target = {
  projectId: 'TEST_project',
  crewId: 'TEST_crew',
  itemKey: 'TEST_WORK',
  foremanRevisionId: 'TEST_revision',
  businessDate: '2026-10-06',
};
describe('real day gate composition', () => {
  it('does not fabricate policy, media or historical read cuts at bootstrap', async () => {
    const ports = businessEvidencePorts();
    const client = {} as PoolClient;
    expect(await ports.resolveAuthority(client, actor, target)).toBeNull();
    expect(
      await ports.readMedia(
        client,
        actor,
        target,
        { photoId: 'TEST_photo', photoVersion: 1 },
        'BIND',
      ),
    ).toBeNull();
  });
  it('never falls back to current evidence on a frozen report missing its parent manifest exit', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ state: 'SUBMITTED', correctionReason: null }],
    });
    await expect(
      businessEvidencePorts().resolveReadCut(
        { query } as unknown as PoolClient,
        actor,
        target,
      ),
    ).rejects.toThrow('INTEGRATION_REQUIRED');
  });
  it('holds the existing exact day gate and refuses a submitted day without advancing its sequence', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ state: 'SUBMITTED', correctionReason: null }],
      });
    const client = { query } as unknown as PoolClient;
    await expect(
      businessEvidencePorts().withDayGate(
        client,
        actor,
        target,
        async (gate) => {
          await gate.assertWritable();
          await gate.nextSequence();
        },
      ),
    ).rejects.toThrow('LOCKED');
    expect(query.mock.calls[0]?.[1]).toEqual([
      `${actor.orgId}:day:${target.projectId}:${target.businessDate}`,
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('uses the same transaction for writable correction and field sequence allocation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ state: 'SUBMITTED', correctionReason: 'TEST correction' }],
      })
      .mockResolvedValueOnce({ rows: [{ lastSeq: '11' }] });
    await expect(
      businessEvidencePorts().withDayGate(
        { query } as unknown as PoolClient,
        actor,
        target,
        async (gate) => {
          await gate.assertWritable();
          return gate.nextSequence();
        },
      ),
    ).resolves.toBe(11);
    expect(query.mock.calls[2]?.[1]).toEqual([
      expect.any(String),
      actor.orgId,
      target.projectId,
      target.businessDate,
    ]);
  });
});
