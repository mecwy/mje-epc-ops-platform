import { Pool } from 'pg';
import { ManagedIdentityCredential } from '@azure/identity';
import { AzurePhotoBlobStore } from './photo-blobs.js';

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
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
      throw new Error('Managed identity is required for deployed blob access');
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
    throw new Error('Managed identity is required for deployed Alpha');
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
    (SELECT 1 FROM pg_class c WHERE c.relname IN ('DailyClose','Revision','AlphaDraft','DailyReportDraft','PlanVersion','AuditLog','Issue','IssueNote','PhotoEvidence','EvidenceLink','Person','Crew','CrewAssignment','ProjectRoster','FieldEntryCode','FieldDevice','FieldTokenHash','FieldConfirmChallenge','FieldPersonConfirm','FieldDeviceEvent','FieldThrottle','FieldThrottleSalt','ProjectSiteReference','ProjectFieldSetting','FieldDay','WorkerCheckIn','FieldSelfie','CheckInSelfie','ForemanReport','ForemanReportRevision','ForemanAdoption') AND pg_has_role(current_user,c.relowner,'USAGE'))) AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (roles.rows[0]?.unsafe !== false)
    throw new Error(
      'Application database login must be non-owner without RLS bypass',
    );
}
