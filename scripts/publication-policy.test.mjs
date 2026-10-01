import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isAllowedPublicPath,
  hasCredentialPattern,
  parseStageRecord,
} from './publication-policy.mjs';

test('new paths require explicit review', () => {
  const allow = new Set(['apps/api/src/main.ts']);
  assert.equal(isAllowedPublicPath('apps/api/src/main.ts', allow), true);
  assert.equal(
    isAllowedPublicPath('apps/api/src/customer-export.json', allow),
    false,
  );
});
test('an allowlist entry cannot bypass private data exclusions', () => {
  for (const path of [
    '.env',
    'apps/api/.env.production',
    'docs/requirements/example.md',
    'private/data.json',
    'photo.JPG',
    'report.docx',
    'backup.zip',
  ]) {
    assert.equal(isAllowedPublicPath(path, new Set([path])), false);
  }
});
test('local emulator example can be reviewed without permitting real env files', () => {
  assert.equal(
    isAllowedPublicPath('.env.example', new Set(['.env.example'])),
    true,
  );
});
test('common credential forms are detected without recording real secrets', () => {
  const synthetic = [
    'ghp_' + 'x'.repeat(24),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'https://example.invalid/blob?sig=' + 'x'.repeat(24),
  ];
  for (const value of synthetic)
    assert.equal(hasCredentialPattern(value), true);
  assert.equal(
    hasCredentialPattern('AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}'),
    false,
  );
});
test('an index record keeps its whole path: tabs and newlines in a name are part of it', () => {
  const sha1 = 'a'.repeat(40);
  const sha256 = 'b'.repeat(64);
  assert.deepEqual(parseStageRecord(`100644 ${sha1} 0\tREADME.md`), {
    mode: '100644',
    object: sha1,
    stage: '0',
    path: 'README.md',
  });
  for (const path of [
    'README.md\tsecret.txt',
    'README.md\nsecret.txt',
    'a\tb\tc',
    ' leading and trailing ',
    '0:README.md',
  ])
    assert.equal(parseStageRecord(`100644 ${sha1} 0\t${path}`)?.path, path);
  assert.equal(parseStageRecord(`100755 ${sha256} 0\tx`)?.object, sha256);
  for (const stage of ['1', '2', '3'])
    assert.equal(parseStageRecord(`100644 ${sha1} ${stage}\tx`)?.stage, stage);
});
test('a malformed index record is never accepted', () => {
  const sha1 = 'a'.repeat(40);
  for (const record of [
    '',
    `100644 ${sha1} 0`,
    `100644 ${sha1} 0\t`,
    `100644 invalid 0\tREADME.md`,
    `100644 ${sha1.slice(1)} 0\tREADME.md`,
    `100644 ${sha1.toUpperCase()} 0\tREADME.md`,
    `100644 ${sha1} 0 extra\tREADME.md`,
    `100644 ${sha1} 4\tREADME.md`,
    `10064 ${sha1} 0\tREADME.md`,
    `100648 ${sha1} 0\tREADME.md`,
    `100644  ${sha1} 0\tREADME.md`,
    ` 100644 ${sha1} 0\tREADME.md`,
  ])
    assert.equal(parseStageRecord(record), null, JSON.stringify(record));
});

/**
 * Runs the real check-public.mjs on a synthetic TEST index: README.md and `approve` approved,
 * plus `files` staged (approved only when listed in `approve`). Git runs isolated from the
 * caller: no inherited GIT_* variables, no system or global config (so no global excludes,
 * hooks or filters), no templates; the guard runs with the same environment.
 * @param {Record<string, string>} files
 * @param {string[]} [approve]
 */
function checkSyntheticIndex(files, approve = []) {
  const dir = mkdtempSync(join(tmpdir(), 'mje-check-public-'));
  try {
    /** @type {NodeJS.ProcessEnv} */
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      HOME: dir,
    });
    const git = (/** @type {string[]} */ ...args) => {
      const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q', '--template=');
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['check-public.mjs', 'publication-policy.mjs'])
      copyFileSync(new URL(f, import.meta.url), join(dir, 'scripts', f));
    const approved = [
      'README.md',
      'public-files.json',
      'scripts/check-public.mjs',
      'scripts/publication-policy.mjs',
      ...approve,
    ];
    writeFileSync(join(dir, 'public-files.json'), JSON.stringify(approved));
    writeFileSync(join(dir, 'README.md'), 'TEST readme\n');
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    git('add', '-A');
    const r = spawnSync(process.execPath, ['scripts/check-public.mjs'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test('the index guard checks a whole path: a tab or newline in an unapproved name cannot borrow an approved prefix', () => {
  assert.equal(
    checkSyntheticIndex({}).status,
    0,
    'control: approved files only',
  );
  for (const name of ['README.md\tsecret.txt', 'README.md\nsecret.txt']) {
    const r = checkSyntheticIndex({ [name]: 'TEST not approved\n' });
    assert.equal(r.status, 1, JSON.stringify(name));
    assert.ok(r.out.includes(`${name}: not approved for publication`), r.out);
  }
});
test("the index guard scans a file's own staged content, never another path's", () => {
  // '0:README.md' read as a revision would be stage 0 of the clean README.md.
  const name = '0:README.md';
  const clean = checkSyntheticIndex({ [name]: 'TEST clean\n' }, [name]);
  assert.equal(clean.status, 0, clean.out);
  const synthetic = 'ghp_' + 'x'.repeat(24);
  const r = checkSyntheticIndex({ [name]: `TEST ${synthetic}\n` }, [name]);
  assert.equal(r.status, 1, r.out);
  assert.ok(
    r.out.includes(`${name}: binary or possible credential; inspect locally`),
    r.out,
  );
});
