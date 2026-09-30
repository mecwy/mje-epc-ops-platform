import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const GUID = '10000000-0000-4000-8000-000000000001';
const MEMBER = '20000000-0000-4000-8000-000000000002';
const good = {
  NODE_ENV: 'production',
  AZURE_CLIENT_ID: 'TEST',
  PGHOST: 'mjeepc-dev-pg-test.postgres.database.azure.com',
  PGUSER: 'mjeepc-dev-migration',
  OWNER_TENANT_ID: GUID,
  MEMBER_OBJECT_ID: MEMBER,
  MEMBER_ROLE: 'EXECUTIVE_READER',
  MEMBER_DISPLAY_NAME: 'TEST 总监',
  PROJECT_CODE: 'TEST-R11',
};
const run = (env) =>
  spawnSync(process.execPath, ['scripts/cloud-add-member.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
  });

test('add-member refuses to start without the managed identity or any member setting', () => {
  const result = run({ NODE_ENV: 'production' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing cloud add-member configuration: AZURE_CLIENT_ID/,
  );
  for (const name of [
    'OWNER_TENANT_ID',
    'MEMBER_OBJECT_ID',
    'MEMBER_ROLE',
    'MEMBER_DISPLAY_NAME',
    'PROJECT_CODE',
  ]) {
    const env = { ...good };
    delete env[name];
    const missing = run(env);
    assert.equal(missing.status, 1, name);
    assert.match(
      missing.stderr,
      new RegExp(`Missing cloud add-member configuration: ${name}`),
    );
  }
});
test('add-member refuses a wrong server, user or a pre-supplied URL', () => {
  for (const override of [
    { PGHOST: 'wrong.postgres.database.azure.com' },
    { PGUSER: 'mjeepc-dev-app' },
    { DATABASE_URL: 'postgresql://TEST_invalid' },
    { ALPHA_DATABASE_URL: 'postgresql://TEST_invalid' },
    { NODE_ENV: 'development' },
    { PGOPTIONS: '-c search_path=shadow,public' },
    { PGSERVICE: 'prod' },
    { PGSERVICEFILE: '/TEST/pg_service.conf' },
  ]) {
    const result = run({ ...good, ...override });
    assert.equal(result.status, 1, JSON.stringify(override));
    assert.match(result.stderr, /not the approved Dev shape/);
  }
});
test('add-member refuses identifiers that are not GUIDs, without echoing them', () => {
  for (const name of ['OWNER_TENANT_ID', 'MEMBER_OBJECT_ID']) {
    const result = run({ ...good, [name]: "x'; DROP TABLE" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`not a GUID: ${name}`));
    assert.doesNotMatch(result.stderr, /DROP TABLE/);
  }
});
test('add-member accepts only the two report roles', () => {
  for (const role of ['ADMIN', 'project_manager', 'PROJECT_MANAGER ']) {
    const result = run({ ...good, MEMBER_ROLE: role });
    assert.equal(result.status, 1, role);
    assert.match(
      result.stderr,
      /MEMBER_ROLE must be PROJECT_MANAGER or EXECUTIVE_READER/,
    );
  }
});
test('add-member accepts only a TEST display name and never echoes it', () => {
  for (const name of [
    'Real Person',
    'test reader',
    'TEST',
    'TEST   ',
    'TESTER',
    `TEST ${'x'.repeat(80)}`,
    'TEST a\nb',
  ]) {
    const result = run({ ...good, MEMBER_DISPLAY_NAME: name });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /MEMBER_DISPLAY_NAME must be a TEST label/);
    assert.doesNotMatch(result.stderr, /Real Person|reader|TESTER/);
  }
});
test('add-member only targets the TEST project', () => {
  const result = run({ ...good, PROJECT_CODE: 'R11' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PROJECT_CODE must be TEST-R11/);
});

test('failures before any database work print only a code, never paths or details', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // A copy without dependencies next to it: module loading fails inside the boundary.
  const dir = mkdtempSync(join(tmpdir(), 'mje-add-member-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(
      new URL('./cloud-add-member.mjs', import.meta.url),
      join(dir, 'scripts', 'cloud-add-member.mjs'),
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/cloud-add-member.mjs'],
      { cwd: dir, env: good, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      'Cloud add-member failed: code MODULE_NOT_FOUND',
    );
    assert.doesNotMatch(result.stderr, /requireStack|node_modules|\/scripts\//);
    assert.doesNotMatch(result.stderr, new RegExp(MEMBER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
