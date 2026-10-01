import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  const object = '0'.repeat(40);
  assert.deepEqual(parseStageRecord(`100644 ${object} 0\tREADME.md`), {
    mode: '100644',
    stage: '0',
    path: 'README.md',
  });
  for (const path of [
    'README.md\tsecret.txt',
    'README.md\nsecret.txt',
    'a\tb\tc',
  ])
    assert.equal(parseStageRecord(`100644 ${object} 0\t${path}`)?.path, path);
  assert.equal(parseStageRecord(`100644 ${object} 0`), null);
  assert.equal(parseStageRecord(''), null);
});

/**
 * Runs the real check-public.mjs on a synthetic TEST index: an approved README.md, plus the
 * given extra files (staged, not approved). Returns its exit status and output.
 * @param {Record<string, string>} extra
 */
function checkSyntheticIndex(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'mje-check-public-'));
  try {
    const git = (/** @type {string[]} */ ...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q');
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['check-public.mjs', 'publication-policy.mjs'])
      copyFileSync(new URL(f, import.meta.url), join(dir, 'scripts', f));
    const approved = [
      'README.md',
      'public-files.json',
      'scripts/check-public.mjs',
      'scripts/publication-policy.mjs',
    ];
    writeFileSync(join(dir, 'public-files.json'), JSON.stringify(approved));
    writeFileSync(join(dir, 'README.md'), 'TEST readme\n');
    for (const [name, text] of Object.entries(extra))
      writeFileSync(join(dir, name), text);
    git('add', '-A');
    const r = spawnSync(process.execPath, ['scripts/check-public.mjs'], {
      cwd: dir,
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
