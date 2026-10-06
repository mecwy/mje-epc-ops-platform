import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrationHistory, main } from './check-migration-history.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(name = '202801010001_test') {
  const root = mkdtempSync(join(tmpdir(), 'mje-TEST-migration-history-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'TEST migration guard');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.filemode', 'true');
  const dir = join(root, 'packages/domain/prisma/migrations', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'migration.sql');
  writeFileSync(file, 'CREATE TABLE "TESTOnly" (id integer);\n');
  const save = () => {
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', 'TEST fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = save();
  return { root, git, dir, file, base, save };
}

test('preserves old bytes and permits an additive migration and unrelated code', () => {
  const f = fixture();
  const added = join(
    f.root,
    'packages/domain/prisma/migrations/202801020001_test',
  );
  mkdirSync(added);
  writeFileSync(
    join(added, 'migration.sql'),
    'ALTER TABLE "TESTOnly" ADD COLUMN note text;\n',
  );
  writeFileSync(join(f.root, 'TEST.txt'), 'unrelated');
  const head = f.save();
  assert.deepEqual(checkMigrationHistory(f.root, f.base, head), {
    base: f.base,
    head,
    existing: 1,
    added: 1,
  });
});

test('refuses byte changes even if SQL semantics appear unchanged', () => {
  const f = fixture();
  writeFileSync(f.file, 'CREATE TABLE "TESTOnly" (id integer); -- changed\n');
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /changed:/,
  );
});

test('refuses deletion', () => {
  const f = fixture();
  rmSync(f.file);
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /deleted or renamed:/,
  );
});

test('refuses a directory rename even when all SQL bytes are identical', () => {
  const f = fixture();
  renameSync(f.dir, `${f.dir}-renamed`);
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /deleted or renamed:/,
  );
});

test('refuses permission changes', () => {
  const f = fixture();
  chmodSync(f.file, 0o755);
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /changed:/,
  );
});

test('refuses new symlinks instead of following them', () => {
  const f = fixture();
  symlinkSync(
    '202801010001_test/migration.sql',
    join(f.root, 'packages/domain/prisma/migrations/link.sql'),
  );
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /not a regular/,
  );
});

test('checks exact paths with tabs, newlines and non-ASCII characters', () => {
  const f = fixture('202801010001_TEST\t换行\n迁移');
  assert.equal(checkMigrationHistory(f.root, f.base, f.base).existing, 1);
  writeFileSync(f.file, 'SELECT 1;\n');
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /changed:.*\\t.*\\n/,
  );
});

test('refuses absent, zero, missing or option-like bases', () => {
  const f = fixture();
  for (const base of [
    '',
    '0000000000000000000000000000000000000000',
    'TEST-missing-ref',
    '--help',
  ]) {
    assert.throws(() => checkMigrationHistory(f.root, base, f.base), /commit/);
  }
  assert.throws(() => main([], {}), /explicit/);
  assert.throws(() => main(['--base'], {}), /Usage/);
});

test('does not compare a newer base against an older candidate', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'TEST.txt'), 'advance');
  const newer = f.save();
  assert.throws(() => checkMigrationHistory(f.root, newer, f.base), /ancestor/);
});

test('uses the full selected range, not only the last commit', () => {
  const f = fixture();
  writeFileSync(f.file, 'SELECT 2;\n');
  f.save();
  writeFileSync(join(f.root, 'TEST.txt'), 'later unrelated change');
  assert.throws(
    () => checkMigrationHistory(f.root, f.base, f.save()),
    /changed:/,
  );
});
