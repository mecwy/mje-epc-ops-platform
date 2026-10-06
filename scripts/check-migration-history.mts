/** Compare immutable migration files in two explicit commits. No database access. */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = 'packages/domain/prisma/migrations/';
type Entry = { mode: string; type: string; object: string };
export type MigrationCheck = {
  base: string;
  head: string;
  existing: number;
  added: number;
};

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function commit(repo: string, ref: string): string {
  if (!ref || /^0+$/.test(ref))
    throw new Error('An explicit existing commit is required');
  try {
    return git(repo, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ]).trim();
  } catch {
    throw new Error('Cannot resolve the supplied migration comparison commit');
  }
}

function tree(repo: string, sha: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const record of git(repo, [
    'ls-tree',
    '-r',
    '-z',
    sha,
    '--',
    MIGRATIONS,
  ]).split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    const path = record.slice(separator + 1);
    const [mode, type, object] = record.slice(0, separator).split(' ');
    if (
      separator < 0 ||
      !mode ||
      !type ||
      !object ||
      !path.startsWith(MIGRATIONS)
    ) {
      throw new Error('Unexpected migration tree entry');
    }
    entries.set(path, { mode, type, object });
  }
  return entries;
}

export function checkMigrationHistory(
  repo: string,
  baseRef: string,
  headRef: string,
): MigrationCheck {
  const base = commit(repo, baseRef);
  const head = commit(repo, headRef);
  try {
    git(repo, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error(
      'Migration comparison base must be an ancestor of the candidate',
    );
  }
  const before = tree(repo, base);
  const after = tree(repo, head);
  const failures: string[] = [];
  for (const [path, entry] of before) {
    const candidate = after.get(path);
    if (!candidate)
      failures.push(`deleted or renamed: ${JSON.stringify(path)}`);
    else if (
      candidate.object !== entry.object ||
      candidate.mode !== entry.mode ||
      candidate.type !== entry.type
    ) {
      failures.push(`changed: ${JSON.stringify(path)}`);
    }
  }
  for (const [path, entry] of after) {
    if (entry.type !== 'blob' || entry.mode !== '100644') {
      failures.push(
        `not a regular non-executable file: ${JSON.stringify(path)}`,
      );
    }
  }
  if (failures.length)
    throw new Error(
      `Migration history must be append-only:\n${failures.join('\n')}`,
    );
  return { base, head, existing: before.size, added: after.size - before.size };
}

export function main(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  let base = env['MJE_MIGRATION_BASE'];
  let head = env['MJE_MIGRATION_HEAD'];
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i],
      value = args[i + 1];
    if (!value || (option !== '--base' && option !== '--head')) {
      throw new Error(
        'Usage: check-migration-history.mts --base <commit> --head <commit>',
      );
    }
    if (option === '--base') base = value;
    else head = value;
  }
  if (!base || !head)
    throw new Error(
      'Set explicit --base/--head or MJE_MIGRATION_BASE/MJE_MIGRATION_HEAD',
    );
  const result = checkMigrationHistory(process.cwd(), base, head);
  process.stdout.write(
    `Migration history OK: ${result.existing} preserved, ${result.added} added; ${result.base}..${result.head}\n`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Migration history check failed'}\n`,
    );
    process.exitCode = 1;
  }
}
