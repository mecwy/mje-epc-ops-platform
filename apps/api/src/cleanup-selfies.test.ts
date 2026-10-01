import { describe, expect, it } from 'vitest';
import {
  SELFIE_GRACE_MINUTES,
  SELFIE_RETENTION_DAYS,
  type SelfieBlobStore,
} from '@mje/domain';
import {
  classifyError,
  parseCleanupArgs,
  runCleanup,
  runMain,
  type LogLine,
  type SweepStore,
} from './cleanup-selfies.js';
import { ConfigError } from './runtime-env.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const clean = { eligible: 0, claimed: 0, deleted: 0, failed: 0 };
/** Text that must never reach a log line: a blob key and a person marker inside an error. */
const SECRET = 'selfie/11111111/deadbeef PERSON=Jane Doe';
const fakeBlobs = {} as SelfieBlobStore;

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
const pgError = (code: string) =>
  Object.assign(new Error(`pg says: ${SECRET}`), { code });
const restError = (statusCode: number) =>
  Object.assign(new Error(`storage says: ${SECRET}`), {
    name: 'RestError',
    statusCode,
  });

describe('cleanup-selfies arguments', () => {
  it('needs at least one organization, from --org or CLEANUP_ORG_IDS, deduplicated', () => {
    expect(parseCleanupArgs([], {})).toEqual({
      ok: false,
      refusal: { code: 'NO_ORGANIZATION' },
    });
    expect(parseCleanupArgs(['--org', ORG_A, '--org', ORG_A], {})).toEqual({
      ok: true,
      options: { orgIds: [ORG_A], limit: 100, dryRun: false },
    });
    expect(
      parseCleanupArgs(['--dry-run', '--org', ORG_A], {
        CLEANUP_ORG_IDS: ` ${ORG_B}, ${ORG_A} `,
        CLEANUP_BATCH_LIMIT: '500',
      }),
    ).toEqual({
      ok: true,
      options: { orgIds: [ORG_A, ORG_B], limit: 500, dryRun: true },
    });
  });

  it('refuses a bad id, an unknown flag and a bad limit by code and position, never by value', () => {
    expect(parseCleanupArgs(['--org', `TEST-R11 ${SECRET}`], {})).toEqual({
      ok: false,
      refusal: { code: 'BAD_ORGANIZATION_ID', position: 0 },
    });
    expect(parseCleanupArgs(['--org', ORG_A, `--all=${SECRET}`], {})).toEqual({
      ok: false,
      refusal: { code: 'UNKNOWN_ARGUMENT', position: 2 },
    });
    expect(parseCleanupArgs(['--org', ORG_A, '--limit', '0'], {})).toEqual({
      ok: false,
      refusal: { code: 'BAD_LIMIT' },
    });
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
    ).toEqual({
      ok: false,
      refusal: {
        code: 'CONSTANT_MISMATCH',
        name: 'SELFIE_RETENTION_DAYS',
        expected: SELFIE_RETENTION_DAYS,
        actual: SELFIE_RETENTION_DAYS + 1,
      },
    });
  });
});

describe('cleanup-selfies errors are logged as fixed codes only', () => {
  it('classifies database, storage and configuration failures without their messages', () => {
    expect(classifyError(pgError('42501'))).toEqual({
      cause: 'DATABASE',
      code: '42501',
    });
    expect(classifyError(restError(403))).toEqual({
      cause: 'STORAGE',
      status: 403,
    });
    expect(
      classifyError(new ConfigError('MISSING_CONFIGURATION', 'PGHOST')),
    ).toEqual({
      cause: 'CONFIGURATION',
      code: 'MISSING_CONFIGURATION',
      field: 'PGHOST',
    });
    expect(classifyError(new Error(SECRET))).toEqual({ cause: 'UNKNOWN' });
    expect(classifyError(SECRET)).toEqual({ cause: 'UNKNOWN' });
  });
});

describe('cleanup-selfies run', () => {
  it('sweeps every organization with the limit and dry-run it was given, and logs counts only', async () => {
    const lines: LogLine[] = [];
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

  it('a failed delete or a throwing organization gives exit 1, continues with the others, and never logs the message', async () => {
    const lines: LogLine[] = [];
    const store = fake({
      [ORG_A]: async () => {
        throw pgError('57P01');
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
    expect(lines[0]).toEqual({
      event: 'selfie_cleanup_error',
      orgId: ORG_A,
      dryRun: false,
      cause: 'DATABASE',
      code: '57P01',
    });
    expect(lines[1]).toMatchObject({
      event: 'selfie_cleanup',
      orgId: ORG_B,
      failed: 1,
    });
    expect(JSON.stringify(lines)).not.toContain('selfie/');
    expect(JSON.stringify(lines)).not.toContain('Jane');
  });
});

describe('cleanup-selfies process boundary', () => {
  const pool = () => {
    const p = { ended: 0, end: async () => void p.ended++ };
    return p;
  };
  type P = ReturnType<typeof pool>;
  const deps = (over: Partial<Parameters<typeof runMain<P>>[0]>) => {
    const lines: LogLine[] = [];
    const base: Parameters<typeof runMain<P>>[0] = {
      argv: ['--org', ORG_A],
      env: {},
      blobs: async () => fakeBlobs,
      pool,
      assertLogin: async () => undefined,
      store: () => fake({ [ORG_A]: async () => clean }),
      log: (l) => lines.push(l),
      ...over,
    };
    return { base, lines };
  };

  it('a configuration refusal is exit 2 and sweeps nothing', async () => {
    const { base, lines } = deps({ argv: [] });
    expect(await runMain(base)).toBe(2);
    expect(lines).toEqual([
      { event: 'selfie_cleanup_config', code: 'NO_ORGANIZATION' },
    ]);
    const noBlobs = deps({ blobs: async () => undefined });
    expect(await runMain(noBlobs.base)).toBe(2);
    expect(noBlobs.lines).toEqual([
      { event: 'selfie_cleanup_config', code: 'NO_BLOB_STORE' },
    ]);
  });

  it('a missing setting, a forbidden one or an unsafe login at startup is exit 2 with its code, pool closed', async () => {
    const missing = deps({
      pool: () => {
        throw new ConfigError('MISSING_CONFIGURATION', 'PGHOST');
      },
    });
    expect(await runMain(missing.base)).toBe(2);
    expect(missing.lines).toEqual([
      {
        event: 'selfie_cleanup_config',
        cause: 'CONFIGURATION',
        code: 'MISSING_CONFIGURATION',
        field: 'PGHOST',
      },
    ]);
    const created: P[] = [];
    const unsafe = deps({
      pool: () => {
        const p = pool();
        created.push(p);
        return p;
      },
      assertLogin: async () => {
        throw new ConfigError('UNSAFE_DATABASE_LOGIN');
      },
    });
    expect(await runMain(unsafe.base)).toBe(2);
    expect(unsafe.lines).toEqual([
      {
        event: 'selfie_cleanup_config',
        cause: 'CONFIGURATION',
        code: 'UNSAFE_DATABASE_LOGIN',
      },
    ]);
    expect(created[0]!.ended).toBe(1);
  });

  it('an operational startup failure is exit 1 with a code only; nothing is thrown', async () => {
    const storage = deps({
      blobs: async () => {
        throw restError(500);
      },
    });
    expect(await runMain(storage.base)).toBe(1);
    expect(storage.lines).toEqual([
      { event: 'selfie_cleanup_startup_error', cause: 'STORAGE', status: 500 },
    ]);
    const unknown = deps({
      assertLogin: async () => {
        throw new Error(SECRET);
      },
    });
    expect(await runMain(unknown.base)).toBe(1);
    expect(unknown.lines).toEqual([
      { event: 'selfie_cleanup_startup_error', cause: 'UNKNOWN' },
    ]);
    expect(JSON.stringify(unknown.lines)).not.toContain('Jane');
  });

  it('a clean run is exit 0 and closes the pool', async () => {
    const created: P[] = [];
    const ok = deps({
      pool: () => {
        const p = pool();
        created.push(p);
        return p;
      },
    });
    expect(await runMain(ok.base)).toBe(0);
    expect(created[0]!.ended).toBe(1);
    expect(ok.lines).toEqual([
      { event: 'selfie_cleanup', orgId: ORG_A, dryRun: false, ...clean },
    ]);
  });
});
