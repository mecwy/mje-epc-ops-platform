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
// Prints no secrets; az runs with the operator's own login.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  migrationJobName: string;
}
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
    else throw new DeployStop(`unknown option ${String(flag)}`);
  }
  return options;
}

/** Exactly the known keys, each in its expected shape; nothing else is accepted. */
export function validateConfig(raw: unknown): DeployConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new DeployStop('the deploy config is not a JSON object');
  const shapes: Record<keyof DeployConfig, RegExp> = {
    tenantId: GUID,
    subscriptionName: /^[A-Za-z0-9 _.-]{1,64}$/,
    resourceGroup: AZURE_NAME,
    registryName: STORAGE_OR_REGISTRY,
    postgresFqdn: POSTGRES_FQDN,
    apiClientId: GUID,
    spaClientId: GUID,
    storageAccountName: STORAGE_OR_REGISTRY,
    migrationJobName: AZURE_NAME,
  };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!(key in shapes))
      throw new DeployStop(`unknown deploy config key ${key}`);
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
    '--query',
    'properties.provisioningState',
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

// ---------- side effects (not unit-tested; dry-run prints instead of running az) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (file: string, args: readonly string[], cwd?: string) =>
  execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

async function main(options: Options) {
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (!existsSync(join(repo, options.config)) && !existsSync(options.config))
    throw new DeployStop(`deploy config not found: ${options.config}`);
  const configPath = existsSync(options.config)
    ? options.config
    : join(repo, options.config);
  const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const az = (args: string[]) => {
    if (options.dryRun) {
      console.log(`[dry-run] az ${args.join(' ')}`);
      return '';
    }
    return run('az', args);
  };

  run('git', ['-C', repo, 'fetch', '-q', 'origin']);
  const sha = run('git', [
    '-C',
    repo,
    'rev-parse',
    `${options.sha ?? 'origin/main'}^{commit}`,
  ]);
  if (!SHA.test(sha)) throw new DeployStop('the commit could not be resolved');
  try {
    run('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, 'origin/main']);
  } catch {
    throw new DeployStop('only a commit already on origin/main is deployed');
  }
  console.log(`commit = ${sha}`);

  if (!options.dryRun) {
    const tenant = run('az', [
      'account',
      'show',
      '--query',
      'tenantId',
      '-o',
      'tsv',
    ]);
    const name = run('az', ['account', 'show', '--query', 'name', '-o', 'tsv']);
    if (tenant !== config.tenantId || name !== config.subscriptionName)
      throw new DeployStop(
        'the signed-in az account is not the configured tenant and subscription',
      );
  }

  const source = mkdtempSync(join(tmpdir(), 'mje-deploy-'));
  const lines: string[] = [];
  try {
    const tar = execFileSync(
      'git',
      ['-C', repo, 'archive', '--format=tar', sha],
      {
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    execFileSync('tar', ['-x', '-C', source], { input: tar });
    if (existsSync(join(source, '.env')))
      throw new DeployStop('the exported source contains .env');

    const image = (repository: 'mje-migrate' | 'mje-app') => {
      az(buildImage(config, repository, sha, source));
      const digest = az(imageDigest(config, repository, sha));
      if (!options.dryRun && !/^sha256:[0-9a-f]{64}$/.test(digest))
        throw new DeployStop(`no digest for ${repository}:${sha}`);
      return `${config.registryName}.azurecr.io/${repository}@${digest || 'sha256:<dry-run>'}`;
    };

    if (options.command !== 'app') {
      const migrateImage = image('mje-migrate');
      az(deployMigrationJob(config, sha, source, migrateImage));
      const execution = az([
        'containerapp',
        'job',
        'start',
        '-n',
        config.migrationJobName,
        '-g',
        config.resourceGroup,
        '--query',
        'name',
        '-o',
        'tsv',
      ]);
      let status = '';
      if (!options.dryRun) {
        for (let i = 0; i < 60; i++) {
          status = az([
            'containerapp',
            'job',
            'execution',
            'show',
            '-n',
            config.migrationJobName,
            '-g',
            config.resourceGroup,
            '--job-execution-name',
            execution,
            '--query',
            'properties.status',
            '-o',
            'tsv',
          ]);
          console.log(`migration ${execution}: ${status || '(no status)'}`);
          const outcome = jobOutcome(status);
          if (outcome === 'ok') break;
          if (outcome === 'stop')
            throw new DeployStop(
              `migration ${status}; the app is not deployed`,
            );
          await sleep(10_000);
        }
        if (jobOutcome(status) !== 'ok')
          throw new DeployStop(
            'migration did not finish within 600 s; the app is not deployed',
          );
      }
      lines.push(
        `migration main@${sha.slice(0, 7)} (${migrateImage.split('@')[1]}) execution ${execution || '<dry-run>'}: ${status || 'dry-run'}`,
      );
    }

    if (options.command !== 'migrate') {
      const appImage = image('mje-app');
      const url = az(deployApp(config, sha, source, appImage));
      let smoke = 'dry-run';
      if (!options.dryRun) {
        if (!/^https:\/\/[a-z0-9.-]+$/i.test(url))
          throw new DeployStop('the app deployment returned no https URL');
        // Bounded wait (<= 120 s) for the new revision, so a cold start is not a failed smoke.
        let waited = 0;
        for (; waited <= 120; waited += 5) {
          const live = await fetch(`${url}/health/live`, {
            signal: AbortSignal.timeout(10_000),
          })
            .then((r) => r.text())
            .catch(() => '');
          if (live.includes(`"revision":"${sha}"`)) break;
          await sleep(5_000);
        }
        console.log(`revision wait ${Math.min(waited, 120)} s`);
        let out: string;
        try {
          out = run(process.execPath, [
            join(source, 'scripts/dev-smoke.mjs'),
            url,
            sha,
          ]);
        } catch (error) {
          out = String((error as { stdout?: unknown }).stdout ?? '').trim();
        }
        console.log(out);
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    // Our own stop messages only; anything else is reported by its type, never its details.
    console.error(
      error instanceof DeployStop
        ? `dev-deploy stopped: ${error.message}`
        : `dev-deploy failed: ${error instanceof Error ? error.name : 'error'}`,
    );
    process.exitCode = 1;
  });
}
