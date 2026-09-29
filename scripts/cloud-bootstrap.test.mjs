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
