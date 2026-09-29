// Dev only, run once as a Container Apps job with the migration identity (the Entra
// PostgreSQL admin). It (1) creates the application's Entra login for its managed identity,
// non-admin, (2) grants it the application role and reads back that it is neither owner,
// superuser nor RLS-bypassing, and (3) seeds one TEST project for the owner's own account.
// Idempotent: re-running changes nothing that already exists. Prints no tokens or secrets.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing cloud bootstrap configuration: ${name}`);
  return value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A missing managed identity must never fall back to any local URL.
const clientId = required('AZURE_CLIENT_ID');
const host = required('PGHOST');
const user = required('PGUSER');
const appPrincipal = required('APP_PRINCIPAL_NAME');
const appObjectId = required('APP_PRINCIPAL_OBJECT_ID');
const ownerTenantId = required('OWNER_TENANT_ID');
const ownerObjectId = required('OWNER_OBJECT_ID');
if (
  process.env.NODE_ENV !== 'production' ||
  !/^mjeepc-dev-pg-[a-z0-9]+\.postgres\.database\.azure\.com$/.test(host) ||
  user !== 'mjeepc-dev-migration' ||
  appPrincipal !== 'mjeepc-dev-app' ||
  process.env.ALPHA_DATABASE_URL ||
  process.env.DATABASE_URL
)
  throw new Error(
    'Cloud bootstrap target or identity is not the approved Dev shape',
  );
for (const [name, value] of [
  ['APP_PRINCIPAL_OBJECT_ID', appObjectId],
  ['OWNER_TENANT_ID', ownerTenantId],
  ['OWNER_OBJECT_ID', ownerObjectId],
])
  if (!UUID.test(value))
    throw new Error(`Cloud bootstrap configuration is not a GUID: ${name}`);

const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { ManagedIdentityCredential } = await import(
  requireApi.resolve('@azure/identity')
);
const requireDomain = createRequire(
  new URL('../packages/domain/package.json', import.meta.url),
);
const { Client } = (await import(requireDomain.resolve('pg'))).default;
const credential = new ManagedIdentityCredential({ clientId });
const connect = async (database) => {
  const token = await credential.getToken(
    'https://ossrdbms-aad.database.windows.net/.default',
  );
  if (!token?.token)
    throw new Error('Managed identity database token unavailable');
  const client = new Client({
    host,
    port: 5432,
    database,
    user,
    password: token.token,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
};
const ident = (name) => `"${name.replaceAll('"', '""')}"`;

// 1. Application login (in the postgres database, where the Entra functions live).
const system = await connect('postgres');
try {
  const exists = await system.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
    appPrincipal,
  ]);
  if (!exists.rowCount) {
    await system.query(
      'SELECT * FROM pgaadauth_create_principal_with_oid($1, $2, $3, false, false)',
      [appPrincipal, appObjectId, 'service'],
    );
    console.log(`created Entra login ${appPrincipal} (service, non-admin)`);
  } else console.log(`Entra login ${appPrincipal} already exists`);
} finally {
  await system.end();
}

// 2. Grant the application role and read back its safety properties.
const db = await connect('mje');
try {
  await db.query(`GRANT mje_alpha_app TO ${ident(appPrincipal)}`);
  const check = await db.query(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
      pg_has_role($1, 'mje_alpha_app', 'MEMBER') AS app_member,
      EXISTS (SELECT 1 FROM pg_roles a WHERE a.rolname='azure_pg_admin' AND pg_has_role($1, a.oid, 'MEMBER')) AS pg_admin,
      EXISTS (SELECT 1 FROM pg_class c WHERE c.relname IN ('DailyClose','Revision','AuditLog') AND pg_has_role($1, c.relowner, 'USAGE')) AS owner
    FROM pg_roles r WHERE r.rolname=$1`,
    [appPrincipal],
  );
  const role = check.rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.pg_admin ||
    role.owner ||
    !role.app_member
  )
    throw new Error('Application login is not the safe non-owner shape');
  console.log(
    'application login: member of mje_alpha_app; not owner, superuser, admin or RLS-bypassing',
  );

  // 3. One TEST project for the owner's own account (synthetic names, stable ids).
  const id = (name) => {
    const h = createHash('sha256')
      .update(`mje-dev-bootstrap:${name}`)
      .digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const org = id('org'),
    project = id('project'),
    person = id('person'),
    account = id(`account:${ownerTenantId}:${ownerObjectId}`),
    membership = id(`membership:${ownerObjectId}`),
    actor = id('seed');
  await db.query('BEGIN');
  await db.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3) ON CONFLICT DO NOTHING',
    [org, 'TEST Organization', actor],
  );
  await db.query(
    'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4) ON CONFLICT DO NOTHING',
    [person, org, actor, 'TEST 项目经理'],
  );
  await db.query(
    `INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status)
    VALUES($1,$2,now(),$3,'TEST-R11','TEST 屋顶光伏 3.0MWp','Europe/Belgrade','ACTIVE') ON CONFLICT DO NOTHING`,
    [project, org, actor],
  );
  await db.query(
    `INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId")
    VALUES($1,$2,now(),$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [account, org, actor, ownerTenantId, ownerObjectId, person],
  );
  await db.query(
    `INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId")
    VALUES($1,$2,now(),$3,'PROJECT_MANAGER',now() - interval '1 hour',$4,$5) ON CONFLICT DO NOTHING`,
    [membership, org, actor, account, project],
  );
  const items = [
    ['work', 'support', 'itSupport', 'set', '9600', ''],
    ['work', 'modules', 'itModules', 'pcs', '5400', ''],
    ['work', 'dcCable', 'itDcCable', 'm', '42000', ''],
    ['work', 'tray', 'itTray', 'm', '2600', ''],
    ['work', 'acCable', 'itAcCable', 'm', '3300', ''],
    ['work', 'cabinet', 'itCabinet', 'unit', '6', ''],
    ['work', 'rail', 'itRail', 'm', '16800', ''],
    ['work', 'invSupport', 'itInvSupport', 'set', '18', ''],
    ['work', 'inverter', 'itInverter', 'unit', '18', ''],
    ['machinery', 'boomLift', 'mc_boomLift', '', '', ''],
    ['machinery', 'crane', 'mc_crane', '', '', ''],
    ['machinery', 'truck', 'mc_truck', '', '', ''],
    ['material', 'support', 'itSupport', 'set', '9600', ''],
    ['material', 'modules', 'itModules', 'pcs', '5400', ''],
    ['material', 'rail', 'itRail', 'm', '16800', ''],
  ];
  for (const [
    i,
    [kind, key, label, unit, designQty, opening],
  ] of items.entries())
    await db.query(
      `INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,unit,"designQty","openingCumulative","sortOrder",active,"updatedBy")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) ON CONFLICT DO NOTHING`,
      [
        id(`item:${kind}:${key}`),
        org,
        project,
        kind,
        key,
        label,
        unit,
        designQty,
        opening,
        i,
        actor,
      ],
    );
  await db.query('COMMIT');
  const counts = await db.query(
    `SELECT (SELECT count(*)::int FROM "Membership" WHERE "projectId"=$1) AS memberships,
      (SELECT count(*)::int FROM "ReportItem" WHERE "projectId"=$1) AS items`,
    [project],
  );
  console.log(
    `TEST project TEST-R11 ready: ${counts.rows[0].memberships} membership(s), ${counts.rows[0].items} report items`,
  );
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
console.log('Dev bootstrap completed.');
