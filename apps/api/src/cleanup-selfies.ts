/**
 * Selfie retention sweep (A6 design §3, U9): per organization, claims expired staged selfies and
 * attached selfies past SELFIE_RETENTION_DAYS, deletes their blobs and records each deletion in
 * the audit log (append-only; see CheckInStore.cleanupSelfies). Run as its own process of the app
 * image by the scheduled Dev job (infra/bicep/dev-selfie-cleanup-job.bicep) under the app
 * identity. Nothing here reads selfie bytes or person names; the log carries organization ids
 * and counts only.
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
 * Exit code: 0 clean; 1 when a blob delete failed or an organization's sweep threw (the next run
 * finishes DELETING rows); 2 for a configuration error (nothing was swept).
 */
import { pathToFileURL } from 'node:url';
import {
  CheckInStore,
  SELFIE_RETENTION_DAYS,
  SELFIE_GRACE_MINUTES,
} from '@mje/domain';
import {
  assertApplicationLogin,
  databasePoolFromEnv,
  photoBlobsFromEnv,
} from './runtime-env.js';

export interface CleanupOptions {
  orgIds: string[];
  limit: number;
  dryRun: boolean;
}
export type CleanupConfig =
  { ok: true; options: CleanupOptions } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arguments and environment, checked; never throws. */
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
        error: `${name}=${value} differs from the code constant ${expected}; deploy the job with the value from @mje/domain`,
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
    else return { ok: false, error: `unknown argument: ${arg}` };
  }
  for (const id of (env['CLEANUP_ORG_IDS'] ?? '').split(','))
    if (id.trim()) orgIds.push(id.trim());
  const bad = orgIds.find((id) => !UUID.test(id));
  if (bad !== undefined)
    return { ok: false, error: `not an organization id: ${bad}` };
  if (orgIds.length === 0)
    return {
      ok: false,
      error: 'no organization to sweep: pass --org <id> or CLEANUP_ORG_IDS',
    };
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
    return { ok: false, error: `invalid limit: ${limit}` };
  return { ok: true, options: { orgIds: [...new Set(orgIds)], limit, dryRun } };
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

/**
 * Sweeps each organization in turn; one failing organization does not stop the others.
 * Returns the exit code: 0 clean, 1 when any delete failed or a sweep threw.
 */
export async function runCleanup(
  store: SweepStore,
  options: CleanupOptions,
  log: (line: Record<string, unknown>) => void,
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
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failed > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const log = (line: Record<string, unknown>) =>
    console.info(JSON.stringify(line));
  const config = parseCleanupArgs(process.argv.slice(2), process.env);
  if (!config.ok) {
    log({ event: 'selfie_cleanup_config', error: config.error });
    return 2;
  }
  const blobs = await photoBlobsFromEnv();
  if (!blobs) {
    log({
      event: 'selfie_cleanup_config',
      error:
        'no blob store: set BLOB_ACCOUNT_URL with AZURE_CLIENT_ID (or BLOB_CONNECTION_STRING locally)',
    });
    return 2;
  }
  const pool = databasePoolFromEnv();
  try {
    await assertApplicationLogin(pool);
    return await runCleanup(new CheckInStore(pool, blobs), config.options, log);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
