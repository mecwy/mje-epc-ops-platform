// Dev deployment from an exact commit of origin/main (owner-run; replaces the writers' scratchpad
// scripts b2-migrate / b3-app / w3-migrate-and-deploy):
//   node scripts/dev-deploy.mts <migrate|app|all> [--sha <commit>] [--config <file>]
//                               [--record <file>] [--dry-run]
// migrate: build the migration image, deploy the job, run it once and wait (bounded) for it.
// app:     build the app image, deploy dev-owner-app.bicep, wait for /health/live to report the
//          commit, then run the no-login smoke (scripts/dev-smoke.mjs).
// all:     migrate, and only if the execution Succeeded, app.
// Environment identifiers (tenant, subscription, registry, server, client ids) come from a local
// config file that is never committed (default private/dev-deploy.json; values are kept in the
// private runbook). The signed-in az account must be that tenant and subscription. Only a commit
// already on origin/main is built, from a `git archive` export (no working-tree files, no .env).
// az runs with the operator's own login. Output: own progress and stop messages, the migration
// execution status, the az commands of a dry-run, and the smoke's one-line JSON summary (statuses,
// counts, asset names; by design no credentials or response bodies). The stderr of git / az / the
// smoke is captured, never printed, and kept in a per-run private error log (directory 0700, file
// 0600, created exclusively; its path is printed). Every wait has an elapsed-time deadline and
// every subprocess a timeout.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DeployConfig {
  tenantId: string;
  subscriptionName: string;
  resourceGroup: string;
  registryName: string;
  postgresFqdn: string;
  apiClientId: string;
  spaClientId: string;
  storageAccountName: string;
  reportLocationUiEnabled?: boolean;
  reportLocationSaveEnabled?: boolean;
  weatherReferenceUiEnabled?: boolean;
}
const LOCATION_FLAGS = [
  'reportLocationUiEnabled',
  'reportLocationSaveEnabled',
  'weatherReferenceUiEnabled',
] as const;
export type Command = 'migrate' | 'app' | 'all';
export interface Options {
  command: Command;
  sha: string | null;
  config: string;
  record: string | null;
  dryRun: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AZURE_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const STORAGE_OR_REGISTRY = /^[a-z0-9]{3,50}$/;
const POSTGRES_FQDN = /^[a-z0-9-]+\.postgres\.database\.azure\.com$/;
const SHA = /^[0-9a-f]{40}$/;

export class DeployStop extends Error {}

export function parseArgs(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  if (command !== 'migrate' && command !== 'app' && command !== 'all')
    throw new DeployStop(
      'usage: dev-deploy.mts <migrate|app|all> [--sha <commit>] [--config <file>] [--record <file>] [--dry-run]',
    );
  const options: Options = {
    command,
    sha: null,
    config: 'private/dev-deploy.json',
    record: null,
    dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--'))
        throw new DeployStop(`${flag} needs a value`);
      return v;
    };
    if (flag === '--sha') options.sha = value();
    else if (flag === '--config') options.config = value();
    else if (flag === '--record') options.record = value();
    else if (flag === '--dry-run') options.dryRun = true;
    // The value is not echoed: a mistyped argument may be something the operator pasted.
    else throw new DeployStop('unknown option');
  }
  return options;
}

/** Exactly the known keys, each in its expected shape; nothing else is accepted. */
export function validateConfig(raw: unknown): DeployConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new DeployStop('the deploy config is not a JSON object');
  const shapes: Record<
    Exclude<keyof DeployConfig, (typeof LOCATION_FLAGS)[number]>,
    RegExp
  > = {
    tenantId: GUID,
    subscriptionName: /^[A-Za-z0-9 _.-]{1,64}$/,
    resourceGroup: AZURE_NAME,
    registryName: STORAGE_OR_REGISTRY,
    postgresFqdn: POSTGRES_FQDN,
    apiClientId: GUID,
    spaClientId: GUID,
    storageAccountName: STORAGE_OR_REGISTRY,
  };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (
      !Object.hasOwn(shapes, key) &&
      !LOCATION_FLAGS.some((flag) => flag === key)
    )
      throw new DeployStop(`unknown deploy config key ${key}`);
  for (const key of LOCATION_FLAGS)
    if (Object.hasOwn(record, key) && typeof record[key] !== 'boolean')
      throw new DeployStop(`deploy config ${key} must be a boolean`);
  for (const [key, shape] of Object.entries(shapes)) {
    const v = record[key];
    if (typeof v !== 'string' || !shape.test(v))
      throw new DeployStop(`deploy config ${key} is missing or malformed`);
  }
  return record as unknown as DeployConfig;
}

/** The az invocations, as argument vectors (never a shell string). */
export function buildImage(
  c: DeployConfig,
  repository: 'mje-migrate' | 'mje-app',
  sha: string,
  source: string,
): string[] {
  return [
    'acr',
    'build',
    '-r',
    c.registryName,
    '-t',
    `${repository}:${sha}`,
    '-f',
    repository === 'mje-migrate' ? 'Dockerfile.migrate' : 'Dockerfile',
    '--platform',
    'linux/amd64',
    ...(repository === 'mje-app'
      ? [
          '--build-arg',
          `VITE_REPORT_LOCATION_ENABLED=${c.reportLocationUiEnabled === true}`,
          '--build-arg',
          `VITE_WEATHER_REFERENCE_ENABLED=${c.weatherReferenceUiEnabled === true}`,
        ]
      : []),
    '--build-arg',
    `SOURCE_REVISION=${sha}`,
    source,
    '--no-logs',
    '-o',
    'none',
  ];
}
export function imageDigest(
  c: DeployConfig,
  repository: string,
  sha: string,
): string[] {
  return [
    'acr',
    'repository',
    'show',
    '-n',
    c.registryName,
    '--image',
    `${repository}:${sha}`,
    '--query',
    'digest',
    '-o',
    'tsv',
  ];
}
export function deployMigrationJob(
  c: DeployConfig,
  sha: string,
  source: string,
  image: string,
): string[] {
  return [
    'deployment',
    'group',
    'create',
    '-g',
    c.resourceGroup,
    '-n',
    `migrate-${sha.slice(0, 7)}`,
    '-f',
    join(source, 'infra/bicep/dev-migration-job.bicep'),
    '-p',
    `registryName=${c.registryName}`,
    `postgresFqdn=${c.postgresFqdn}`,
    `imageReference=${image}`,
    // The job the template created (its `jobName` output): start and poll exactly that job.
    '--query',
    'properties.outputs.jobName.value',
    '-o',
    'tsv',
  ];
}
export function deployApp(
  c: DeployConfig,
  sha: string,
  source: string,
  image: string,
): string[] {
  return [
    'deployment',
    'group',
    'create',
    '-g',
    c.resourceGroup,
    '-n',
    `app-${sha.slice(0, 7)}`,
    '-f',
    join(source, 'infra/bicep/dev-owner-app.bicep'),
    '-p',
    `registryName=${c.registryName}`,
    `postgresFqdn=${c.postgresFqdn}`,
    `tenantId=${c.tenantId}`,
    `apiClientId=${c.apiClientId}`,
    `spaClientId=${c.spaClientId}`,
    `imageReference=${image}`,
    `sourceRevision=${sha}`,
    `storageAccountName=${c.storageAccountName}`,
    `reportLocationEnabled=${c.reportLocationSaveEnabled === true}`,
    '--query',
    'properties.outputs.url.value',
    '-o',
    'tsv',
  ];
}

/** A job execution status: keep waiting, succeeded, or stop (anything unknown stops). */
export function jobOutcome(status: string): 'wait' | 'ok' | 'stop' {
  if (status === 'Succeeded') return 'ok';
  if (status === 'Running' || status === 'Processing' || status === '')
    return 'wait';
  return 'stop';
}

/** Our own stop messages only; anything else is reported by its type, never its details. */
export function failureMessage(error: unknown): string {
  return error instanceof DeployStop
    ? `dev-deploy stopped: ${error.message}`
    : `dev-deploy failed: ${error instanceof Error ? error.name : 'error'}`;
}

/** True when this module is the program being run, also through a symlink. */
export function isEntryPoint(
  argv1: string | undefined,
  moduleUrl: string,
): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// ---------- side effects (dry-run prints az commands instead of running them) ----------
/**
 * Raw stderr of failed steps, which may carry anything a tool printed: a per-run directory created
 * with mkdtemp (0700) and a log created exclusively in it (0600), so it is never a predictable,
 * shared or pre-existing path. Kept after the run (outside the source cleanup).
 */
let errorLog: string | null = null;
export function logError(label: string, stderr: unknown): string {
  if (!errorLog) {
    const dir = mkdtempSync(join(tmpdir(), 'mje-dev-deploy-errors-'));
    chmodSync(dir, 0o700);
    const file = join(dir, 'errors.log');
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    errorLog = file;
  }
  appendFileSync(
    errorLog,
    `${new Date().toISOString()} ${label}\n${String(stderr ?? '')}\n`,
  );
  return errorLog;
}
const MINUTE = 60_000;
const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Runs a subprocess with a timeout; stderr is captured. On failure the details go to the local
 * error log and only `label` and the kind of failure are reported.
 */
function run(
  label: string,
  file: string,
  args: readonly string[],
  timeoutMs: number,
  input?: Buffer,
): Buffer {
  try {
    return execFileSync(file, args, {
      ...(input ? { input } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: Math.max(1, timeoutMs),
      killSignal: 'SIGKILL',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    const e = error as {
      status?: number | null;
      signal?: string | null;
      stderr?: Buffer;
    };
    const log = logError(label, e.stderr);
    const why = e.signal
      ? 'timed out or was stopped'
      : `failed (exit ${String(e.status)})`;
    throw new DeployStop(`${label} ${why}; details in ${log}`);
  }
}
const text = (b: Buffer) => b.toString('utf8').trim();

async function main(options: Options) {
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const configPath = [options.config, join(repo, options.config)].find((p) =>
    existsSync(p),
  );
  if (!configPath) throw new DeployStop('deploy config not found');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new DeployStop('the deploy config is not valid JSON');
  }
  const config = validateConfig(raw);
  const az = (label: string, args: string[], timeoutMs = 5 * MINUTE) => {
    if (options.dryRun) {
      console.log(`[dry-run] az ${args.join(' ')}`);
      return '';
    }
    return text(run(`az ${label}`, 'az', args, timeoutMs));
  };
  const git = (label: string, args: string[]) =>
    run(`git ${label}`, 'git', ['-C', repo, ...args], 2 * MINUTE);

  git('fetch', ['fetch', '-q', 'origin']);
  const sha = text(
    git('rev-parse', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${options.sha ?? 'origin/main'}^{commit}`,
    ]),
  );
  if (!SHA.test(sha)) throw new DeployStop('the commit could not be resolved');
  try {
    git('merge-base', ['merge-base', '--is-ancestor', sha, 'origin/main']);
  } catch {
    throw new DeployStop('only a commit already on origin/main is deployed');
  }
  console.log(`commit = ${sha}`);

  if (!options.dryRun) {
    const account = az('account show', [
      'account',
      'show',
      '--query',
      '[tenantId, name]',
      '-o',
      'tsv',
    ]).split('\n');
    if (
      account[0] !== config.tenantId ||
      account[1] !== config.subscriptionName
    )
      throw new DeployStop(
        'the signed-in az account is not the configured tenant and subscription',
      );
  }

  const source = mkdtempSync(join(tmpdir(), 'mje-deploy-'));
  const lines: string[] = [];
  try {
    const tar = git('archive', ['archive', '--format=tar', sha]);
    run('tar -x', 'tar', ['-x', '-C', source], 2 * MINUTE, tar);
    if (existsSync(join(source, '.env')))
      throw new DeployStop('the exported source contains .env');

    const image = (repository: 'mje-migrate' | 'mje-app') => {
      az('acr build', buildImage(config, repository, sha, source), 30 * MINUTE);
      const digest = az(
        'acr repository show',
        imageDigest(config, repository, sha),
      );
      if (!options.dryRun && !/^sha256:[0-9a-f]{64}$/.test(digest))
        throw new DeployStop(`no digest for ${repository}:${sha}`);
      return `${config.registryName}.azurecr.io/${repository}@${digest || 'sha256:<dry-run>'}`;
    };

    if (options.command !== 'app') {
      const migrateImage = image('mje-migrate');
      const job =
        az(
          'deployment group create (migration job)',
          deployMigrationJob(config, sha, source, migrateImage),
          15 * MINUTE,
        ) || '<dry-run>';
      if (!options.dryRun && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(job))
        throw new DeployStop('the migration deployment returned no job name');
      const execution = az('containerapp job start', [
        'containerapp',
        'job',
        'start',
        '-n',
        job,
        '-g',
        config.resourceGroup,
        '--query',
        'name',
        '-o',
        'tsv',
      ]);
      let status = '';
      if (!options.dryRun) {
        if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(execution))
          throw new DeployStop('the job start returned no execution name');
        // Elapsed-time deadline: 600 s in all, each poll bounded by what is left.
        const deadline = Date.now() + 10 * MINUTE;
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          status = az(
            'containerapp job execution show',
            [
              'containerapp',
              'job',
              'execution',
              'show',
              '-n',
              job,
              '-g',
              config.resourceGroup,
              '--job-execution-name',
              execution,
              '--query',
              'properties.status',
              '-o',
              'tsv',
            ],
            Math.min(MINUTE, left),
          );
          console.log(`migration ${execution}: ${status || '(no status)'}`);
          const outcome = jobOutcome(status);
          if (outcome === 'ok') break;
          if (outcome === 'stop')
            throw new DeployStop(
              `migration ${status}; the app is not deployed`,
            );
          await sleep(Math.min(10_000, deadline - Date.now()));
        }
        if (jobOutcome(status) !== 'ok')
          throw new DeployStop(
            'migration did not finish within 600 s; the app is not deployed',
          );
      }
      lines.push(
        `migration main@${sha.slice(0, 7)} (${migrateImage.split('@')[1]}) job ${job} execution ${execution || '<dry-run>'}: ${status || 'dry-run'}`,
      );
    }

    if (options.command !== 'migrate') {
      const appImage = image('mje-app');
      const url = az(
        'deployment group create (app)',
        deployApp(config, sha, source, appImage),
        15 * MINUTE,
      );
      let smoke = 'dry-run';
      if (!options.dryRun) {
        if (!/^https:\/\/[a-z0-9.-]+$/i.test(url))
          throw new DeployStop('the app deployment returned no https URL');
        // Elapsed-time deadline (120 s) for the new revision, so a cold start is not a failed
        // smoke; each request is bounded by what is left.
        const started = Date.now();
        const deadline = started + 2 * MINUTE;
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0) break;
          const live = await fetch(`${url}/health/live`, {
            signal: AbortSignal.timeout(Math.min(10_000, left)),
          })
            .then((r) => r.text())
            .catch(() => '');
          if (live.includes(`"revision":"${sha}"`)) break;
          await sleep(Math.min(5_000, deadline - Date.now()));
        }
        console.log(
          `revision wait ${Math.round((Date.now() - started) / 1000)} s`,
        );
        let out = '';
        try {
          out = text(
            execFileSync(
              process.execPath,
              [join(source, 'scripts/dev-smoke.mjs'), url, sha],
              {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 3 * MINUTE,
                killSignal: 'SIGKILL',
              },
            ),
          );
        } catch (error) {
          // The smoke exits 1 on a failed check; its stdout is still its one JSON summary.
          const e = error as { stdout?: Buffer; stderr?: Buffer };
          out = text(e.stdout ?? Buffer.alloc(0));
          console.log(`smoke stderr kept in ${logError('smoke', e.stderr)}`);
        }
        const parsed = (() => {
          try {
            return JSON.parse(out) as {
              ok?: boolean;
              checks?: number;
              failed?: unknown[];
            };
          } catch {
            return null;
          }
        })();
        if (parsed) console.log(out);
        smoke = parsed
          ? `smoke ok=${String(parsed.ok)} ${String(parsed.checks)} checks, ${String(parsed.failed?.length ?? '?')} failed`
          : 'smoke output unreadable';
        if (!parsed?.ok) process.exitCode = 1;
      }
      lines.push(
        `app main@${sha.slice(0, 7)} (${appImage.split('@')[1]}): ${smoke}`,
      );
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }

  const summary = `${new Date().toISOString()} dev-deploy ${options.command}: ${lines.join('; ')}`;
  console.log(summary);
  if (options.record && !options.dryRun)
    appendFileSync(options.record, `- ${summary}\n`);
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  void (async () => {
    try {
      // Arguments are parsed inside the same boundary: a bad option is a stop message too.
      await main(parseArgs(process.argv.slice(2)));
    } catch (error) {
      console.error(failureMessage(error));
      process.exitCode = 1;
    }
  })();
}
