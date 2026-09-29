// Local development only: runs the real API against a local TEST database with a locally
// signed token, so the web app can be exercised without Entra. Refuses any non-local database.
// Usage: pnpm build && node --env-file=.env scripts/dev-report-server.mjs [--reset]
// Then open the printed http://localhost:5178/#dev-token=… link while `pnpm --filter @mje/web dev` runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { AlphaStore, ReportStore } from '../packages/domain/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(
  requireApi.resolve('jose')
);
const source = new URL(process.env.DATABASE_URL);
assert.ok(
  ['localhost', '127.0.0.1'].includes(source.hostname),
  'dev server only accepts a local database',
);
const database = 'mje_report_dev';
const role = 'mje_dev_app';
// Stable TEST identifiers so a restarted server keeps the same seeded rows.
const id = (name) => {
  const h = createHash('sha256').update(`mje-dev:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const admin = new Pool({ connectionString: source.toString() });
if (process.argv.includes('--reset'))
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
  database,
]);
const target = new URL(source);
target.pathname = `/${database}`;
if (!exists.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
execFileSync('pnpm', ['db:migrate'], {
  env: { ...process.env, DATABASE_URL: target.toString() },
  stdio: 'pipe',
});
const password = randomBytes(18).toString('hex');
const roleExists = await admin.query(
  'SELECT 1 FROM pg_roles WHERE rolname=$1',
  [role],
);
await admin.query(
  roleExists.rowCount
    ? `ALTER ROLE "${role}" PASSWORD '${password}'`
    : `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
);
await admin.end();
const owner = new Pool({ connectionString: target.toString() });
await owner.query(`GRANT mje_alpha_app TO "${role}"`);

const tenantId = id('tenant'),
  audience = id('audience'),
  clientId = id('client');
const org = id('org'),
  project = id('project'),
  pmPerson = id('pm-person'),
  execPerson = id('exec-person'),
  pmAccount = id('pm-account'),
  execAccount = id('exec-account'),
  pmObject = id('pm-object'),
  execObject = id('exec-object'),
  seed = id('seed');
const q = (sql, params) => owner.query(sql, params);
await q(
  'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3) ON CONFLICT DO NOTHING',
  [org, 'TEST Organization', seed],
);
for (const [pid, name] of [
  [pmPerson, 'TEST 项目经理'],
  [execPerson, 'TEST 总经理'],
])
  await q(
    'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4) ON CONFLICT DO NOTHING',
    [pid, org, seed, name],
  );
await q(
  'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$5,\'Europe/Belgrade\',\'ACTIVE\') ON CONFLICT DO NOTHING',
  [project, org, seed, 'TEST-R11', 'TEST 屋顶光伏 3.0MWp'],
);
for (const [aid, pid, oid] of [
  [pmAccount, pmPerson, pmObject],
  [execAccount, execPerson, execObject],
])
  await q(
    'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6) ON CONFLICT DO NOTHING',
    [aid, org, seed, tenantId, oid, pid],
  );
for (const [mid, aid, r, pid] of [
  [id('m-pm'), pmAccount, 'PROJECT_MANAGER', project],
  [id('m-exec'), execAccount, 'EXECUTIVE_READER', null],
])
  await q(
    'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now(),$5,$6) ON CONFLICT DO NOTHING',
    [mid, org, seed, r, aid, pid],
  );

const appUrl = new URL(target);
appUrl.username = role;
appUrl.password = password;
const pool = new Pool({ connectionString: appUrl.toString(), max: 5 });
const reportStore = new ReportStore(pool);
const pmIdentity = { tenantId, objectId: pmObject };
const items = await reportStore.getItems(pmIdentity, project);
if (!items.length) {
  // Synthetic TEST master data; labels are message keys so the UI shows them in each language.
  const work = [
    ['support', 'itSupport', 'set', '9600'],
    ['modules', 'itModules', 'pcs', '5400'],
    ['dcCable', 'itDcCable', 'm', '42000'],
    ['tray', 'itTray', 'm', '2600'],
    ['acCable', 'itAcCable', 'm', '3300'],
    ['cabinet', 'itCabinet', 'unit', '6'],
    ['rail', 'itRail', 'm', '16800'],
    ['invSupport', 'itInvSupport', 'set', '18'],
    ['inverter', 'itInverter', 'unit', '18'],
  ].map(([key, label, unit, designQty], i) => ({
    kind: 'work',
    key,
    label,
    unit,
    designQty,
    openingCumulative: '',
    sortOrder: i,
    active: true,
  }));
  const machinery = ['boomLift', 'crane', 'truck'].map((key, i) => ({
    kind: 'machinery',
    key,
    label: `mc_${key}`,
    unit: '',
    designQty: '',
    openingCumulative: '',
    sortOrder: i,
    active: true,
  }));
  const materials = [
    ['support', 'itSupport', 'set', '9600', '5000'],
    ['modules', 'itModules', 'pcs', '5400', '3000'],
    ['rail', 'itRail', 'm', '16800', '12000'],
  ].map(([key, label, unit, designQty, openingCumulative], i) => ({
    kind: 'material',
    key,
    label,
    unit,
    designQty,
    openingCumulative,
    sortOrder: i,
    active: true,
  }));
  await reportStore.saveItems(pmIdentity, {
    projectId: project,
    clientMutationId: randomUUID(),
    items: [...work, ...machinery, ...materials],
  });
  // A confirmed plan for today so the fill page has a baseline.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
  }).format(new Date());
  await reportStore.savePlanDraft(pmIdentity, {
    projectId: project,
    targetBusinessDate: today,
    clientMutationId: randomUUID(),
    rows: [
      { item: 'support', target: '300' },
      { item: 'modules', target: '200' },
    ],
  });
  await reportStore.confirmPlan(pmIdentity, {
    projectId: project,
    targetBusinessDate: today,
    clientMutationId: randomUUID(),
  });
}

const keys = await generateKeyPair('RS256');
const key = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'DEV' };
const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [key] }));
const app = await createApp({
  auth,
  verifier,
  store: new AlphaStore(pool),
  reportStore,
});
await app.listen(3300, '127.0.0.1');
const token = async (oid) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: tenantId,
    oid,
    azp: clientId,
    scp: 'access_as_user',
    ver: '2.0',
    sub: 'TEST-dev',
    iat: now,
    nbf: now - 1,
    exp: now + 12 * 3600,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    aud: audience,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'DEV' })
    .sign(keys.privateKey);
};
console.log('TEST dev API on http://127.0.0.1:3300 (local database only)');
console.log(
  `project manager: http://localhost:5178/#dev-token=${await token(pmObject)}`,
);
console.log(
  `executive:       http://localhost:5178/#dev-token=${await token(execObject)}`,
);
const stop = async () => {
  await app.close();
  await pool.end();
  await owner.end();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
