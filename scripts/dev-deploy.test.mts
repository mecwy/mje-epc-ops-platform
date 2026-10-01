import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildImage,
  deployApp,
  deployMigrationJob,
  DeployStop,
  imageDigest,
  jobOutcome,
  parseArgs,
  validateConfig,
  type DeployConfig,
} from './dev-deploy.mts';

// Synthetic TEST identifiers only.
const config: DeployConfig = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  subscriptionName: 'TEST-Subscription',
  resourceGroup: 'test-rg',
  registryName: 'testregistry01',
  postgresFqdn: 'test-pg.postgres.database.azure.com',
  apiClientId: '00000000-0000-4000-8000-000000000002',
  spaClientId: '00000000-0000-4000-8000-000000000003',
  storageAccountName: 'teststorage01',
  migrationJobName: 'test-migrate',
};
const sha = 'a'.repeat(40);

test('arguments: a command, then known options only', () => {
  assert.deepEqual(parseArgs(['all']), {
    command: 'all',
    sha: null,
    config: 'private/dev-deploy.json',
    record: null,
    dryRun: false,
  });
  assert.deepEqual(
    parseArgs([
      'app',
      '--sha',
      sha,
      '--config',
      'x.json',
      '--record',
      'r.md',
      '--dry-run',
    ]),
    { command: 'app', sha, config: 'x.json', record: 'r.md', dryRun: true },
  );
  for (const argv of [
    [],
    ['deploy'],
    ['app', '--sha'],
    ['app', '--sha', '--dry-run'],
    ['app', '--force'],
  ])
    assert.throws(() => parseArgs(argv), DeployStop, JSON.stringify(argv));
});

test('config: exactly the known keys, each in its expected shape', () => {
  assert.deepEqual(validateConfig({ ...config }), config);
  for (const bad of [
    null,
    [],
    'x',
    { ...config, extra: 'x' },
    { ...config, tenantId: 'not-a-guid' },
    { ...config, postgresFqdn: 'pg.example.com' },
    { ...config, registryName: 'Bad_Name' },
    { ...config, resourceGroup: 'rg; rm -rf /' },
    { ...config, apiClientId: 42 },
    Object.fromEntries(
      Object.entries(config).filter(([k]) => k !== 'spaClientId'),
    ),
  ])
    assert.throws(() => validateConfig(bad), DeployStop, JSON.stringify(bad));
});

test('az invocations are argument vectors built from the config and the exact commit', () => {
  const build = buildImage(config, 'mje-app', sha, '/tmp/src');
  assert.deepEqual(build.slice(0, 8), [
    'acr',
    'build',
    '-r',
    'testregistry01',
    '-t',
    `mje-app:${sha}`,
    '-f',
    'Dockerfile',
  ]);
  assert.ok(build.includes(`SOURCE_REVISION=${sha}`));
  assert.equal(
    buildImage(config, 'mje-migrate', sha, '/tmp/src')[7],
    'Dockerfile.migrate',
  );
  assert.deepEqual(imageDigest(config, 'mje-app', sha).slice(-6), [
    '--image',
    `mje-app:${sha}`,
    '--query',
    'digest',
    '-o',
    'tsv',
  ]);
  const image = `testregistry01.azurecr.io/mje-app@sha256:${'b'.repeat(64)}`;
  const app = deployApp(config, sha, '/tmp/src', image);
  assert.ok(app.includes('/tmp/src/infra/bicep/dev-owner-app.bicep'));
  for (const p of [
    'registryName=testregistry01',
    'postgresFqdn=test-pg.postgres.database.azure.com',
    `tenantId=${config.tenantId}`,
    `apiClientId=${config.apiClientId}`,
    `spaClientId=${config.spaClientId}`,
    `imageReference=${image}`,
    `sourceRevision=${sha}`,
    'storageAccountName=teststorage01',
  ])
    assert.ok(app.includes(p), p);
  assert.ok(app.includes(`app-${sha.slice(0, 7)}`));
  const job = deployMigrationJob(config, sha, '/tmp/src', image);
  assert.ok(job.includes('/tmp/src/infra/bicep/dev-migration-job.bicep'));
  assert.ok(job.includes('test-rg'));
  // Never a shell string: no argument carries a shell metacharacter of its own.
  for (const arg of [...build, ...app, ...job])
    assert.ok(!/[;&|`$<>]/.test(arg), arg);
});

test('a migration execution: wait while running, deploy the app only on Succeeded', () => {
  assert.equal(jobOutcome('Succeeded'), 'ok');
  for (const s of ['Running', 'Processing', ''])
    assert.equal(jobOutcome(s), 'wait');
  for (const s of ['Failed', 'Stopped', 'Degraded', 'Unknown', 'succeeded'])
    assert.equal(jobOutcome(s), 'stop', s);
});
