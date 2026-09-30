// Dev only, run once per person as a Container Apps job execution of the migration job, with
// the migration identity (the Entra PostgreSQL admin), after cloud-bootstrap.mjs. It links one
// more Entra account of the Dev tenant (a B2B guest or a member created in that directory,
// OD05 paths A/B) to the bootstrap's TEST project: a TEST Person, a LoginAccount for that
// object id and one report Membership. Existing rows are reused only if they match; anything
// inconsistent or inactive stops the run instead of being overwritten. Idempotent; prints no
// secrets and no identifiers.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Registered before anything else runs: configuration checks, module loading and the
// credential are all inside the sanitising boundary.
class BootstrapStop extends Error {}
const fail = (message) => {
  throw new BootstrapStop(`Cloud add-member stopped: ${message}`);
};
// Database, SDK and module-loading errors can carry identifiers or paths in their details;
// the job log gets only our own stop messages or a bare error code.
process.on('uncaughtException', (error) => {
  if (error instanceof BootstrapStop) console.error(error.message);
  else
    console.error(
      `Cloud add-member failed: ${error?.code ? `code ${String(error.code).slice(0, 16)}` : (error?.name ?? 'error')}`,
    );
  process.exit(1);
});

function required(name) {
  const value = process.env[name];
  if (!value)
    throw new BootstrapStop(`Missing cloud add-member configuration: ${name}`);
  return value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLES = ['PROJECT_MANAGER', 'EXECUTIVE_READER'];

// A missing managed identity must never fall back to any local URL.
const clientId = required('AZURE_CLIENT_ID');
const host = required('PGHOST');
const user = required('PGUSER');
const tenantId = required('OWNER_TENANT_ID');
const memberObjectId = required('MEMBER_OBJECT_ID');
const role = required('MEMBER_ROLE');
const displayName = required('MEMBER_DISPLAY_NAME');
const projectCode = required('PROJECT_CODE');
if (
  process.env.NODE_ENV !== 'production' ||
  !/^mjeepc-dev-pg-[a-z0-9]+\.postgres\.database\.azure\.com$/.test(host) ||
  user !== 'mjeepc-dev-migration' ||
  process.env.ALPHA_DATABASE_URL ||
  process.env.DATABASE_URL ||
  // The driver would apply these to every connection (e.g. a different search_path).
  process.env.PGOPTIONS ||
  process.env.PGSERVICE ||
  process.env.PGSERVICEFILE
)
  throw new BootstrapStop(
    'Cloud add-member target or identity is not the approved Dev shape',
  );
for (const [name, value] of [
  ['OWNER_TENANT_ID', tenantId],
  ['MEMBER_OBJECT_ID', memberObjectId],
])
  if (!UUID.test(value))
    throw new BootstrapStop(
      `Cloud add-member configuration is not a GUID: ${name}`,
    );
if (!ROLES.includes(role))
  throw new BootstrapStop(
    'Cloud add-member configuration MEMBER_ROLE must be PROJECT_MANAGER or EXECUTIVE_READER',
  );
// TEST data only: the name is a synthetic label, never a real person's name.
if (
  !displayName.startsWith('TEST ') ||
  displayName.trim() === 'TEST' ||
  displayName.length > 80 ||
  /\p{Cc}/u.test(displayName)
)
  throw new BootstrapStop(
    'Cloud add-member configuration MEMBER_DISPLAY_NAME must be a TEST label ("TEST ...", at most 80 characters)',
  );
if (projectCode !== 'TEST-R11')
  throw new BootstrapStop(
    'Cloud add-member configuration PROJECT_CODE must be TEST-R11',
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
const { tokenTenant } = await import('./entra-mapping.mjs');
const credential = new ManagedIdentityCredential({ clientId });
const token = await credential.getToken(
  'https://ossrdbms-aad.database.windows.net/.default',
);
if (!token?.token)
  throw new BootstrapStop(
    'Cloud add-member stopped: managed identity database token unavailable',
  );
const db = new Client({
  host,
  port: 5432,
  database: 'mje',
  user,
  password: token.token,
  ssl: { rejectUnauthorized: true },
  // Everything below is schema-qualified; the path is pinned regardless of role settings.
  options: '-c search_path=pg_catalog',
});
await db.connect();
try {
  // Accepted by this server, so its tenant claim is the tenant the server trusts. The member
  // account must be an identity of that same (Dev) tenant.
  const serverTenant = tokenTenant(token.token);
  if (!serverTenant) fail('the server tenant could not be established');
  if (serverTenant !== tenantId)
    fail('the configured tenant is not the tenant of this database server');

  // The same deterministic ids as cloud-bootstrap.mjs, so the owner's rows are recognisable.
  const id = (name) => {
    const h = createHash('sha256')
      .update(`mje-dev-bootstrap:${name}`)
      .digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const org = id('org'),
    project = id('project'),
    ownerPerson = id('person'),
    actor = id('seed'),
    person = id(`member-person:${tenantId}:${memberObjectId}`);

  await db.query('BEGIN');
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  // 1. The bootstrap's TEST project must already exist; this script never creates it.
  if (
    (await one('SELECT name FROM public."Organization" WHERE id=$1', [org]))
      ?.name !== 'TEST Organization'
  )
    fail('the TEST organisation is missing; run the bootstrap first');
  const p = await one(
    'SELECT "orgId", code, status FROM public."Project" WHERE id=$1',
    [project],
  );
  if (!p) fail('the TEST project is missing; run the bootstrap first');
  if (p.orgId !== org || p.code !== projectCode)
    fail('the TEST project id is taken by another row');
  if (p.status !== 'ACTIVE') fail('the TEST project is not active');

  // 2. The account, by its unique key. An existing account is reused only if it is this
  //    script's member account: never the owner's, never another person's, never inactive.
  let account = await one(
    'SELECT id, active, "personId" FROM public."LoginAccount" WHERE "orgId"=$1 AND "entraTenantId"=$2 AND "entraObjectId"=$3',
    [org, tenantId, memberObjectId],
  );
  if (account) {
    const ownerMembership = await one(
      'SELECT 1 AS ok FROM public."Membership" WHERE id=$1',
      [id(`membership:${account.id}`)],
    );
    if (account.personId === ownerPerson || ownerMembership)
      fail('the member object id is the owner account');
    if (!account.personId)
      fail(
        'the member account exists but is not linked to a person (not linked automatically)',
      );
    if (account.personId !== person)
      fail('the member object id already belongs to another person');
    if (!account.active)
      fail(
        'the member account exists but is inactive (not reactivated automatically)',
      );
  }

  // 3. The person (a TEST label only). Reused only if it is the same org and label.
  await db.query(
    'INSERT INTO public."Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4) ON CONFLICT DO NOTHING',
    [person, org, actor, displayName],
  );
  const existing = await one(
    'SELECT "orgId", "displayName" FROM public."Person" WHERE id=$1',
    [person],
  );
  if (existing?.orgId !== org)
    fail('the member person id is taken by another row');
  if (existing.displayName !== displayName)
    fail(
      'the member person exists with another display name (not renamed automatically)',
    );

  if (!account) {
    const accountId = id(`member-account:${tenantId}:${memberObjectId}`);
    await db.query(
      `INSERT INTO public."LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId")
      VALUES($1,$2,now(),$3,$4,$5,$6)`,
      [accountId, org, actor, tenantId, memberObjectId, person],
    );
    account = { id: accountId, active: true, personId: person };
  }

  // 4. One membership with the requested role on the TEST project. A different role on the
  //    same project is not changed or added to automatically; an inactive one is not reopened.
  const memberships = (
    await db.query(
      `SELECT role, "activeFrom" <= now() AND ("activeUntil" IS NULL OR "activeUntil" > now()) AS current
      FROM public."Membership" WHERE "orgId"=$1 AND "accountId"=$2 AND "projectId"=$3`,
      [org, account.id, project],
    )
  ).rows;
  if (memberships.some((m) => m.role !== role))
    fail(
      'the member already has another role on the TEST project (not changed automatically)',
    );
  if (!memberships.length)
    await db.query(
      `INSERT INTO public."Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId")
      VALUES($1,$2,now(),$3,$4,now() - interval '1 hour',$5,$6)`,
      [
        id(`member-membership:${account.id}:${project}:${role}`),
        org,
        actor,
        role,
        account.id,
        project,
      ],
    );
  else if (!memberships.some((m) => m.current))
    fail(
      'the member has a membership that is not active (not reactivated automatically)',
    );

  // Readiness mirrors the report API (store-kit inTransaction): the identity must resolve to
  // exactly one active, person-linked account with a current report role in any organisation;
  // it must be this account; and that account must hold the requested role on the project now.
  const eligible = (
    await db.query(
      `SELECT a.id FROM public."LoginAccount" a
      WHERE a.active AND a."entraTenantId"=$1 AND a."entraObjectId"=$2 AND a."personId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM public."Membership" m WHERE m."orgId"=a."orgId" AND m."accountId"=a.id
          AND m.role = ANY($3::text[]) AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now()))`,
      [tenantId, memberObjectId, ROLES],
    )
  ).rows;
  if (eligible.length !== 1)
    fail(
      'the member identity does not resolve to exactly one eligible account',
    );
  if (eligible[0].id !== account.id)
    fail('the member identity resolves to another account');
  const current = await one(
    `SELECT EXISTS (SELECT 1 FROM public."Membership" m WHERE m."orgId"=$1 AND m."accountId"=$2
      AND m."projectId"=$3 AND m.role=$4
      AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now())) AS ok`,
    [org, account.id, project, role],
  );
  if (!current?.ok)
    fail('the member does not hold a current membership on the TEST project');
  await db.query('COMMIT');
  console.log(
    `TEST project ${projectCode}: member account ready as ${role === 'PROJECT_MANAGER' ? 'project manager' : 'executive reader'}`,
  );
} catch (error) {
  await db.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
console.log('Dev add-member completed.');
