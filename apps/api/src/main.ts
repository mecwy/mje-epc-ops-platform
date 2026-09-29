import { Pool } from 'pg';
import { ManagedIdentityCredential } from '@azure/identity';
import { AlphaStore, IssueStore, ReportStore } from '@mje/domain';
import { createApp, type AlphaRuntime } from './app.js';
import { TokenVerifier } from './auth/token-verifier.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
let runtime: AlphaRuntime | undefined;
let pool: Pool | undefined;
if (process.env['ALPHA_ENABLED'] === 'true') {
  const auth = {
    tenantId: required('ENTRA_TENANT_ID'),
    audience: required('ENTRA_API_CLIENT_ID'),
    clientId: required('ENTRA_SPA_CLIENT_ID'),
    scope: 'access_as_user',
  };
  const verifier = new TokenVerifier(auth);
  if (process.env['AZURE_CLIENT_ID']) {
    const credential = new ManagedIdentityCredential({
      clientId: process.env['AZURE_CLIENT_ID'],
    });
    pool = new Pool({
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
  } else {
    if (process.env['NODE_ENV'] === 'production')
      throw new Error('Managed identity is required for deployed Alpha');
    pool = new Pool({
      connectionString: required('ALPHA_DATABASE_URL'),
      max: 5,
      connectionTimeoutMillis: 5000,
    });
  }
  const roles = await pool.query<{
    unsafe: boolean;
  }>(`SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS
    (SELECT 1 FROM pg_class c WHERE c.relname IN ('DailyClose','Revision','AlphaDraft','DailyReportDraft','PlanVersion','AuditLog','Issue','IssueNote') AND pg_has_role(current_user,c.relowner,'USAGE'))) AS unsafe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (roles.rows[0]?.unsafe !== false)
    throw new Error(
      'Application database login must be non-owner without RLS bypass',
    );
  runtime = {
    auth,
    verifier,
    store: new AlphaStore(pool),
    reportStore: new ReportStore(pool),
    issueStore: new IssueStore(pool),
  };
}
const app = await createApp(runtime);
await app.listen(
  Number(process.env['PORT'] ?? 3300),
  process.env['HOST'] ?? '127.0.0.1',
);
if (pool) {
  const database = pool;
  process.once('SIGTERM', () => {
    void database.end();
  });
  process.once('SIGINT', () => {
    void database.end();
  });
}
