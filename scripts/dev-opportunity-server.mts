/** Local signed TEST fixture. Synthetic data only; no production authentication bypass. */
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync, unlinkSync } from 'node:fs';
import { Pool } from 'pg';
import {
  AlphaStore,
  OpportunityCommands,
  OpportunityReader,
} from '../packages/domain/dist/index.js';
import {
  blankOpportunityFacts,
  type UpdateOpportunityCommand,
} from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import { assertLocalDatabase } from './local-db.mjs';
const apiPort = Number(process.env['DEV_API_PORT'] ?? 13311);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
  throw new Error('TEST port');
const suffix = randomBytes(6).toString('hex'),
  database = `mje_dg06_browser_${suffix}`,
  role = `mje_dg06_${suffix}`,
  source = assertLocalDatabase(process.env['DATABASE_URL'] ?? ''),
  target = new URL(source);
target.pathname = `/${database}`;
const admin = new Pool({ connectionString: source.toString() });
let owner: Pool | undefined,
  appPool: Pool | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined,
  created = false,
  roleCreated = false,
  stopping = false;
const org = randomUUID(),
  person = randomUUID(),
  decisionPerson = randomUUID();
function actor(personId: string) {
  return {
    personId,
    accountId: randomUUID(),
    objectId: randomUUID(),
    membershipId: randomUUID(),
  };
}
const writer = actor(person),
  twin = actor(person),
  reader = actor(randomUUID()),
  decider = actor(decisionPerson),
  tenant = randomUUID(),
  document = randomUUID(),
  company = randomUUID(),
  lead = randomUUID();
const actors = { writer, twin, reader, decider };
async function stop() {
  if (stopping) return;
  stopping = true;
  await app?.close();
  await appPool?.end();
  await owner?.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
  const databaseAbsent =
      (
        await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
          database,
        ])
      ).rows.length === 0,
    roleAbsent =
      (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]))
        .rows.length === 0;
  await admin.end();
  for (const p of [
    '/private/tmp/mje-dg06-browser-tokens.json',
    '/private/tmp/mje-dg06-browser-fixture.json',
  ])
    try {
      unlinkSync(p);
    } catch {
      /* absent */
    }
  process.stdin.pause();
  console.log(
    JSON.stringify({
      event: 'STOP',
      database,
      role,
      databaseAbsent,
      roleAbsent,
    }),
  );
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
async function grant(who: typeof writer, cap: string) {
  await owner!.query(
    'INSERT INTO "OpportunityGrant"(id,"orgId","membershipId","accountId","personId",capability,scope,"validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,\'ORG\',\'2000-01-01\',\'2100-01-01\',\'TEST owner approval\',\'TEST browser fixture\',$7)',
    [
      randomUUID(),
      org,
      who.membershipId,
      who.accountId,
      who.personId,
      'opportunity.' + cap,
      writer.accountId,
    ],
  );
}
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  const output = execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: target.toString() },
    stdio: 'pipe',
    timeout: 180000,
  });
  writeFileSync(`/private/tmp/${database}-migration.log`, output);
  writeFileSync(`/private/tmp/${database}-migration.exit`, '0\n');
  owner = new Pool({ connectionString: target.toString() });
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${role}"`);
  const appUrl = new URL(target);
  appUrl.username = role;
  appUrl.password = password;
  appPool = new Pool({ connectionString: appUrl.toString() });
  await owner.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST DG06 browser\',now(),$2)',
    [org, writer.accountId],
  );
  const persons = [...new Set(Object.values(actors).map((x) => x.personId))];
  for (const [i, id] of persons.entries())
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,$3,now(),$4)',
      [id, org, 'TEST Person ' + String(i + 1), writer.accountId],
    );
  for (const a of Object.values(actors)) {
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$1)',
      [a.accountId, org, a.personId, tenant, a.objectId],
    );
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","accountId",role,"activeFrom","updatedAt","updatedBy") VALUES($1,$2,$3,\'EXECUTIVE_READER\',now()-interval \'1 day\',now(),$3)',
      [a.membershipId, org, a.accountId],
    );
  }
  await owner.query(
    'INSERT INTO "Company"(id,"orgId",name,kind,"updatedAt","updatedBy") VALUES($1,$2,\'TEST Company Alpha\',\'OTHER\',now(),$3)',
    [company, org, writer.accountId],
  );
  await owner.query(
    'INSERT INTO "SourceDocument"(id,"orgId",sha256,filename,"blobKey","sourceVersion","updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST evidence metadata.txt\',\'TEST metadata only\',\'TEST-v1\',now(),$4)',
    [document, org, 'a'.repeat(64), writer.accountId],
  );
  await owner.query(
    'INSERT INTO "OpportunitySourceIntake"(id,"orgId","sourceDocumentId",basis,"registeredBy") VALUES($1,$2,$3,\'TEST controlled opportunity metadata\',$4)',
    [randomUUID(), org, document, writer.accountId],
  );
  for (const cap of ['view', 'maintain', 'amount', 'internal', 'decide'])
    await grant(writer, cap);
  await grant(reader, 'view');
  await grant(decider, 'view');
  await grant(decider, 'decide');
  const requireApi = createRequire(
      new URL('../apps/api/package.json', import.meta.url),
    ),
    { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import(
      requireApi.resolve('jose')
    );
  const keys = await generateKeyPair('RS256'),
    audience = randomUUID(),
    clientId = randomUUID(),
    auth = { tenantId: tenant, audience, clientId, scope: 'access_as_user' },
    verifier = new TokenVerifier(
      auth,
      createLocalJWKSet({
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            alg: 'RS256',
            kid: 'TEST-dg06-browser',
          },
        ],
      }),
    );
  const commands = new OpportunityCommands(appPool),
    identity = { tenantId: tenant, objectId: writer.objectId };
  const facts = blankOpportunityFacts('TEST Alpha solar opportunity');
  facts.businessLine = { state: 'VALUE', value: 'TEST Line A' };
  facts.customerGroup = { state: 'VALUE', value: 'EXTERNAL' };
  facts.informationOwnerPersonId = person;
  facts.stageRaw = { state: 'VALUE', value: 'TEST early discussion' };
  facts.parties = [
    {
      id: randomUUID(),
      role: 'OWNER',
      rawName: { state: 'VALUE', value: 'TEST original owner' },
      companyId: company,
    },
  ];
  facts.ownerProject.reportedScale = {
    value: { state: 'VALUE', value: '12.500000' },
    unitRaw: 'MWp',
    basis: { state: 'VALUE', value: 'TEST owner total; our scope unconfirmed' },
  };
  facts.internalNote = {
    state: 'VALUE',
    value: 'TEST protected discussion 123.45',
  };
  const create = {
    opportunityId: lead,
    clientMutationId: randomUUID(),
    expectedVersion: 0 as const,
    code: 'TEST-DG06-ALPHA',
    facts,
    sources: [
      {
        sourceDocumentId: document,
        reference: 'TEST meeting note',
        location: 'TEST page 1 table A cell B2',
      },
    ],
  };
  await commands.create(
    identity,
    create,
    create.clientMutationId,
    randomUUID(),
  );
  const update: UpdateOpportunityCommand = {
    opportunityId: lead,
    clientMutationId: randomUUID(),
    expectedVersion: null,
    newFact: 'TEST owner asks for a permit-status call',
    noMaterialChange: false,
    evidence: 'TEST meeting note; no commercial approval',
    obstacle: null,
    occurrence: { occurredAt: null, timezone: null, businessDate: null },
    sources: [],
    changes: [],
    nextStep: {
      mode: 'REPLACE',
      baseStepId: null,
      next: {
        id: randomUUID(),
        action: 'TEST call the owner about permits',
        ownerPersonId: person,
        dueOn: { state: 'UNKNOWN', value: null },
      },
    },
  };
  await commands.update(
    identity,
    update,
    update.clientMutationId,
    randomUUID(),
  );
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    opportunityCommands: commands,
    opportunityReader: new OpportunityReader(appPool),
  });
  await app.listen(apiPort, '127.0.0.1');
  async function token(objectId: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      tid: tenant,
      oid: objectId,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST browser',
      iat: now,
      nbf: now - 1,
      exp: now + 14400,
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST-dg06-browser' })
      .sign(keys.privateKey);
  }
  const tokens = Object.fromEntries(
    await Promise.all(
      Object.entries(actors).map(async ([name, a]) => [
        name,
        await token(a.objectId),
      ]),
    ),
  );
  writeFileSync(
    '/private/tmp/mje-dg06-browser-tokens.json',
    JSON.stringify(tokens),
    { mode: 0o600 },
  );
  const fixture = {
    event: 'READY',
    database,
    role,
    apiPort,
    org,
    actors,
    document,
    company,
    lead,
  };
  writeFileSync(
    '/private/tmp/mje-dg06-browser-fixture.json',
    JSON.stringify(fixture, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(JSON.stringify(fixture));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line: string) => {
    void (async () => {
      const input = line.trim();
      if (input === 'STOP') {
        await stop();
        return;
      }
      if (input === 'REVOKE_WRITE')
        await owner!.query(
          'INSERT INTO "OpportunityGrantRevocation"(id,"orgId","grantId","revokedBy",reason) SELECT gen_random_uuid(),g."orgId",g.id,$2,\'TEST revoke for browser journey\' FROM "OpportunityGrant" g WHERE g."orgId"=$1 AND g."accountId"=$2 AND g.capability IN (\'opportunity.maintain\',\'opportunity.internal\',\'opportunity.decide\') AND NOT EXISTS(SELECT 1 FROM "OpportunityGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)',
          [org, writer.accountId],
        );
      if (input === 'RESTORE_WRITE')
        for (const cap of ['maintain', 'internal', 'decide'])
          await grant(writer, cap);
      if (input === 'EXTERNAL_STEP') {
        const current = await new OpportunityReader(appPool!).detail(
            identity,
            lead,
          ),
          c = {
            ...update,
            clientMutationId: randomUUID(),
            newFact: null,
            noMaterialChange: true,
            evidence: null,
            nextStep: {
              mode: 'REPLACE' as const,
              baseStepId: current.nextStep?.id ?? null,
              next: {
                id: randomUUID(),
                action: 'TEST colleague changed the next step',
                ownerPersonId: null,
                dueOn: { state: 'UNKNOWN' as const, value: null },
              },
            },
          };
        await commands.update(identity, c, c.clientMutationId, randomUUID());
      }
      console.log(JSON.stringify({ event: 'CONTROL', input }));
    })().catch((e) => console.error('TEST control ' + (e as Error).message));
  });
} catch (e) {
  await stop();
  throw e;
}
