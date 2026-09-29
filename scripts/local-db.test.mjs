import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLocalDatabase } from './local-db.mjs';

test('accepts only a local destination', () => {
  assert.equal(
    assertLocalDatabase('postgresql://u:p@localhost:55433/db', {}).port,
    '55433',
  );
  assert.ok(assertLocalDatabase('postgres://u:p@127.0.0.1/db', {}));
});
test('refuses query and environment overrides that node-postgres would honour', () => {
  for (const url of [
    'postgresql://TEST:TEST@localhost/postgres?host=remote.example',
    'postgresql://TEST:TEST@localhost/postgres?HOSTADDR=10.0.0.5',
    'postgresql://TEST:TEST@localhost/postgres?service=prod',
    'postgresql://TEST:TEST@db.example.com/postgres',
    'mysql://TEST:TEST@localhost/db',
  ])
    assert.throws(() => assertLocalDatabase(url, {}), undefined, url);
  assert.throws(() =>
    assertLocalDatabase('postgresql://u:p@localhost/db', {
      PGHOST: 'remote.example',
    }),
  );
  assert.throws(() =>
    assertLocalDatabase('postgresql://u:p@localhost/db', { PGSERVICE: 'prod' }),
  );
});
