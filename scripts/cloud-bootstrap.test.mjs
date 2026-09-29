import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const GUID = '10000000-0000-4000-8000-000000000001';
const good = {
  NODE_ENV: 'production',
  AZURE_CLIENT_ID: 'TEST',
  PGHOST: 'mjeepc-dev-pg-test.postgres.database.azure.com',
  PGUSER: 'mjeepc-dev-migration',
  APP_PRINCIPAL_NAME: 'mjeepc-dev-app',
  APP_PRINCIPAL_OBJECT_ID: GUID,
  OWNER_TENANT_ID: GUID,
  OWNER_OBJECT_ID: GUID,
};
const run = (env) =>
  spawnSync(process.execPath, ['scripts/cloud-bootstrap.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
  });

test('bootstrap refuses to start without the managed identity', () => {
  const result = run({ NODE_ENV: 'production' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing cloud bootstrap configuration: AZURE_CLIENT_ID/,
  );
});
test('bootstrap refuses a wrong server, user, principal or a pre-supplied URL', () => {
  for (const override of [
    { PGHOST: 'wrong.postgres.database.azure.com' },
    { PGUSER: 'mjeepc-dev-app' },
    { APP_PRINCIPAL_NAME: 'azure_pg_admin' },
    { DATABASE_URL: 'postgresql://TEST_invalid' },
    { NODE_ENV: 'development' },
    { PGOPTIONS: '-c search_path=shadow,public' },
    { PGSERVICE: 'prod' },
  ]) {
    const result = run({ ...good, ...override });
    assert.equal(result.status, 1, JSON.stringify(override));
    assert.match(result.stderr, /not the approved Dev shape/);
  }
});
test('bootstrap refuses identifiers that are not GUIDs', () => {
  const result = run({ ...good, OWNER_OBJECT_ID: "x'; DROP TABLE" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a GUID: OWNER_OBJECT_ID/);
});

test('failures before any database work print only a code, never paths or details', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, rmSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // A copy without dependencies next to it: module loading fails inside the boundary.
  const dir = mkdtempSync(join(tmpdir(), 'mje-bootstrap-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(
      new URL('./cloud-bootstrap.mjs', import.meta.url),
      join(dir, 'scripts', 'cloud-bootstrap.mjs'),
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/cloud-bootstrap.mjs'],
      { cwd: dir, env: good, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      'Cloud bootstrap failed: code MODULE_NOT_FOUND',
    );
    assert.doesNotMatch(result.stderr, /requireStack|node_modules|\/scripts\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
