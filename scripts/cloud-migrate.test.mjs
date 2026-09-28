import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const run = (env) =>
  spawnSync(process.execPath, ['scripts/cloud-migrate.mjs'], {
    cwd: new URL('..', import.meta.url),
    env,
    encoding: 'utf8',
  });

test('cloud migration refuses missing managed identity before Prisma can use a local URL', () => {
  const result = run({ NODE_ENV: 'production' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing cloud migration configuration: AZURE_CLIENT_ID/,
  );
});

test('cloud migration refuses a wrong server', () => {
  const result = run({
    NODE_ENV: 'production',
    AZURE_CLIENT_ID: 'TEST',
    PGHOST: 'wrong.postgres.database.azure.com',
    PGDATABASE: 'mje',
    PGUSER: 'mjeepc-dev-migration',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the approved Dev shape/);
});

test('cloud migration refuses a pre-supplied database URL', () => {
  const result = run({
    NODE_ENV: 'production',
    AZURE_CLIENT_ID: 'TEST',
    PGHOST: 'mjeepc-dev-pg-test.postgres.database.azure.com',
    PGDATABASE: 'mje',
    PGUSER: 'mjeepc-dev-migration',
    DATABASE_URL: 'postgresql://TEST_invalid',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the approved Dev shape/);
});
