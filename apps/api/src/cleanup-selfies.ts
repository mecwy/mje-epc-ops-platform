/**
 * Selfie retention sweep (A6 design §3, U9): per organization, claims expired staged selfies and
 * attached selfies past SELFIE_RETENTION_DAYS, deletes their blobs and records each deletion in
 * the audit log (append-only; see CheckInStore.cleanupSelfies). Run as its own process of the app
 * image by the scheduled Dev job (infra/bicep/dev-selfie-cleanup-job.bicep) under the app
 * identity.
 *
 * Nothing here reads selfie bytes or person names, and the log never carries free text: every
 * line is an event name, an organization id, counts, and fixed codes (a SQLSTATE, an HTTP status,
 * a configuration name). Error messages are never logged; nothing escapes to stderr.
 *
 *   node dist/cleanup-selfies.js [--dry-run] [--org <id>]... [--limit <n>]
 *
 *   CLEANUP_ORG_IDS=<id,id>      organizations to sweep (the app login cannot list them: RLS,
 *                                and no grant on "Organization"); --org adds to the list
 *   CLEANUP_BATCH_LIMIT=<n>      rows claimed per organization per run (default 100)
 *   SELFIE_RETENTION_DAYS, SELFIE_GRACE_MINUTES
 *                                when set (the job sets them from its parameters) they must equal
 *                                @mje/domain's constants, so a deployment cannot drift from the code
 *
 * Exit code: 0 clean; 1 when a blob delete failed, an organization's sweep threw, the pool
 * reported an idle client's error, or startup failed for an operational reason (the next run
 * finishes DELETING rows); 2 when the configuration was refused (nothing was swept).
 */
import { pathToFileURL } from 'node:url';
import {
  CheckInStore,
  SELFIE_GRACE_MINUTES,
  SELFIE_RETENTION_DAYS,
  type SelfieBlobStore,
} from '@mje/domain';
import type { Pool } from 'pg';
import {
  ConfigError,
  assertApplicationLogin,
  databasePoolFromEnv,
  photoBlobsFromEnv,
} from './runtime-env.js';

export interface CleanupOptions {
  orgIds: string[];
  limit: number;
  dryRun: boolean;
}
/** Why the configuration was refused: a fixed code, a position or a name, numbers — no values. */
export type ConfigRefusal =
  | {
      code: 'CONSTANT_MISMATCH';
      name: 'SELFIE_RETENTION_DAYS' | 'SELFIE_GRACE_MINUTES';
      expected: number;
      actual: number;
    }
  | { code: 'UNKNOWN_ARGUMENT'; position: number }
  | { code: 'BAD_ORGANIZATION_ID'; position: number }
  | { code: 'NO_ORGANIZATION' }
  | { code: 'BAD_LIMIT' };
export type CleanupConfig =
  { ok: true; options: CleanupOptions } | { ok: false; refusal: ConfigRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arguments and environment, checked; never throws; refusals carry no input values. */
export function parseCleanupArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CleanupConfig {
  const constants = [
    ['SELFIE_RETENTION_DAYS', SELFIE_RETENTION_DAYS],
    ['SELFIE_GRACE_MINUTES', SELFIE_GRACE_MINUTES],
  ] as const;
  for (const [name, expected] of constants) {
    const value = env[name];
    if (value !== undefined && Number(value) !== expected)
      return {
        ok: false,
        refusal: {
          code: 'CONSTANT_MISMATCH',
          name,
          expected,
          actual: Number(value),
        },
      };
  }
  let dryRun = false;
  const orgIds: string[] = [];
  let limit = Number(env['CLEANUP_BATCH_LIMIT'] ?? 100);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--org' && next !== undefined) orgIds.push(argv[++i]!);
    else if (arg === '--limit' && next !== undefined) limit = Number(argv[++i]);
    else
      return { ok: false, refusal: { code: 'UNKNOWN_ARGUMENT', position: i } };
  }
  for (const id of (env['CLEANUP_ORG_IDS'] ?? '').split(','))
    if (id.trim()) orgIds.push(id.trim());
  const bad = orgIds.findIndex((id) => !UUID.test(id));
  if (bad >= 0)
    return {
      ok: false,
      refusal: { code: 'BAD_ORGANIZATION_ID', position: bad },
    };
  if (orgIds.length === 0)
    return { ok: false, refusal: { code: 'NO_ORGANIZATION' } };
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    return { ok: false, refusal: { code: 'BAD_LIMIT' } };
  return { ok: true, options: { orgIds: [...new Set(orgIds)], limit, dryRun } };
}

/** What a failure was, in fixed vocabulary only: never its message. */
export type ErrorClass =
  | { cause: 'CONFIGURATION'; code: ConfigError['code']; field?: string }
  | { cause: 'DATABASE'; code: string }
  | { cause: 'STORAGE'; status: number }
  | { cause: 'UNKNOWN' };

const SQLSTATE = /^[0-9A-Z]{5}$/;
export function classifyError(error: unknown): ErrorClass {
  if (error instanceof ConfigError)
    return error.field
      ? { cause: 'CONFIGURATION', code: error.code, field: error.field }
      : { cause: 'CONFIGURATION', code: error.code };
  if (error instanceof Error) {
    const { code, name, statusCode } = error as Error & {
      code?: unknown;
      statusCode?: unknown;
    };
    if (name === 'RestError' && typeof statusCode === 'number')
      return { cause: 'STORAGE', status: statusCode };
    if (typeof code === 'string' && SQLSTATE.test(code))
      return { cause: 'DATABASE', code };
  }
  return { cause: 'UNKNOWN' };
}

/** What the sweep needs of the store (CheckInStore in production, a fake in tests). */
export interface SweepStore {
  cleanupSelfies(
    orgId: string,
    options: { limit?: number; dryRun?: boolean },
  ): Promise<{
    eligible: number;
    claimed: number;
    deleted: number;
    failed: number;
  }>;
}
export type LogLine = Record<string, string | number | boolean | undefined>;

/**
 * Sweeps each organization in turn; one failing organization does not stop the others.
 * Returns the exit code: 0 clean, 1 when any delete failed or a sweep threw.
 */
export async function runCleanup(
  store: SweepStore,
  options: CleanupOptions,
  log: (line: LogLine) => void,
): Promise<0 | 1> {
  let failed = 0;
  for (const orgId of options.orgIds) {
    try {
      const result = await store.cleanupSelfies(orgId, {
        limit: options.limit,
        dryRun: options.dryRun,
      });
      log({
        event: 'selfie_cleanup',
        orgId,
        dryRun: options.dryRun,
        ...result,
      });
      failed += result.failed;
    } catch (error) {
      failed++;
      log({
        event: 'selfie_cleanup_error',
        orgId,
        dryRun: options.dryRun,
        ...classifyError(error),
      });
    }
  }
  return failed > 0 ? 1 : 0;
}

/** What `runMain` needs of a pool: closing, and (pg) the error events of idle clients. */
export interface PoolLike {
  end(): Promise<void>;
  on?(event: 'error', listener: (error: unknown) => void): unknown;
}
/** The process's collaborators, so that the whole run can be exercised without Azure or a database. */
export interface MainDeps<P extends PoolLike> {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  blobs: () => Promise<SelfieBlobStore | undefined>;
  pool: () => P;
  assertLogin: (pool: P) => Promise<void>;
  store: (pool: P, blobs: SelfieBlobStore) => SweepStore;
  log: (line: LogLine) => void;
}

/**
 * The whole run with its error boundary: a configuration refusal (arguments, a missing or
 * forbidden setting, an unsafe login) is exit 2 and sweeps nothing; a startup failure for any
 * other reason is exit 1; nothing thrown reaches the caller, and the pool is always closed.
 */
export async function runMain<P extends PoolLike>(
  deps: MainDeps<P>,
): Promise<0 | 1 | 2> {
  const config = parseCleanupArgs(deps.argv, deps.env);
  if (!config.ok) {
    deps.log({ event: 'selfie_cleanup_config', ...config.refusal });
    return 2;
  }
  let pool: P | undefined;
  // An idle client's error (pg-pool emits it, outside any awaited call) is an operational failure.
  let poolFailed = false;
  try {
    const blobs = await deps.blobs();
    if (!blobs) {
      deps.log({ event: 'selfie_cleanup_config', code: 'NO_BLOB_STORE' });
      return 2;
    }
    pool = deps.pool();
    pool.on?.('error', (error) => {
      poolFailed = true;
      deps.log({ event: 'selfie_cleanup_pool_error', ...classifyError(error) });
    });
    await deps.assertLogin(pool);
    const code = await runCleanup(
      deps.store(pool, blobs),
      config.options,
      deps.log,
    );
    return poolFailed ? 1 : code;
  } catch (error) {
    const what = classifyError(error);
    deps.log({
      event:
        what.cause === 'CONFIGURATION'
          ? 'selfie_cleanup_config'
          : 'selfie_cleanup_startup_error',
      ...what,
    });
    return what.cause === 'CONFIGURATION' ? 2 : 1;
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // The last boundary: whatever escapes everything above is still logged as a code, never printed.
  const log = (line: LogLine) => console.info(JSON.stringify(line));
  const escaped = (error: unknown) => {
    log({ event: 'selfie_cleanup_startup_error', ...classifyError(error) });
    process.exit(1);
  };
  process.on('uncaughtException', escaped);
  process.on('unhandledRejection', escaped);
  process.exitCode = await runMain<Pool>({
    argv: process.argv.slice(2),
    env: process.env,
    blobs: photoBlobsFromEnv,
    pool: databasePoolFromEnv,
    assertLogin: assertApplicationLogin,
    store: (pool, blobs) => new CheckInStore(pool, blobs),
    log,
  }).catch((error: unknown) => {
    log({ event: 'selfie_cleanup_startup_error', ...classifyError(error) });
    return 1;
  });
}
