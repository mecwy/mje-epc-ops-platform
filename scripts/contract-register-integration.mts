/** DG05-1a: real PostgreSQL/RLS + signed TEST HTTP. Never uses private contracts. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  AlphaStore,
  ContractRegisterReader,
} from '../packages/domain/dist/index.js';
import { accountTransaction } from '../packages/domain/dist/store-kit.js';
import { observeContractProjections } from '../packages/domain/dist/contract-register/reader.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import type {
  ContractRegisterItemDto,
  ContractHistoryDto,
} from '../packages/contracts/dist/index.js';
import { assertLocalDatabase } from './local-db.mjs';
const source = assertLocalDatabase(process.env['DATABASE_URL'] ?? '');
const suffix = randomBytes(6).toString('hex'),
  database = `mje_contract_test_${suffix}`,
  username = `mje_contract_${suffix}`;
const url = new URL(source);
url.pathname = `/${database}`;
const closing = new WeakSet<Pool>();
const poolErrors: Error[] = [];
function protect(pool: Pool): Pool {
  pool.on('error', (e: Error & { code?: string }) => {
    if (closing.has(pool) && e.code === '57P01') return;
    poolErrors.push(new Error(`TEST pool error: ${e.code ?? 'UNKNOWN'}`));
  });
  return pool;
}
const admin = protect(new Pool({ connectionString: source.toString() }));
let owner: Pool | undefined,
  appPool: Pool | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined;
let created = false,
  roleCreated = false;
let checks = 0;
const pass = (s: string) => {
  checks++;
  console.log(`PASS ${s}`);
};
const org = randomUUID(),
  otherOrg = randomUUID(),
  person = randomUUID(),
  foreignPerson = randomUUID(),
  account = randomUUID(),
  twin = randomUUID(),
  foreignAccount = randomUUID();
const member = randomUUID(),
  twinMember = randomUUID(),
  foreignMember = randomUUID(),
  tenant = randomUUID(),
  oid = randomUUID(),
  twinOid = randomUUID(),
  foreignOid = randomUUID(),
  project = randomUUID();
const income = randomUUID(),
  cost = randomUUID(),
  foreignContract = randomUUID(),
  document = randomUUID(),
  foreignDocument = randomUUID();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  try {
    execFileSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
      timeout: 180000,
    });
  } catch (e) {
    const x = e as { stdout?: Buffer; stderr?: Buffer };
    writeFileSync(
      `/private/tmp/${database}-migration.log`,
      Buffer.concat([x.stdout ?? Buffer.alloc(0), x.stderr ?? Buffer.alloc(0)]),
    );
    throw e;
  }
  owner = protect(new Pool({ connectionString: url.toString() }));
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(url);
  appUrl.username = username;
  appUrl.password = password;
  appPool = protect(new Pool({ connectionString: appUrl.toString() }));
  for (const id of [org, otherOrg])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST contract org\',now(),$2)',
      [id, account],
    );
  for (const [id, o] of [
    [person, org],
    [foreignPerson, otherOrg],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,\'TEST person\',now(),$3)',
      [id, o, account],
    );
  await owner.query(
    'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1,$2,\'TEST-P\',\'TEST project\',\'UTC\',\'ACTIVE\',now(),$3)',
    [project, org, account],
  );
  for (const [id, o, p, obj] of [
    [account, org, person, oid],
    [twin, org, person, twinOid],
    [foreignAccount, otherOrg, foreignPerson, foreignOid],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$1)',
      [id, o, p, tenant, obj],
    );
  for (const [id, o, a] of [
    [member, org, account],
    [twinMember, org, twin],
    [foreignMember, otherOrg, foreignAccount],
  ])
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","accountId",role,"activeFrom","updatedAt","updatedBy") VALUES($1,$2,$3,\'EXECUTIVE_READER\',now()-interval \'1 day\',now(),$3)',
      [id, o, a],
    );
  for (const [id, o, a, hash] of [
    [document, org, account, 'a'.repeat(64)],
    [foreignDocument, otherOrg, foreignAccount, 'b'.repeat(64)],
  ])
    await owner.query(
      'INSERT INTO "SourceDocument"(id,"orgId",sha256,filename,"blobKey","sourceVersion","updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST contract.txt\',\'TEST-only\',\'TEST-v1\',now(),$4)',
      [id, o, hash, a],
    );
  for (const [id, o, a, p, d, sub] of [
    [income, org, account, person, 'INCOME', null],
    [cost, org, account, person, 'EXPENDITURE', 'PURCHASE'],
    [foreignContract, otherOrg, foreignAccount, foreignPerson, 'INCOME', null],
  ]) {
    await owner.query(
      'INSERT INTO "Contract"(id,"orgId",code,direction,"expenditureSubtype","createdBy") VALUES($1,$2,$1::uuid::text,$3,$4,$5)',
      [id, o, d, sub, a],
    );
    for (const n of [1, 2]) {
      await owner.query(
        'INSERT INTO "ContractRevision"(id,"orgId","contractId",n,name,"originalNumber","informationOwnerPersonId","totalState","totalAmount",currency,"correctionReason","registeredBy","registeredByPersonId") VALUES($1,$2,$3,$4,\'TEST contract header\',\'TEST raw number\',$5,\'VALUE\',$6,\'EUR\',$7,$8,$5)',
        [
          randomUUID(),
          o,
          id,
          n,
          p,
          n === 1 ? '0.0000' : '9999999999999999.9999',
          n === 1
            ? null
            : 'TEST correction contains amount 9999999999999999.9999',
          a,
        ],
      );
      await owner.query(
        'INSERT INTO "ContractRevisionSource"(id,"orgId","contractId",n,"sourceDocumentId",location) VALUES($1,$2,$3,$4,$5,\'TEST page 1 table A\')',
        [randomUUID(), o, id, n, o === org ? document : foreignDocument],
      );
    }
  }
  const requireApi = createRequire(
    new URL('../apps/api/package.json', import.meta.url),
  );
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } =
    await import(requireApi.resolve('jose'));
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
          kid: 'TEST-contract',
        },
      ],
    }),
  );
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    contractRegisterReader: new ContractRegisterReader(appPool),
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function token(object: string) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      tid: tenant,
      oid: object,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-contract',
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST-contract' })
      .sign(keys.privateKey);
  }
  const bearer = await token(oid),
    twinBearer = await token(twinOid),
    foreignBearer = await token(foreignOid);
  async function call(path = '', credential: string | null = bearer) {
    const response = await fetch(base + '/api/contracts' + path, {
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    });
    return {
      status: response.status,
      body: (await response.json()) as
        | ContractRegisterItemDto[]
        | ContractRegisterItemDto
        | ContractHistoryDto
        | { code: string; correlationId: string },
    };
  }
  const detail = async () => {
    const r = await call('/' + income);
    assert.equal(r.status, 200);
    return r.body as ContractRegisterItemDto;
  };
  const grants: string[] = [];
  async function grant(
    capability: string,
    direction = 'INCOME',
    scope = 'ORG',
    validUntil = '2100-01-01',
    target = member,
  ) {
    const id = randomUUID();
    await owner!.query(
      'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"projectId","validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'2000-01-01\',$10,\'TEST owner approval\',\'TEST fixture\',$4)',
      [
        id,
        org,
        target,
        account,
        person,
        capability,
        direction,
        scope,
        scope === 'PROJECT' ? project : null,
        validUntil,
      ],
    );
    grants.push(id);
    return id;
  }
  async function revoke(id: string) {
    await owner!.query(
      'INSERT INTO "ContractGrantRevocation"(id,"orgId","grantId","revokedBy",reason) VALUES($1,$2,$3,$4,\'TEST revoked\')',
      [randomUUID(), org, id, account],
    );
  }
  const errors: Record<string, string>[] = [];
  for (const path of [
    '/' + income,
    '/' + cost,
    '/' + foreignContract,
    '/' + randomUUID(),
    '/' + income + '/history',
  ]) {
    const r = await call(path);
    assert.equal(r.status, 404);
    const body = r.body as { code: string; correlationId: string };
    assert.equal(body.code, 'NOT_FOUND');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'correlationId']);
    errors.push({ code: body.code });
  }
  assert.deepEqual((await call()).body, []);
  assert.equal((await call('', null)).status, 401);
  assert.equal((await call('', 'TEST-device-token')).status, 401);
  pass(
    'no role/owner fallback; anonymous/device refused; hidden and missing have identical error shape',
  );
  const expired = await grant('contract.view', 'INCOME', 'ORG', '2001-01-01');
  assert.deepEqual((await call()).body, []);
  await revoke(expired);
  const projectGrant = await grant('contract.view', 'ALL', 'PROJECT');
  assert.deepEqual((await call()).body, []);
  await revoke(projectGrant);
  const view = await grant('contract.view');
  assert.equal((await call()).status, 200);
  assert.equal(((await call()).body as ContractRegisterItemDto[]).length, 1);
  assert.deepEqual((await detail()).latest.total, { visibility: 'restricted' });
  assert.deepEqual((await detail()).latest.evidence, {
    visibility: 'restricted',
  });
  assert.deepEqual((await call('', twinBearer)).body, []);
  assert.deepEqual((await call('', foreignBearer)).body, []);
  pass(
    'direction, expiry, project-only grants, tenant and same-Person account isolation',
  );
  await grant('contract.amount', 'EXPENDITURE');
  await grant('contract.amount', 'INCOME', 'PROJECT');
  await grant('contract.internal');
  await grant('contract.original');
  let row = await detail();
  assert.deepEqual(row.latest.total, { visibility: 'restricted' });
  assert.deepEqual(row.latest.internal, { visibility: 'restricted' });
  assert.equal(row.latest.evidence.sources?.[0]?.sourceDocumentId, document);
  const amount = await grant('contract.amount');
  row = await detail();
  assert.equal(row.latest.total.value, '9999999999999999.9999');
  assert.match(row.latest.internal.correctionReason!, /TEST correction/);
  const events: string[] = [];
  process.env['NODE_ENV'] = 'test';
  observeContractProjections((n) => events.push(n));
  await call();
  await detail();
  const hist = await call('/' + income + '/history');
  assert.equal(hist.status, 200);
  assert.equal(
    (hist.body as ContractHistoryDto).revisions[1]!.total.value,
    '0.0000',
  );
  assert.deepEqual(
    new Set(events),
    new Set([
      'contract-register.list',
      'contract-register.detail',
      'contract-register.history',
    ]),
  );
  observeContractProjections(null);
  await revoke(amount);
  assert.deepEqual((await detail()).latest.total, { visibility: 'restricted' });
  assert.deepEqual(
    (
      (await call('/' + income + '/history')).body as ContractHistoryDto
    ).revisions.map((r) => r.internal),
    [{ visibility: 'restricted' }, { visibility: 'restricted' }],
  );
  pass(
    'every real HTTP read reaches projection; exact decimal/zero; separate original/amount/internal grants including history',
  );
  const before = JSON.stringify((await call()).body);
  await owner.query(
    'INSERT INTO "ContractRevision"(id,"orgId","contractId",n,name,"totalState","totalAmount",currency,"correctionReason","registeredBy","registeredByPersonId") VALUES($1,$2,$3,3,\'TEST hidden changed\',\'VALUE\',\'123.4500\',\'USD\',\'TEST hidden reason\',$4,$5)',
    [randomUUID(), org, cost, account, person],
  );
  assert.equal(JSON.stringify((await call()).body), before);
  pass('hidden contract mutation cannot affect list contents/order/metadata');
  // Mutation attempts use independent transactions: every failure must preserve existing rows.
  async function reject(sql: string, args: unknown[], code: string) {
    await assert.rejects(
      owner!.query(sql, args),
      (e: { code?: string }) => e.code === code,
    );
  }
  await reject(
    'UPDATE "Contract" SET direction=\'EXPENDITURE\' WHERE id=$1',
    [income],
    'P0001',
  );
  await reject(
    'DELETE FROM "ContractRevision" WHERE "contractId"=$1',
    [income],
    'P0001',
  );
  await reject(
    'UPDATE "ContractRevisionSource" SET location=\'TEST overwrite\' WHERE "contractId"=$1',
    [income],
    'P0001',
  );
  await reject(
    'UPDATE "ContractGrant" SET capability=\'contract.amount\' WHERE id=$1',
    [view],
    'P0001',
  );
  await reject(
    'DELETE FROM "ContractGrantRevocation" WHERE "grantId"=$1',
    [amount],
    'P0001',
  );
  await reject(
    'INSERT INTO "ContractRevisionSource"(id,"orgId","contractId",n,"sourceDocumentId",location) VALUES($1,$2,$3,1,$4,\'TEST foreign\')',
    [randomUUID(), org, income, foreignDocument],
    '23503',
  );
  await reject(
    'INSERT INTO "ContractRevision"(id,"orgId","contractId",n,name,"totalState","totalAmount",currency,"correctionReason","registeredBy","registeredByPersonId") VALUES($1,$2,$3,3,\'TEST invalid\',\'UNKNOWN\',0,\'EUR\',\'TEST correction\',$4,$5)',
    [randomUUID(), org, income, account, person],
    '23514',
  );
  pass(
    'immutable identity/revisions/sources/grants/revocations; composite tenant source FK and numeric states enforced by DB',
  );
  const raw = await appPool.connect();
  try {
    await raw.query('BEGIN');
    await raw.query("SELECT set_config('app.org_id',$1,true)", [org]);
    assert.equal(
      (
        await raw.query('SELECT id FROM "Contract" WHERE "orgId"=$1', [
          otherOrg,
        ])
      ).rowCount,
      0,
    );
    await assert.rejects(
      raw.query(
        'INSERT INTO "Contract"(id,"orgId",code,direction,"createdBy") VALUES($1,$2,\'TEST unauthorized\',\'INCOME\',$3)',
        [randomUUID(), org, account],
      ),
      (e: { code?: string }) => e.code === '42501',
    );
  } finally {
    await raw.query('ROLLBACK');
    raw.release();
  }
  pass(
    'non-bypass app role sees only tenant rows and cannot seed grants/contracts',
  );
  // Real accountTransaction share lock must serialize revoke; no sleep-based success assumption.
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  let readerPid = 0;
  const holding = accountTransaction(
    appPool,
    { tenantId: tenant, objectId: oid },
    {
      admit: (m) => m.length > 0,
      forbidden: () => new Error('TEST admission'),
    },
    async (c) => {
      readerPid = (
        await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      entered();
      await gate;
    },
  );
  await ready;
  const revoker = await owner.connect();
  let revoking: Promise<unknown> | undefined;
  try {
    const pid = (
      await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0]!.pid;
    const version = (
      await owner.query<{ v: number }>(
        'SELECT "authzVersion" AS v FROM "LoginAccount" WHERE id=$1',
        [account],
      )
    ).rows[0]!.v;
    revoking = revoker.query(
      'INSERT INTO "ContractGrantRevocation"(id,"orgId","grantId","revokedBy",reason) VALUES($1,$2,$3,$4,\'TEST concurrent revoke\')',
      [randomUUID(), org, view, account],
    );
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      const blockers = (
        await owner.query<{ pids: number[] }>(
          'SELECT pg_blocking_pids($1) AS pids',
          [pid],
        )
      ).rows[0]!.pids;
      if (blockers.includes(readerPid)) {
        blocked = true;
        break;
      }
      await delay(20);
    }
    assert.ok(
      blocked,
      'revoke must wait for the active authorized account transaction',
    );
    release();
    await holding;
    await revoking;
    assert.equal(
      (
        await owner.query<{ v: number }>(
          'SELECT "authzVersion" AS v FROM "LoginAccount" WHERE id=$1',
          [account],
        )
      ).rows[0]!.v,
      version + 1,
    );
  } finally {
    release();
    await holding;
    await revoking;
    revoker.release();
  }
  assert.deepEqual((await call()).body, []);
  assert.equal((await call('/' + income)).status, 404);
  pass(
    'revocation waits on account lock and increments authzVersion; next read immediately loses visibility',
  );
  await grant('contract.view');
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()-interval \'1 second\' WHERE id=$1',
    [member],
  );
  assert.equal((await call()).status, 403);
  pass('expired membership invalidates even unexpired explicit grants');
  console.log(
    JSON.stringify({
      result: 'ASSERTIONS_PASSED_CLEANUP_PENDING',
      checks,
      database,
      privateSourceRegression: false,
      scope:
        'organization header reader; project shares and all writes pending',
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', database, checks }));
  throw error;
} finally {
  observeContractProjections(null);
  if (app) await app.close();
  if (appPool) {
    closing.add(appPool);
    await appPool.end();
  }
  if (owner) {
    closing.add(owner);
    await owner.end();
  }
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  closing.add(admin);
  await admin.end();
}

assert.deepEqual(poolErrors, [], 'unexpected TEST pool errors');
console.log(
  JSON.stringify({ result: 'PASS', checks, database, cleanupComplete: true }),
);
