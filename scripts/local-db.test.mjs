import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertLocalBlob,
  assertLocalDatabase,
  assertLocalUrl,
} from './local-db.mjs';

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
test('accepts only a blob connection string that can reach nothing but the local emulator', () => {
  const local =
    'DefaultEndpointsProtocol=http;AccountName=TEST;BlobEndpoint=http://127.0.0.1:11001/TEST;';
  assert.equal(assertLocalBlob(local).port, '11001');
  for (const raw of [
    // The SDK uses the first of a repeated field: a remote endpoint first, loopback second.
    'AccountName=TEST;BlobEndpoint=https://remote.example/TEST;BlobEndpoint=http://127.0.0.1:11001/TEST',
    'AccountName=TEST;blobendpoint=https://remote.example/TEST;BlobEndpoint=http://127.0.0.1:11001/TEST',
    'AccountName=TEST;BlobEndpoint=https://remote.example/TEST',
    // No endpoint: the SDK would build https://TEST.blob.core.windows.net.
    'DefaultEndpointsProtocol=https;AccountName=TEST',
    'UseDevelopmentStorage=true;DevelopmentStorageProxyUri=http://proxy.example',
    'AccountName=TEST;BlobEndpoint',
  ])
    assert.throws(() => assertLocalBlob(raw), undefined, raw);
  assert.throws(() => assertLocalUrl('https://TEST.blob.core.windows.net/x'));
  assert.ok(assertLocalUrl('http://localhost:11001/TEST/evidence-dev'));
});
