// Local development only: runs the real API against a local TEST database with a locally
// signed token, so the web app can be exercised without Entra. Refuses any non-local database.
// Usage: pnpm build && node --env-file=.env scripts/dev-report-server.mjs [--reset]
// Then open the printed http://localhost:5178/#dev-token=… link while `pnpm --filter @mje/web dev` runs.
// A second copy can run beside the first (another worktree) with DEV_INSTANCE=<name>: its own
// database, login role and blob container; DEV_API_PORT / DEV_WEB_PORT move its ports.
// Photos use the local blob emulator (Azurite, BLOB_CONNECTION_STRING) in its own private
// container; without a local emulator connection the photo routes are simply not served.
// The field slice (A6) is served too: a TEST crew (one foreman, three workers), a TEST site
// reference at 1.000000, 1.000000 (radius 500 m; never a real place) and an entry code, whose
// /field/#e=… link is printed. Browsers can emulate that position for local checks.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { assertLocalBlob, assertLocalDatabase } from './local-db.mjs';
import {
  AlphaStore,
  CheckInStore,
  FieldStore,
  ForemanStore,
  IssueStore,
  PhotoStore,
  ReportStore,
  reportReader,
} from '../packages/domain/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { AzurePhotoBlobStore } from '../apps/api/dist/photo-blobs.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import(
  requireApi.resolve('jose')
);
const source = assertLocalDatabase(process.env.DATABASE_URL);
// Only the local emulator on loopback; never a cloud storage account.
const blobConnection = process.env.BLOB_CONNECTION_STRING ?? '';
if (blobConnection) assertLocalBlob(blobConnection);
const instance = process.env.DEV_INSTANCE ?? '';
if (!/^[a-z0-9]{0,12}$/.test(instance))
  throw new Error('DEV_INSTANCE: up to 12 lowercase letters or digits');
const suffix = instance ? `_${instance}` : '';
const port = (name, fallback) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < 1024 || v > 65535)
    throw new Error(`${name}: a port number`);
  return v;
};
const apiPort = port('DEV_API_PORT', 3300);
const webPort = port('DEV_WEB_PORT', 5178);
const database = `mje_report_dev${suffix}`;
const role = `mje_dev_app${suffix}`;
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
// Field roster persons (TEST names only).
const crewPeople = [
  [id('foreman-a'), 'TEST 工头 A'],
  [id('worker-1'), 'TEST 工人 1'],
  [id('worker-2'), 'TEST 工人 2'],
  [id('worker-3'), 'TEST 工人 3'],
];
for (const [pid, name] of [
  [pmPerson, 'TEST 项目经理'],
  [execPerson, 'TEST 总经理'],
  ...crewPeople,
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
const items = await reportStore.read(pmIdentity, (ctx) =>
  reportReader.forContext(ctx).items(project),
);
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
let photoStore;
let blobs = null;
if (blobConnection) {
  // Built by the API's own factory, so the client comes from the SDK entry the API imports (not
  // the CommonJS one). The connection string was checked above (loopback emulator only).
  blobs = AzurePhotoBlobStore.fromConnectionString(
    blobConnection,
    `evidence-dev${instance ? `-${instance}` : ''}`,
  );
  await blobs.ensureContainer();
  photoStore = new PhotoStore(pool, blobs);
}
const fieldStore = new FieldStore(pool);
const checkInStore = new CheckInStore(pool, blobs);
const roster = await fieldStore.roster(pmIdentity, project);
if (!roster.crews.length) {
  // A TEST crew with a foreman and three workers, the TEST site reference and an entry code.
  const crew = await fieldStore.createCrew(pmIdentity, {
    projectId: project,
    clientMutationId: randomUUID(),
    expectedRosterVersion: roster.rosterVersion,
    code: 'A',
    name: 'TEST 班组 A',
  });
  const crewId = crew.crews[0].id;
  await fieldStore.changeRoster(pmIdentity, {
    projectId: project,
    clientMutationId: randomUUID(),
    expectedRosterVersion: crew.rosterVersion,
    changes: crewPeople.flatMap(([personId], i) => [
      { op: 'open', crewId, personId, role: 'MEMBER', from: null },
      ...(i === 0
        ? [{ op: 'open', crewId, personId, role: 'FOREMAN', from: null }]
        : []),
    ]),
  });
  await checkInStore.setSiteReference(pmIdentity, {
    projectId: project,
    clientMutationId: randomUUID(),
    expectedN: 0,
    lat: '1.000000',
    lon: '1.000000',
    radiusM: 500,
  });
}
const active = await q(
  'SELECT code FROM "FieldEntryCode" WHERE "projectId"=$1 AND "retiredAt" IS NULL',
  [project],
);
const entry = active.rowCount
  ? active.rows[0]
  : await fieldStore.rotateEntryCode(pmIdentity, {
      projectId: project,
      clientMutationId: randomUUID(),
    });
const app = await createApp({
  auth,
  verifier,
  store: new AlphaStore(pool),
  reportStore,
  issueStore: new IssueStore(pool),
  ...(photoStore ? { photoStore } : {}),
  fieldStore,
  checkInStore,
  foremanStore: new ForemanStore(pool),
});
await app.listen(apiPort, '127.0.0.1');
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
console.log(
  `TEST dev API on http://127.0.0.1:${apiPort} (local database only; photos ${photoStore ? 'on local blob emulator' : 'off'})`,
);
console.log(
  `project manager: http://localhost:${webPort}/#dev-token=${await token(pmObject)}`,
);
console.log(
  `executive:       http://localhost:${webPort}/#dev-token=${await token(execObject)}`,
);
console.log(
  `field (TEST QR): http://localhost:${webPort}/field/#e=${entry.code}`,
);
const stop = async () => {
  await app.close();
  await pool.end();
  await owner.end();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
