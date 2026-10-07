import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildImage,
  deployApp,
  deployMigrationJob,
  DeployStop,
  failureMessage,
  imageDigest,
  isEntryPoint,
  jobOutcome,
  parseArgs,
  validateConfig,
  type DeployConfig,
} from './dev-deploy.mts';

const SCRIPT = fileURLToPath(new URL('./dev-deploy.mts', import.meta.url));

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
};
const sha = 'a'.repeat(40);

test('location deployment flags accept only explicit booleans', () => {
  for (const ui of [false, true])
    for (const save of [false, true]) {
      const raw = {
        ...config,
        reportLocationUiEnabled: ui,
        reportLocationSaveEnabled: save,
      };
      assert.deepEqual(validateConfig(raw), raw);
    }
  for (const key of ['reportLocationUiEnabled', 'reportLocationSaveEnabled'])
    for (const value of [undefined, null, 0, 1, 'false', 'true'])
      assert.throws(
        () => validateConfig({ ...config, [key]: value }),
        DeployStop,
      );
});

test('omitted location flags explicitly stay off in app build and runtime', () => {
  assert.ok(
    buildImage(config, 'mje-app', sha, '/tmp/src').includes(
      'VITE_REPORT_LOCATION_ENABLED=false',
    ),
  );
  assert.ok(
    deployApp(config, sha, '/tmp/src', 'TEST-image').includes(
      'reportLocationEnabled=false',
    ),
  );
});

for (const ui of [false, true])
  for (const save of [false, true])
    test(`location UI/save flags remain independent: ${ui}/${save}`, () => {
      const options = {
        ...config,
        reportLocationUiEnabled: ui,
        reportLocationSaveEnabled: save,
      };
      const build = buildImage(options, 'mje-app', sha, '/tmp/src');
      assert.ok(build.includes(`VITE_REPORT_LOCATION_ENABLED=${ui}`));
      assert.ok(build.includes(`SOURCE_REVISION=${sha}`));
      const app = deployApp(options, sha, '/tmp/src', 'TEST-image');
      assert.ok(app.includes(`reportLocationEnabled=${save}`));
      const migration = buildImage(options, 'mje-migrate', sha, '/tmp/src');
      assert.equal(
        migration.some((arg) => arg.includes('VITE_REPORT_LOCATION_ENABLED')),
        false,
      );
      assert.equal(
        deployMigrationJob(options, sha, '/tmp/src', 'TEST-image').some((arg) =>
          arg.includes('reportLocationEnabled'),
        ),
        false,
      );
      assert.ok(build.includes('VITE_WEATHER_REFERENCE_ENABLED=false'));
      assert.equal(
        app.some((arg) =>
          /WEATHER_REFERENCE_ENABLED|weatherReferenceEnabled/i.test(arg),
        ),
        false,
      );
    });

test('location flags reach the build-stage bundle and runtime template with default off', () => {
  const docker = readFileSync(
    new URL('../Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(docker, /ARG VITE_REPORT_LOCATION_ENABLED=false/);
  assert.match(
    docker,
    /ENV VITE_REPORT_LOCATION_ENABLED=\$VITE_REPORT_LOCATION_ENABLED/,
  );
  assert.ok(
    docker.indexOf('ENV VITE_REPORT_LOCATION_ENABLED=') <
      docker.indexOf('pnpm build'),
  );
  const template = readFileSync(
    new URL('../infra/bicep/dev-owner-app.bicep', import.meta.url),
    'utf8',
  );
  assert.match(template, /param reportLocationEnabled bool = false/);
  assert.match(
    template,
    /name: 'REPORT_LOCATION_ENABLED', value: reportLocationEnabled \? 'true' : 'false'/,
  );
});

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
    { ...config, migrationJobName: 'test-migrate' },
    JSON.parse(`{"constructor":"x",${JSON.stringify(config).slice(1)}`),
    JSON.parse(`{"__proto__":"x",${JSON.stringify(config).slice(1)}`),
    JSON.parse(`{"toString":"x",${JSON.stringify(config).slice(1)}`),
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
  // Start and poll the job the template created, not a separately configured name.
  assert.deepEqual(job.slice(-4), [
    '--query',
    'properties.outputs.jobName.value',
    '-o',
    'tsv',
  ]);
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

test('failures report only our own stop messages, never an error text', () => {
  assert.equal(
    failureMessage(new DeployStop('the commit could not be resolved')),
    'dev-deploy stopped: the commit could not be resolved',
  );
  const leaky = new TypeError('token=TEST-SECRET-VALUE');
  assert.equal(failureMessage(leaky), 'dev-deploy failed: TypeError');
  assert.equal(failureMessage('TEST-SECRET-VALUE'), 'dev-deploy failed: error');
  assert.throws(
    () => parseArgs(['app', '--TEST-SECRET-VALUE']),
    (e: unknown) =>
      e instanceof DeployStop && !e.message.includes('TEST-SECRET-VALUE'),
  );
});

test('the script runs when started through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mje-deploy-test-'));
  try {
    const link = join(dir, 'deploy.mts');
    symlinkSync(SCRIPT, link);
    assert.equal(isEntryPoint(link, new URL(`file://${SCRIPT}`).href), true);
    assert.equal(isEntryPoint(SCRIPT, new URL(`file://${SCRIPT}`).href), true);
    assert.equal(
      isEntryPoint(join(dir, 'other.mts'), new URL(`file://${SCRIPT}`).href),
      false,
    );
    assert.equal(
      isEntryPoint(undefined, new URL(`file://${SCRIPT}`).href),
      false,
    );
    const r = spawnSync(process.execPath, [link, 'app', '--bogus'], {
      encoding: 'utf8',
    });
    assert.equal(
      r.status,
      1,
      'main ran and stopped (a silent exit 0 is the defect)',
    );
    assert.equal(r.stderr.trim(), 'dev-deploy stopped: unknown option');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad option or a failing subprocess prints a stop message only; stderr stays in the local log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mje-deploy-test-'));
  try {
    const secret = 'TEST-SECRET-' + 'x'.repeat(16);
    const bad = spawnSync(process.execPath, [SCRIPT, 'app', `--${secret}`], {
      encoding: 'utf8',
    });
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.trim(), 'dev-deploy stopped: unknown option');
    assert.ok(!(bad.stdout + bad.stderr).includes(secret));

    // A git that fails with secret-shaped stderr, and a valid synthetic config.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\necho "token=${secret}" >&2\nexit 7\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const configFile = join(dir, 'config.json');
    writeFileSync(configFile, JSON.stringify(config));
    const tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    const planted = join(dir, 'planted.log');
    writeFileSync(planted, '');
    symlinkSync(planted, join(tmp, 'mje-dev-deploy-errors.log'));
    const r = spawnSync(
      process.execPath,
      [SCRIPT, 'app', '--config', configFile, '--dry-run'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          TMPDIR: tmp,
        },
      },
    );
    assert.equal(r.status, 1);
    assert.ok(!(r.stdout + r.stderr).includes(secret), r.stdout + r.stderr);
    const m =
      /^dev-deploy stopped: git fetch failed \(exit 7\); details in (\S+)$/.exec(
        r.stderr.trim(),
      );
    assert.ok(m, r.stderr);
    assert.ok(!r.stderr.includes('    at '), 'no stack trace');
    const log = m[1] as string;
    // A per-run private directory and an exclusively created private file, inside TMPDIR.
    assert.ok(log.startsWith(join(tmp, 'mje-dev-deploy-errors-')), log);
    assert.equal(statSync(dirname(log)).mode & 0o777, 0o700);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    assert.ok(
      readFileSync(log, 'utf8').includes(secret),
      'details kept locally',
    );
    // The old predictable path is never written, even when something is planted there.
    assert.equal(readFileSync(planted, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('weather UI flag is explicit, independent and build-only', () => {
  for (const weather of [false, true]) {
    for (const location of [false, true]) {
      const options = {
        ...config,
        weatherReferenceUiEnabled: weather,
        reportLocationUiEnabled: location,
      };
      assert.deepEqual(validateConfig(options), options);
      const build = buildImage(options, 'mje-app', sha, '/tmp/src');
      assert.ok(build.includes(`VITE_WEATHER_REFERENCE_ENABLED=${weather}`));
      assert.ok(build.includes(`VITE_REPORT_LOCATION_ENABLED=${location}`));
      assert.equal(
        buildImage(options, 'mje-migrate', sha, '/tmp/src').some((arg) =>
          arg.includes('VITE_WEATHER_REFERENCE_ENABLED'),
        ),
        false,
      );
      assert.equal(
        deployApp(options, sha, '/tmp/src', 'TEST-image').some((arg) =>
          /WEATHER_REFERENCE_ENABLED|weatherReferenceEnabled/i.test(arg),
        ),
        false,
      );
      assert.equal(
        deployMigrationJob(options, sha, '/tmp/src', 'TEST-image').some((arg) =>
          /WEATHER_REFERENCE_ENABLED|weatherReferenceEnabled/i.test(arg),
        ),
        false,
      );
    }
  }
  for (const value of [undefined, null, 0, 1, 'false', 'true'])
    assert.throws(
      () => validateConfig({ ...config, weatherReferenceUiEnabled: value }),
      DeployStop,
    );
  const docker = readFileSync(
    new URL('../Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(docker, /ARG VITE_WEATHER_REFERENCE_ENABLED=false/);
  assert.match(
    docker,
    /ENV VITE_WEATHER_REFERENCE_ENABLED=\$VITE_WEATHER_REFERENCE_ENABLED/,
  );
  assert.ok(
    docker.indexOf('ENV VITE_WEATHER_REFERENCE_ENABLED=') <
      docker.indexOf('pnpm build'),
  );
});
