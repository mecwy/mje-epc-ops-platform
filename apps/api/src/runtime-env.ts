import { Pool } from 'pg';
import { ManagedIdentityCredential } from '@azure/identity';
import { AzurePhotoBlobStore } from './photo-blobs.js';
import {
  claimWeatherJob,
  createMetForecastCacheGate,
  deferWeatherJob,
  failWeatherJob,
  finishWeatherJob,
} from '@mje/domain';
import { createWeatherRuntime } from '@mje/worker/weather-runtime';
import { runWeatherOnce } from '@mje/worker/weather-worker';
import { createMetNorwayTransport } from '@mje/worker/met-norway-transport';
type WeatherRuntime = ReturnType<typeof createWeatherRuntime>;

/** A refusal to start on this configuration, named by a fixed code (never by a value). */
export class ConfigError extends Error {
  constructor(
    public readonly code:
      | 'MISSING_CONFIGURATION'
      | 'IDENTITY_REQUIRED'
      | 'UNSAFE_DATABASE_LOGIN'
      | 'WEATHER_DEV_CONFIGURATION_REQUIRED',
    /** The configuration name concerned (a fixed identifier), if any. */
    public readonly field?: string,
  ) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'ConfigError';
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError('MISSING_CONFIGURATION', name);
  return value;
}

/** Dev-only temporary embedded consumer. NODE_ENV is also production in the Dev image. */
export function weatherConsumerConfig(
  env: NodeJS.ProcessEnv,
): { orgId: string; userAgent: string } | undefined {
  if (env['WEATHER_REFERENCE_ENABLED'] !== 'true') return undefined;
  if (env['MJE_DEPLOYMENT_ENV'] !== 'dev' || env['ALPHA_ENABLED'] !== 'true')
    throw new ConfigError('WEATHER_DEV_CONFIGURATION_REQUIRED');
  const orgId = env['WEATHER_WORKER_ORG_ID'];
  if (
    !orgId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      orgId,
    )
  )
    throw new ConfigError('MISSING_CONFIGURATION', 'WEATHER_WORKER_ORG_ID');
  const userAgent = env['WEATHER_MET_USER_AGENT'];
  if (
    !userAgent ||
    userAgent.length > 300 ||
    /[\r\n]/.test(userAgent) ||
    !/(https:\/\/[^\s)]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i.test(userAgent)
  )
    throw new ConfigError('MISSING_CONFIGURATION', 'WEATHER_MET_USER_AGENT');
  return { orgId, userAgent };
}

/** Safe package exits only; constructing an off runtime does not claim or fetch. */
export function weatherRuntimeFromEnv(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): WeatherRuntime | undefined {
  const config = weatherConsumerConfig(env);
  if (!config) return undefined;
  const execute = createMetNorwayTransport({
    userAgent: config.userAgent,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date().toISOString(),
    gate: createMetForecastCacheGate(pool, config.orgId),
  });
  return createWeatherRuntime({
    enabled: true,
    deploymentEnvironment: 'dev',
    businessOrgId: config.orgId,
    runOnce: (orgId, signal) =>
      runWeatherOnce(
        {
          enabled: true,
          jobs: {
            claim: () => claimWeatherJob(pool, orgId),
            defer: (lease, retryAfterSeconds) =>
              deferWeatherJob(pool, lease, retryAfterSeconds),
            finish: (lease, draft) =>
              finishWeatherJob(pool, lease, draft, {
                adapterVersion: 'met-norway-locationforecast-v1',
                sourceLink:
                  'https://api.met.no/weatherapi/locationforecast/2.0/documentation',
                licenseLink: 'https://api.met.no/doc/License',
              }),
            fail: (lease, code, retryAfterSeconds) =>
              failWeatherJob(pool, lease, code, retryAfterSeconds),
          },
          execute,
        },
        signal,
      ),
  });
}

/** Nest drains HTTP between these two hooks. No independent signal handler closes the pool. */
export function applicationResourceLifecycle(resources: {
  weather?: Pick<WeatherRuntime, 'stop'>;
  closePool: () => Promise<void>;
}) {
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= Promise.resolve().then(() => resources.weather?.stop()));
  return {
    beforeApplicationShutdown: stop,
    onApplicationShutdown: () => {
      closing ??= stop().finally(() => resources.closePool());
      return closing;
    },
  };
}

/**
 * Photo bytes: in Azure the app's managed identity on BLOB_ACCOUNT_URL (container "evidence",
 * created by infrastructure, role Storage Blob Data Contributor on it); locally the Azurite
 * connection string. Without either, the photo routes are not served.
 */
export async function photoBlobsFromEnv(): Promise<
  AzurePhotoBlobStore | undefined
> {
  const container = process.env['BLOB_EVIDENCE_CONTAINER'] || undefined;
  if (process.env['AZURE_CLIENT_ID'] && process.env['BLOB_ACCOUNT_URL'])
    return AzurePhotoBlobStore.fromAccountUrl(
      process.env['BLOB_ACCOUNT_URL'],
      new ManagedIdentityCredential({
        clientId: process.env['AZURE_CLIENT_ID'],
      }),
      container,
    );
  if (process.env['BLOB_CONNECTION_STRING']) {
    if (process.env['NODE_ENV'] === 'production')
      throw new ConfigError('IDENTITY_REQUIRED', 'BLOB_ACCOUNT_URL');
    const local = AzurePhotoBlobStore.fromConnectionString(
      process.env['BLOB_CONNECTION_STRING'],
      container,
    );
    await local.ensureContainer();
    return local;
  }
  return undefined;
}

/** The application database: the managed identity's token in Azure, ALPHA_DATABASE_URL locally. */
export function databasePoolFromEnv(): Pool {
  if (process.env['AZURE_CLIENT_ID']) {
    const credential = new ManagedIdentityCredential({
      clientId: process.env['AZURE_CLIENT_ID'],
    });
    return new Pool({
      host: required('PGHOST'),
      database: required('PGDATABASE'),
      user: required('PGUSER'),
      port: 5432,
      password: async () =>
        (
          await credential.getToken(
            'https://ossrdbms-aad.database.windows.net/.default',
          )
        ).token,
      ssl: { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
  }
  if (process.env['NODE_ENV'] === 'production')
    throw new ConfigError('IDENTITY_REQUIRED', 'PGHOST');
  return new Pool({
    connectionString: required('ALPHA_DATABASE_URL'),
    max: 5,
    connectionTimeoutMillis: 5000,
  });
}

/** Refuses an owner, superuser or RLS-bypassing login: row security must apply to the app. */
export async function assertApplicationLogin(pool: Pool): Promise<void> {
  const roles = await pool.query<{
    unsafe: boolean;
  }>(`SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS
    (SELECT 1 FROM pg_class c WHERE c.relname IN ('DailyClose','Revision','AlphaDraft','DailyReportDraft','PlanVersion','AuditLog','Issue','IssueNote','PhotoEvidence','EvidenceLink','Person','Crew','CrewAssignment','ProjectRoster','FieldEntryCode','FieldDevice','FieldTokenHash','FieldConfirmChallenge','FieldPersonConfirm','FieldDeviceEvent','FieldThrottle','FieldThrottleSalt','ProjectSiteReference','ProjectFieldSetting','FieldDay','WorkerCheckIn','FieldSelfie','CheckInSelfie','ForemanReport','ForemanReportRevision','ForemanAdoption','WeatherLocationVersion','WeatherRequest','WeatherSnapshot','WeatherReportReference','ReportLocationRecord','OutboxEvent','MetForecastCache','MetForecastCooldown') AND pg_has_role(current_user,c.relowner,'USAGE'))) AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (roles.rows[0]?.unsafe !== false)
    throw new ConfigError('UNSAFE_DATABASE_LOGIN');
}
