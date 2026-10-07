/** Local signed-HTTP TEST fixture for DG05; never connects to remote databases. */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  AlphaStore,
  ContractRegisterReader,
  ContractRegisterCommands,
} from '../packages/domain/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import { assertLocalDatabase } from './local-db.mjs';
const apiPort = Number(process.env['DEV_API_PORT'] ?? 13311);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
  throw new Error('TEST port');
const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import(
  requireApi.resolve('jose')
);
const source = assertLocalDatabase(process.env['DATABASE_URL'] ?? '');
interface TestActor {
  accountId: string;
  personId: string;
  objectId: string;
  membershipId: string;
}
interface ResumeFixture {
  database: string;
  role: string;
  org: string;
  writer: TestActor;
  twin: TestActor;
  reviewer: TestActor;
  project: string;
  project2: string;
  document: string;
  changeDocument: string;
}
const resume = process.argv.includes('--resume')
  ? (JSON.parse(
      readFileSync('/private/tmp/mje-dg05-browser-fixture.json', 'utf8'),
    ) as ResumeFixture)
  : null;
if (
  resume &&
  (!/^mje_dg05_browser_[a-f0-9]{12}$/.test(resume.database) ||
    resume.role !== 'mje_dg05_' + resume.database.slice(-12))
)
  throw new Error('owned TEST fixture');
const suffix = randomBytes(6).toString('hex'),
  database = resume?.database ?? 'mje_dg05_browser_' + suffix,
  role = resume?.role ?? 'mje_dg05_' + suffix;
const admin = new Pool({ connectionString: source.toString() });
const target = new URL(source);
target.pathname = '/' + database;
let owner: Pool | undefined,
  appPool: Pool | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined;
let databaseCreated = false,
  roleCreated = false,
  stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app?.close();
  await appPool?.end();
  await owner?.end();
  if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
  if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
  process.stdin.pause();
  console.log(
    JSON.stringify({ event: 'STOP', database, role, cleanupComplete: true }),
  );
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input: string) => {
  if (input.trim() === 'STOP') void stop();
});
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
try {
  if (resume) {
    if (
      !(
        await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
          database,
        ])
      ).rowCount
    )
      throw new Error('TEST resume database missing');
  } else await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  const migration = execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: target.toString() },
    stdio: 'pipe',
    timeout: 180000,
  });
  writeFileSync('/private/tmp/' + database + '-migration.log', migration);
  owner = new Pool({ connectionString: target.toString() });
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `${resume ? 'ALTER' : 'CREATE'} ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${role}"`);
  const appUrl = new URL(target);
  appUrl.username = role;
  appUrl.password = password;
  appPool = new Pool({ connectionString: appUrl.toString() });
  const org = resume?.org ?? randomUUID(),
    person = resume?.writer.personId ?? randomUUID(),
    reviewerPerson = resume?.reviewer.personId ?? randomUUID(),
    tenant = resume
      ? (
          await owner.query<{ entraTenantId: string }>(
            'SELECT "entraTenantId" FROM "LoginAccount" WHERE "orgId"=$1 AND id=$2',
            [org, resume.writer.accountId],
          )
        ).rows[0]!.entraTenantId
      : randomUUID(),
    project = resume?.project ?? randomUUID(),
    project2 = resume?.project2 ?? randomUUID(),
    document = resume?.document ?? randomUUID(),
    changeDocument = resume?.changeDocument ?? randomUUID();
  const writer = resume?.writer ?? {
      accountId: randomUUID(),
      personId: person,
      objectId: randomUUID(),
      membershipId: randomUUID(),
    },
    twin = resume?.twin ?? {
      accountId: randomUUID(),
      personId: person,
      objectId: randomUUID(),
      membershipId: randomUUID(),
    },
    reviewer = resume?.reviewer ?? {
      accountId: randomUUID(),
      personId: reviewerPerson,
      objectId: randomUUID(),
      membershipId: randomUUID(),
    };
  if (!resume) {
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST DG05 org\',now(),$2)',
      [org, writer.accountId],
    );
    for (const [id, name] of [
      [person, 'TEST Contract Writer'],
      [reviewerPerson, 'TEST Independent Viewer'],
    ])
      await owner.query(
        'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,$3,now(),$4)',
        [id, org, name, writer.accountId],
      );
    for (const [id, code] of [
      [project, 'TEST-P1'],
      [project2, 'TEST-P2'],
    ])
      await owner.query(
        'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST solar site\',\'UTC\',\'ACTIVE\',now(),$4)',
        [id, org, code, writer.accountId],
      );
    for (const actor of [writer, twin, reviewer]) {
      await owner.query(
        'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$1)',
        [actor.accountId, org, actor.personId, tenant, actor.objectId],
      );
      await owner.query(
        'INSERT INTO "Membership"(id,"orgId","accountId",role,"activeFrom","updatedAt","updatedBy") VALUES($1,$2,$3,\'EXECUTIVE_READER\',\'2000-01-01\',now(),$3)',
        [actor.membershipId, org, actor.accountId],
      );
    }
    for (const [id, filename] of [
      [document, 'TEST contract.txt'],
      [changeDocument, 'TEST correction.txt'],
    ])
      await owner.query(
        'INSERT INTO "SourceDocument"(id,"orgId",sha256,filename,"blobKey","sourceVersion","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,\'TEST-v1\',now(),$6)',
        [
          id,
          org,
          createHash('sha256')
            .update('TEST synthetic ' + filename)
            .digest('hex'),
          filename,
          'TEST/' + filename,
          writer.accountId,
        ],
      );
    for (const direction of ['INCOME', 'EXPENDITURE'])
      for (const capability of [
        'contract.view',
        'contract.amount',
        'contract.terms',
        'contract.original',
        'contract.internal',
        'contract.maintain',
        'contract.attention',
      ])
        await owner.query(
          'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,$7,\'ORG\',\'2000-01-01\',\'2100-01-01\',\'TEST fixture\',\'TEST fixture\',$4)',
          [
            randomUUID(),
            org,
            writer.membershipId,
            writer.accountId,
            person,
            capability,
            direction,
          ],
        );
    for (const capability of [
      'contract.view',
      'contract.amount',
      'contract.terms',
    ])
      await owner.query(
        'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"projectId","validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,\'INCOME\',\'PROJECT\',$7,\'2000-01-01\',\'2100-01-01\',\'TEST fixture\',\'TEST fixture\',$8)',
        [
          randomUUID(),
          org,
          twin.membershipId,
          twin.accountId,
          person,
          capability,
          project,
          writer.accountId,
        ],
      );
    for (const direction of ['INCOME', 'EXPENDITURE'])
      for (const capability of ['contract.view', 'contract.attention'])
        await owner.query(
          'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,$7,\'ORG\',\'2000-01-01\',\'2100-01-01\',\'TEST fixture\',\'TEST fixture\',$8)',
          [
            randomUUID(),
            org,
            reviewer.membershipId,
            reviewer.accountId,
            reviewer.personId,
            capability,
            direction,
            writer.accountId,
          ],
        );
  }
  const keys = await generateKeyPair('RS256'),
    audience = randomUUID(),
    clientId = randomUUID();
  const auth = {
    tenantId: tenant,
    audience,
    clientId,
    scope: 'access_as_user',
  };
  const verifier = new TokenVerifier(
    auth,
    createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          alg: 'RS256',
          kid: 'TEST-contract-browser',
        },
      ],
    }),
  );
  app = await createApp(
    {
      auth,
      verifier,
      store: new AlphaStore(appPool),
      contractRegisterReader: new ContractRegisterReader(appPool),
      contractRegisterCommands: new ContractRegisterCommands(appPool),
    },
    { installSignalHandlers: false },
  );
  await app.listen(apiPort, '127.0.0.1');
  const token = async (objectId: string) =>
    new SignJWT({
      tid: tenant,
      oid: objectId,
      azp: clientId,
      scp: auth.scope,
      ver: '2.0',
      sub: 'TEST-contract-browser',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST-contract-browser' })
      .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
      .setAudience(audience)
      .setIssuedAt()
      .setNotBefore(Math.floor(Date.now() / 1000) - 1)
      .setExpirationTime('4h')
      .sign(keys.privateKey);
  const tokens = {
    writer: await token(writer.objectId),
    twin: await token(twin.objectId),
    reviewer: await token(reviewer.objectId),
  };
  writeFileSync(
    '/private/tmp/mje-dg05-browser-tokens.json',
    JSON.stringify(tokens),
    { mode: 0o600 },
  );
  const fixture = {
    event: 'READY',
    database,
    role,
    apiPort,
    org,
    writer,
    twin,
    reviewer,
    project,
    project2,
    document,
    changeDocument,
    privateSourceRegression: false,
  };
  writeFileSync(
    '/private/tmp/mje-dg05-browser-fixture.json',
    JSON.stringify(fixture, null, 2) + '\n',
  );
  console.log(JSON.stringify(fixture));
} catch (error) {
  await stop();
  throw error;
}
