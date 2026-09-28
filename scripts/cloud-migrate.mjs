import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud migration configuration: ${name}`);
  return value;
}

// A missing managed identity must never fall back to prisma.config.ts's local URL.
const clientId = required('AZURE_CLIENT_ID');
const host = required('PGHOST');
const database = required('PGDATABASE');
const user = required('PGUSER');
if (
  process.env.NODE_ENV !== 'production' ||
  !/^mjeepc-dev-pg-[a-z0-9]+\.postgres\.database\.azure\.com$/.test(host) ||
  database !== 'mje' ||
  !/^mjeepc-dev-migration$/.test(user) ||
  process.env.ALPHA_DATABASE_URL ||
  process.env.DATABASE_URL
) {
  throw new Error(
    'Cloud migration target or identity is not the approved Dev shape',
  );
}

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { ManagedIdentityCredential } = await import(
  requireApi.resolve('@azure/identity')
);
const credential = new ManagedIdentityCredential({ clientId });
const token = await credential.getToken(
  'https://ossrdbms-aad.database.windows.net/.default',
);
if (!token?.token)
  throw new Error('Managed identity database token unavailable');
const url = new URL(`postgresql://${host}:5432/${database}`);
url.username = user;
url.password = token.token;
url.searchParams.set('schema', 'public');
url.searchParams.set('sslmode', 'verify-full');
url.searchParams.set('sslrootcert', '/etc/ssl/certs/ca-certificates.crt');

execFileSync(
  process.execPath,
  ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'inherit',
  },
);
console.log(
  'Dev schema migration completed; application principal bootstrap remains separate.',
);
