import { describe, expect, it } from 'vitest';
import { SELFIE_RETENTION_DAYS, SELFIE_GRACE_MINUTES } from '@mje/domain';
import {
  parseCleanupArgs,
  runCleanup,
  type SweepStore,
} from './cleanup-selfies.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const clean = { eligible: 0, claimed: 0, deleted: 0, failed: 0 };

describe('cleanup-selfies arguments', () => {
  it('needs at least one organization, from --org or CLEANUP_ORG_IDS, deduplicated', () => {
    expect(parseCleanupArgs([], {})).toMatchObject({ ok: false });
    expect(parseCleanupArgs(['--org', ORG_A, '--org', ORG_A], {})).toEqual({
      ok: true,
      options: { orgIds: [ORG_A], limit: 100, dryRun: false },
    });
    const both = parseCleanupArgs(['--dry-run', '--org', ORG_A], {
      CLEANUP_ORG_IDS: ` ${ORG_B}, ${ORG_A} `,
      CLEANUP_BATCH_LIMIT: '500',
    });
    expect(both).toEqual({
      ok: true,
      options: { orgIds: [ORG_A, ORG_B], limit: 500, dryRun: true },
    });
  });

  it('refuses what it cannot act on: a bad id, an unknown flag, a bad limit', () => {
    expect(parseCleanupArgs(['--org', 'TEST-R11'], {})).toMatchObject({
      ok: false,
      error: expect.stringContaining('not an organization id'),
    });
    expect(
      parseCleanupArgs(['--all'], { CLEANUP_ORG_IDS: ORG_A }),
    ).toMatchObject({ ok: false, error: 'unknown argument: --all' });
    expect(
      parseCleanupArgs(['--org', ORG_A, '--limit', '0'], {}),
    ).toMatchObject({ ok: false, error: 'invalid limit: 0' });
  });

  it('refuses a deployment whose retention parameters differ from the code constants', () => {
    const env = { CLEANUP_ORG_IDS: ORG_A };
    expect(
      parseCleanupArgs([], {
        ...env,
        SELFIE_RETENTION_DAYS: String(SELFIE_RETENTION_DAYS),
        SELFIE_GRACE_MINUTES: String(SELFIE_GRACE_MINUTES),
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCleanupArgs([], {
        ...env,
        SELFIE_RETENTION_DAYS: String(SELFIE_RETENTION_DAYS + 1),
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('SELFIE_RETENTION_DAYS'),
    });
  });
});

describe('cleanup-selfies run', () => {
  const fake = (
    answers: Record<string, (() => Promise<typeof clean>) | undefined>,
  ): SweepStore & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return {
      calls,
      cleanupSelfies: async (orgId, options) => {
        calls.push([orgId, options]);
        const answer = answers[orgId];
        if (!answer) throw new Error(`unexpected organization ${orgId}`);
        return answer();
      },
    };
  };

  it('sweeps every organization with the limit and dry-run it was given, and logs counts only', async () => {
    const lines: Record<string, unknown>[] = [];
    const store = fake({
      [ORG_A]: async () => ({ ...clean, eligible: 3, claimed: 3, deleted: 3 }),
      [ORG_B]: async () => ({ ...clean, eligible: 1 }),
    });
    const code = await runCleanup(
      store,
      { orgIds: [ORG_A, ORG_B], limit: 50, dryRun: true },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(store.calls).toEqual([
      [ORG_A, { limit: 50, dryRun: true }],
      [ORG_B, { limit: 50, dryRun: true }],
    ]);
    expect(lines).toEqual([
      {
        event: 'selfie_cleanup',
        orgId: ORG_A,
        dryRun: true,
        eligible: 3,
        claimed: 3,
        deleted: 3,
        failed: 0,
      },
      {
        event: 'selfie_cleanup',
        orgId: ORG_B,
        dryRun: true,
        eligible: 1,
        claimed: 0,
        deleted: 0,
        failed: 0,
      },
    ]);
    // Only these keys ever reach the log: no blob keys, no bytes, no names.
    for (const l of lines)
      expect(Object.keys(l).sort()).toEqual([
        'claimed',
        'deleted',
        'dryRun',
        'eligible',
        'event',
        'failed',
        'orgId',
      ]);
  });

  it('a failed delete or a throwing organization gives exit 1 but does not stop the others', async () => {
    const lines: Record<string, unknown>[] = [];
    const store = fake({
      [ORG_A]: async () => {
        throw new Error('database unavailable');
      },
      [ORG_B]: async () => ({
        ...clean,
        eligible: 2,
        claimed: 2,
        deleted: 1,
        failed: 1,
      }),
    });
    const code = await runCleanup(
      store,
      { orgIds: [ORG_A, ORG_B], limit: 100, dryRun: false },
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(store.calls).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: 'selfie_cleanup_error',
      orgId: ORG_A,
      error: 'database unavailable',
    });
    expect(lines[1]).toMatchObject({
      event: 'selfie_cleanup',
      orgId: ORG_B,
      failed: 1,
    });
  });
});
