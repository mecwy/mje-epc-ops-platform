// Dev only, run once as a Container Apps job with the migration identity (the Entra
// PostgreSQL admin). It (1) creates the application's Entra login for its managed identity
// and verifies the mapping (object id, service principal, non-admin, tenant), (2) grants the
// application role and proves in the same transaction that no ownership or privileged role
// is reachable, and (3) seeds one TEST project for the owner's own account, reusing matching
// rows and stopping on anything inconsistent or inactive. Idempotent; prints no secrets.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Registered before anything else runs: configuration checks, module loading and the
// credential are all inside the sanitising boundary.
class BootstrapStop extends Error {}
const fail = (message) => {
  throw new BootstrapStop(`Cloud bootstrap stopped: ${message}`);
};
// Database, SDK and module-loading errors can carry identifiers or paths in their details;
// the job log gets only our own stop messages or a bare error code.
process.on('uncaughtException', (error) => {
  if (error instanceof BootstrapStop) console.error(error.message);
  else
    console.error(
      `Cloud bootstrap failed: ${error?.code ? `code ${String(error.code).slice(0, 16)}` : (error?.name ?? 'error')}`,
    );
  process.exit(1);
});

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new BootstrapStop(`Missing cloud bootstrap configuration: ${name}`);
  return value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A missing managed identity must never fall back to any local URL.
const clientId = required('AZURE_CLIENT_ID');
const host = required('PGHOST');
const user = required('PGUSER');
const appPrincipal = required('APP_PRINCIPAL_NAME');
const appObjectId = required('APP_PRINCIPAL_OBJECT_ID');
const tenantId = required('OWNER_TENANT_ID');
const ownerObjectId = required('OWNER_OBJECT_ID');
if (
  process.env.NODE_ENV !== 'production' ||
  !/^mjeepc-dev-pg-[a-z0-9]+\.postgres\.database\.azure\.com$/.test(host) ||
  user !== 'mjeepc-dev-migration' ||
  appPrincipal !== 'mjeepc-dev-app' ||
  process.env.ALPHA_DATABASE_URL ||
  process.env.DATABASE_URL ||
  // The driver would apply these to every connection (e.g. a different search_path).
  process.env.PGOPTIONS ||
  process.env.PGSERVICE ||
  process.env.PGSERVICEFILE
)
  throw new BootstrapStop(
    'Cloud bootstrap target or identity is not the approved Dev shape',
  );
for (const [name, value] of [
  ['APP_PRINCIPAL_OBJECT_ID', appObjectId],
  ['OWNER_TENANT_ID', tenantId],
  ['OWNER_OBJECT_ID', ownerObjectId],
])
  if (!UUID.test(value))
    throw new BootstrapStop(
      `Cloud bootstrap configuration is not a GUID: ${name}`,
    );

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
    throw new BootstrapStop('Managed identity database token unavailable');
  const client = new Client({
    host,
    port: 5432,
    database,
    user,
    password: token.token,
    ssl: { rejectUnauthorized: true },
    // Everything below is schema-qualified; the path is pinned regardless of role settings.
    options: '-c search_path=pg_catalog',
  });
  await client.connect();
  return client;
};
const ident = (name) => `"${name.replaceAll('"', '""')}"`;
const lower = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
// 1. Application login, verified against the managed identity it must map to.
const system = await connect('postgres');
try {
  const exists = await system.query(
    'SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1',
    [appPrincipal],
  );
  if (!exists.rowCount) {
    await system.query(
      'SELECT * FROM pg_catalog.pgaadauth_create_principal_with_oid($1, $2, $3, false, false)',
      [appPrincipal, appObjectId, 'service'],
    );
    console.log(`created Entra login ${appPrincipal} (service, non-admin)`);
  }
  // The mapping itself is stored as the role's "pgaadauth" security label
  // ('aadauth,oid=<objectId>,type=<user|group|service>[,admin][,mfa]'); that is authoritative.
  const labels = (
    await system.query(
      `SELECT l.label FROM pg_catalog.pg_shseclabel l
      JOIN pg_catalog.pg_roles r ON r.oid = l.objoid
      WHERE l.provider = 'pgaadauth' AND r.rolname = $1`,
      [appPrincipal],
    )
  ).rows;
  if (labels.length !== 1)
    fail(`the application login has ${labels.length} Entra labels, expected 1`);
  const parts = String(labels[0].label)
    .split(',')
    .map((p) => p.trim());
  const field = (name) =>
    parts.find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
  if (parts[0] !== 'aadauth')
    fail('the application login label is not an Entra mapping');
  if (field('oid').toLowerCase() !== appObjectId)
    fail('the login maps to another Entra object');
  if (field('type').toLowerCase() !== 'service')
    fail('the login is not a service principal');
  if (parts.includes('admin')) fail('the login is an Entra admin');
  if (parts.includes('mfa'))
    fail('the login is marked MFA; a service login cannot be');

  // The documented listing adds the tenant; when it lists this login it must agree.
  // Documented result: rolename, principalType, objectId, tenantId, isMfa, isAdmin (0/1).
  const listed = (
    await system.query(
      'SELECT * FROM pg_catalog.pgaadauth_list_principals(false)',
    )
  ).rows
    .map(lower)
    .filter((r) => r.rolename === appPrincipal);
  const off = (v) => v === 0 || v === '0' || v === false || v === 'f';
  if (listed.length > 1) fail('the login is listed more than once');
  const principal = listed[0];
  if (principal) {
    if (String(principal.objectid ?? '').toLowerCase() !== appObjectId)
      fail('the listing maps the login to another Entra object');
    if (String(principal.principaltype ?? '').toLowerCase() !== 'service')
      fail('the listing says the login is not a service principal');
    if (String(principal.tenantid ?? '').toLowerCase() !== tenantId)
      fail('the login belongs to another tenant');
    if (!off(principal.isadmin)) fail('the listing says the login is an admin');
    if (!off(principal.ismfa)) fail('the listing says the login is MFA');
  } else
    console.log(
      'Entra listing has no row for this login; the security label was used',
    );
  const canLogin = await system.query(
    'SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=$1',
    [appPrincipal],
  );
  if (!canLogin.rows[0]?.rolcanlogin)
    fail('the application login cannot log in');
  console.log(
    `Entra login ${appPrincipal} verified: service principal, expected object, non-admin`,
  );
} finally {
  await system.end();
}

const db = await connect('mje');
try {
  // 2. Grant the application role and prove, in the same transaction, that nothing unsafe is
  //    reachable: no superuser/BYPASSRLS/role-creating role through any membership (including
  //    SET ROLE), no ownership of any public relation, and effective use of the app role.
  //    'MEMBER' is deliberately conservative: it follows every membership whatever its
  //    INHERIT/SET options, so it may also reject harmless memberships of this dedicated login.
  await db.query('BEGIN');
  await db.query(`GRANT mje_alpha_app TO ${ident(appPrincipal)}`);
  const check = (
    await db.query(
      `SELECT pg_catalog.pg_has_role($1, 'mje_alpha_app', 'USAGE') AS app_usage,
        EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role($1, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
               OR r.rolname IN ('azure_pg_admin', 'pg_read_all_data', 'pg_write_all_data'))) AS privileged,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND pg_catalog.pg_has_role($1, c.relowner, 'MEMBER')) AS owner`,
      [appPrincipal],
    )
  ).rows[0];
  if (!check?.app_usage || check.privileged || check.owner) {
    await db.query('ROLLBACK');
    fail(
      'the application login is not the safe non-owner shape; grant rolled back',
    );
  }
  await db.query('COMMIT');
  console.log(
    'application login: uses mje_alpha_app; owns nothing; no privileged role reachable',
  );

  // 3. One TEST project for the owner's own account. Existing rows are reused only if they
  //    match; anything inconsistent or inactive stops the run instead of being overwritten.
  const id = (name) => {
    const h = createHash('sha256')
      .update(`mje-dev-bootstrap:${name}`)
      .digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const org = id('org'),
    project = id('project'),
    person = id('person'),
    actor = id('seed');
  await db.query('BEGIN');
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  await db.query(
    'INSERT INTO public."Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3) ON CONFLICT DO NOTHING',
    [org, 'TEST Organization', actor],
  );
  if (
    (await one('SELECT name FROM public."Organization" WHERE id=$1', [org]))
      ?.name !== 'TEST Organization'
  )
    fail('the TEST organisation id is taken by another row');
  await db.query(
    'INSERT INTO public."Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4) ON CONFLICT DO NOTHING',
    [person, org, actor, 'TEST 项目经理'],
  );
  if (
    (await one('SELECT "orgId" FROM public."Person" WHERE id=$1', [person]))
      ?.orgId !== org
  )
    fail('the TEST person id is taken by another row');
  await db.query(
    `INSERT INTO public."Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status)
    VALUES($1,$2,now(),$3,'TEST-R11','TEST 屋顶光伏 3.0MWp','Europe/Belgrade','ACTIVE') ON CONFLICT DO NOTHING`,
    [project, org, actor],
  );
  const p = await one(
    'SELECT "orgId", code, timezone FROM public."Project" WHERE id=$1',
    [project],
  );
  if (
    p?.orgId !== org ||
    p.code !== 'TEST-R11' ||
    p.timezone !== 'Europe/Belgrade'
  )
    fail('the TEST project id is taken by another row');

  let account = await one(
    'SELECT id, active, "personId" FROM public."LoginAccount" WHERE "orgId"=$1 AND "entraTenantId"=$2 AND "entraObjectId"=$3',
    [org, tenantId, ownerObjectId],
  );
  if (!account) {
    const accountId = id(`account:${tenantId}:${ownerObjectId}`);
    await db.query(
      `INSERT INTO public."LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId")
      VALUES($1,$2,now(),$3,$4,$5,$6)`,
      [accountId, org, actor, tenantId, ownerObjectId, person],
    );
    account = { id: accountId, active: true, personId: person };
  }
  if (!account.active)
    fail(
      'the owner account exists but is inactive (not reactivated automatically)',
    );
  if (!account.personId) fail('the owner account is not linked to a person');

  const memberships = (
    await db.query(
      `SELECT id, "activeFrom" <= now() AND ("activeUntil" IS NULL OR "activeUntil" > now()) AS current
      FROM public."Membership" WHERE "orgId"=$1 AND "accountId"=$2 AND "projectId"=$3 AND role='PROJECT_MANAGER'`,
      [org, account.id, project],
    )
  ).rows;
  if (!memberships.length)
    await db.query(
      `INSERT INTO public."Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId")
      VALUES($1,$2,now(),$3,'PROJECT_MANAGER',now() - interval '1 hour',$4,$5)`,
      [id(`membership:${account.id}`), org, actor, account.id, project],
    );
  else if (!memberships.some((m) => m.current))
    fail(
      'the owner has a PROJECT_MANAGER membership that is not active (not reactivated automatically)',
    );

  const items = [
    ['work', 'support', 'itSupport', 'set', '9600'],
    ['work', 'modules', 'itModules', 'pcs', '5400'],
    ['work', 'dcCable', 'itDcCable', 'm', '42000'],
    ['work', 'tray', 'itTray', 'm', '2600'],
    ['work', 'acCable', 'itAcCable', 'm', '3300'],
    ['work', 'cabinet', 'itCabinet', 'unit', '6'],
    ['work', 'rail', 'itRail', 'm', '16800'],
    ['work', 'invSupport', 'itInvSupport', 'set', '18'],
    ['work', 'inverter', 'itInverter', 'unit', '18'],
    ['machinery', 'boomLift', 'mc_boomLift', '', ''],
    ['machinery', 'crane', 'mc_crane', '', ''],
    ['machinery', 'truck', 'mc_truck', '', ''],
    ['material', 'support', 'itSupport', 'set', '9600'],
    ['material', 'modules', 'itModules', 'pcs', '5400'],
    ['material', 'rail', 'itRail', 'm', '16800'],
  ];
  for (const [i, [kind, key, label, unit, designQty]] of items.entries())
    await db.query(
      `INSERT INTO public."ReportItem"(id,"orgId","projectId",kind,key,label,unit,"designQty","openingCumulative","sortOrder",active,"updatedBy")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'',$9,true,$10) ON CONFLICT DO NOTHING`,
      [
        id(`item:${kind}:${key}`),
        org,
        project,
        kind,
        key,
        label,
        unit,
        designQty,
        i,
        actor,
      ],
    );

  // Readiness mirrors the report API (store-kit inTransaction): the identity must resolve to
  // exactly one active, person-linked account with a current report role; it must be the
  // seeded account; and that account must currently manage the TEST project.
  const eligible = (
    await db.query(
      `SELECT a.id FROM public."LoginAccount" a
      WHERE a.active AND a."entraTenantId"=$1 AND a."entraObjectId"=$2 AND a."personId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM public."Membership" m WHERE m."orgId"=a."orgId" AND m."accountId"=a.id
          AND m.role = ANY($3::text[]) AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now()))`,
      [tenantId, ownerObjectId, ['PROJECT_MANAGER', 'EXECUTIVE_READER']],
    )
  ).rows;
  if (eligible.length !== 1)
    fail('the owner identity does not resolve to exactly one eligible account');
  if (eligible[0].id !== account.id)
    fail('the owner identity resolves to another account');
  const manager = await one(
    `SELECT EXISTS (SELECT 1 FROM public."Membership" m WHERE m."orgId"=$1 AND m."accountId"=$2
      AND m."projectId"=$3 AND m.role='PROJECT_MANAGER'
      AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now())) AS ok`,
    [org, account.id, project],
  );
  if (!manager?.ok)
    fail('the owner is not a current project manager of the TEST project');
  const work = await one(
    `SELECT count(*)::int AS n FROM public."ReportItem" WHERE "projectId"=$1 AND kind='work' AND active`,
    [project],
  );
  if ((work?.n ?? 0) < 1) fail('the TEST project has no active work items');
  await db.query('COMMIT');
  console.log(
    `TEST project TEST-R11 ready: owner authorised as project manager; ${work.n} active work items`,
  );
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
console.log('Dev bootstrap completed.');
