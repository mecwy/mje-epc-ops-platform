/** DG05-1a: real PostgreSQL/RLS + signed TEST HTTP. Never uses private contracts. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  AlphaStore,
  ContractRegisterReader,
  ContractRegisterCommands,
} from '../packages/domain/dist/index.js';
import { accountTransaction } from '../packages/domain/dist/store-kit.js';
import { observeContractProjections } from '../packages/domain/dist/contract-register/reader.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import type {
  ContractRegisterItemDto,
  ContractHistoryDto,
  CreateContractCommand,
  CorrectContractCommand,
  SetContractSharesCommand,
  ContractEditorLookupsDto,
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
  reviewerPerson = randomUUID(),
  reviewer = randomUUID(),
  reviewerMember = randomUUID(),
  reviewerOid = randomUUID(),
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
    const migrationOutput = execFileSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
      timeout: 180000,
    });
    writeFileSync(join(tmpdir(), `${database}-migration.log`), migrationOutput);
  } catch (e) {
    const x = e as { stdout?: Buffer; stderr?: Buffer };
    writeFileSync(
      join(tmpdir(), `${database}-migration.log`),
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
    [reviewerPerson, org],
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
    [reviewer, org, reviewerPerson, reviewerOid],
    [twin, org, person, twinOid],
    [foreignAccount, otherOrg, foreignPerson, foreignOid],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$1)',
      [id, o, p, tenant, obj],
    );
  for (const [id, o, a] of [
    [member, org, account],
    [reviewerMember, org, reviewer],
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
    contractRegisterCommands: new ContractRegisterCommands(appPool),
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
    reviewerBearer = await token(reviewerOid),
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
        | ContractEditorLookupsDto
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
  assert.deepEqual((await detail()).latest.total, {
    visibility: 'restricted',
    restriction: 'CAPABILITY',
  });
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
  assert.deepEqual(row.latest.total, {
    visibility: 'restricted',
    restriction: 'CAPABILITY',
  });
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
  assert.deepEqual((await detail()).latest.total, {
    visibility: 'restricted',
    restriction: 'CAPABILITY',
  });
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
        'INSERT INTO "ContractGrantRevocation"(id,"orgId","grantId","revokedBy",reason) VALUES($1,$2,$3,$3,\'TEST unauthorized\')',
        [randomUUID(), org, account],
      ),
      (e: { code?: string }) => e.code === '42501',
    );
  } finally {
    await raw.query('ROLLBACK');
    raw.release();
  }
  pass(
    'non-bypass app role sees only tenant rows and cannot seed grants/revocations',
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

  // 1b additions: real commands through signed HTTP and non-owner/RLS application identity.
  for (const capability of [
    'contract.view',
    'contract.amount',
    'contract.terms',
    'contract.original',
    'contract.internal',
    'contract.maintain',
    'contract.attention',
  ])
    await grant(capability);
  const submittedDay = randomUUID(),
    submittedRevision = randomUUID(),
    designItem = randomUUID();
  await owner.query(
    'INSERT INTO "DailyClose"(id,"orgId","projectId","businessDate","siteTimezone","scopeKey","expectedReason",state,"currentRevisionNumber","updatedAt","updatedBy") VALUES($1,$2,$3,\'2030-01-15\',\'UTC\',\'TEST\',\'TEST\',\'SUBMITTED\',1,now(),$4)',
    [submittedDay, org, project, account],
  );
  await owner.query(
    'INSERT INTO "Revision"(id,"orgId","dailyCloseId","revisionNumber",state,reason,snapshot,"submittedAt","updatedAt","updatedBy") VALUES($1,$2,$3,1,\'SUBMITTED\',\'TEST frozen report\',$4,now(),now(),$5)',
    [
      submittedRevision,
      org,
      submittedDay,
      {
        facts: { headcount: 'TEST declared only' },
        items: [{ designQty: '0.300000', actualQuantity: 'TEST unknown' }],
        contractReferences: [],
      },
      account,
    ],
  );
  await owner.query(
    'INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,"designQty","updatedBy") VALUES($1,$2,$3,\'work\',\'TEST_existing_item\',\'TEST item\',\'0.300000\',$4)',
    [designItem, org, project, account],
  );
  const reportBefore = (
    await owner.query(
      'SELECT snapshot,"updatedAt",version FROM "Revision" WHERE id=$1',
      [submittedRevision],
    )
  ).rows[0];
  const designBefore = (
    await owner.query(
      'SELECT "designQty","openingCumulative","updatedAt" FROM "ReportItem" WHERE id=$1',
      [designItem],
    )
  ).rows[0];
  const newContract = randomUUID(),
    lineA = randomUUID(),
    lineB = randomUUID(),
    projectB = randomUUID();
  await owner.query(
    'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1,$2,\'TEST-P2\',\'TEST second project\',\'UTC\',\'ACTIVE\',now(),$3)',
    [projectB, org, account],
  );
  const loc = { sourceDocumentId: document, location: 'TEST page 1' };
  const create: CreateContractCommand = {
    contractId: newContract,
    code: 'TEST-CREATED',
    direction: 'INCOME',
    expenditureSubtype: null,
    expectedVersion: 0,
    clientMutationId: randomUUID(),
    revision: {
      name: 'TEST created contract',
      originalNumber: null,
      counterpartyRaw: null,
      selfPartyRaw: null,
      counterpartyCompanyId: null,
      selfCompanyId: null,
      informationOwnerPersonId: null,
      signedOn: { state: 'UNKNOWN', value: null },
      effectiveOn: { state: 'NOT_STATED', value: null },
      registrationStatus: 'SIGNED_PENDING',
      total: { state: 'VALUE', value: '123.4500' },
      currency: 'EUR',
      taxBasis: 'UNKNOWN',
      sources: [loc],
      headLocs: { parties: loc, dates: null, total: loc },
      lines: [lineA, lineB].map((id, i) => ({
        id,
        lineNo: String(i + 1),
        description: 'TEST line ' + String(i + 1),
        quantity: { state: 'VALUE', value: '0.300000' },
        unitRaw: 'TEST m',
        unit: 'm',
        pricingType: 'UNIT_PRICE',
        amount: { state: 'VALUE', value: i === 0 ? '48.4500' : '75.0000' },
        includes: 'TEST included',
        excludes: '',
        derivation: '',
        source: loc,
        removed: false,
        removalSource: null,
      })),
    },
  };
  async function post<T extends { clientMutationId: string }>(
    path: string,
    body: T,
    credential = bearer,
  ) {
    const response = await fetch(base + '/api/contracts' + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': body.clientMutationId,
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { code?: string; version?: number },
    };
  }
  assert.equal((await post('', create)).status, 200);
  assert.equal((await post('', create)).status, 200);
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractRevision" WHERE "contractId"=$1',
        [newContract],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await post('', {
        ...create,
        revision: { ...create.revision, name: 'TEST reused key' },
      })
    ).body.code,
    'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(
    (
      await post(
        '',
        {
          ...create,
          contractId: randomUUID(),
          code: 'TEST twin',
          clientMutationId: randomUUID(),
        },
        twinBearer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post('', {
        ...create,
        contractId: randomUUID(),
        code: 'TEST foreign source',
        clientMutationId: randomUUID(),
        revision: {
          ...create.revision,
          sources: [{ ...loc, sourceDocumentId: foreignDocument }],
        },
      })
    ).status,
    400,
  );
  pass(
    'create/source/value states and same-key replay use real HTTP transactions; same Person account has no inherited writes',
  );
  const shareA = randomUUID(),
    shareB = randomUUID();
  const shares: SetContractSharesCommand = {
    contractId: newContract,
    lineId: lineA,
    expectedVersion: 1,
    clientMutationId: randomUUID(),
    shares: [
      {
        scopeId: shareA,
        projectId: project,
        expectedVersion: 0,
        basis: 'QUANTITY',
        quantity: '0.100000',
        area: '',
        note: '',
        retired: false,
        reason: '',
      },
      {
        scopeId: shareB,
        projectId: projectB,
        expectedVersion: 0,
        basis: 'QUANTITY',
        quantity: '0.200000',
        area: '',
        note: '',
        retired: false,
        reason: '',
      },
    ],
  };
  assert.equal((await post('/' + newContract + '/shares', shares)).status, 200);
  assert.equal((await post('/' + newContract + '/shares', shares)).status, 200);
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractScopeVersion" WHERE "contractId"=$1',
        [newContract],
      )
    ).rows[0].n,
    2,
  );
  const latest = (await call('/' + newContract))
    .body as ContractRegisterItemDto;
  assert.equal(latest.latest.lines[0]!.allocation.state, 'ALLOCATED');
  assert.equal(latest.latest.lines[0]!.allocation.remaining, '0.000000');
  for (const cap of ['contract.view', 'contract.amount', 'contract.terms'])
    await owner.query(
      'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"projectId","validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,\'INCOME\',\'PROJECT\',$7,\'2000-01-01\',\'2100-01-01\',\'TEST projection\',\'TEST fixture\',$8)',
      [randomUUID(), org, twinMember, twin, person, cap, project, account],
    );
  const projected = (await call('/' + newContract, twinBearer))
    .body as ContractRegisterItemDto;
  assert.equal(projected.latest.total.visibility, 'restricted');
  assert.equal(projected.latest.total.restriction, 'PROJECT_SCOPE');
  assert.equal(projected.latest.lines[0]!.canMaintainShares, false);
  assert.equal(projected.latest.lines.length, 1);
  assert.equal(projected.latest.lines[0]!.amount.visibility, 'visible');
  assert.equal(projected.latest.lines[0]!.sharedLineAmount, true);
  assert.equal(projected.latest.lines[0]!.shares.length, 1);
  assert.equal(
    (await call('/' + newContract + '/editor', twinBearer)).status,
    403,
  );
  assert.equal(
    (
      await post(
        '/' + newContract + '/shares',
        { ...shares, clientMutationId: randomUUID() },
        twinBearer,
      )
    ).status,
    403,
  );
  pass(
    'project amount readers see shared whole-line label and their line/share only; every historical header total stays restricted',
  );
  const corrected = structuredClone(create.revision);
  corrected.lines[0]!.quantity.value = '0.400000';
  corrected.lines[0]!.unit = 'pcs';
  corrected.lines[0]!.unitRaw = 'TEST pcs';
  const correction: CorrectContractCommand = {
    contractId: newContract,
    expectedVersion: 1,
    clientMutationId: randomUUID(),
    reason: 'TEST copied unit correction',
    revision: corrected,
  };
  const competing = { ...correction, clientMutationId: randomUUID() };
  const races = await Promise.all([
    post('/' + newContract + '/corrections', correction),
    post('/' + newContract + '/corrections', competing),
  ]);
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractRevision" WHERE "contractId"=$1',
        [newContract],
      )
    ).rows[0].n,
    2,
  );
  const pinned = (await call('/' + newContract))
    .body as ContractRegisterItemDto;
  assert.equal(pinned.latest.lines[0]!.shares[0]!.unit, 'm');
  assert.equal(pinned.latest.lines[0]!.shares[0]!.pinnedRevisionN, 1);
  assert.equal(pinned.latest.lines[0]!.allocation.state, 'RECONCILE');
  assert.equal(
    (
      await post('/' + newContract + '/shares', {
        ...shares,
        clientMutationId: randomUUID(),
      })
    ).status,
    409,
  );
  const partial = {
    ...shares,
    expectedVersion: 2,
    clientMutationId: randomUUID(),
    shares: [{ ...shares.shares[0]!, expectedVersion: 1 }],
  };
  assert.equal(
    (await post('/' + newContract + '/shares', partial)).body.code,
    'RECONCILE_REQUIRED',
  );
  const over = {
    ...shares,
    expectedVersion: 2,
    clientMutationId: randomUUID(),
    shares: shares.shares.map((s) => ({
      ...s,
      expectedVersion: 1,
      quantity: '0.300000',
    })),
  };
  assert.equal(
    (await post('/' + newContract + '/shares', over)).body.code,
    'SHARE_INVALID',
  );
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractScopeVersion" WHERE "contractId"=$1',
        [newContract],
      )
    ).rows[0].n,
    2,
  );
  const reconciled = {
    ...shares,
    expectedVersion: 2,
    clientMutationId: randomUUID(),
    shares: shares.shares.map((s) => ({ ...s, expectedVersion: 1 })),
  };
  assert.equal(
    (await post('/' + newContract + '/shares', reconciled)).status,
    200,
  );
  assert.equal(
    ((await call('/' + newContract)).body as ContractRegisterItemDto).latest
      .lines[0]!.allocation.state,
    'PARTIAL',
  );
  const history = (await call('/' + newContract + '/history', twinBearer))
    .body as ContractHistoryDto;
  assert.ok(
    history.revisions.every((r) => r.total.visibility === 'restricted'),
  );
  assert.equal(history.revisions.find((r) => r.n === 1)!.lines[0]!.unit, 'm');
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractAttention" WHERE "contractId"=$1 AND kind=\'CORRECTION\'',
        [newContract],
      )
    ).rows[0].n,
    1,
  );
  pass(
    'concurrent correction CAS, fixed old units and atomic unit reconciliation reject stale/partial/overallocated commands without partial writes',
  );
  assert.equal(history.shareVersions.length, 2);
  assert.deepEqual(
    history.shareVersions.map((s) => [s.version, s.unit, s.quantity]),
    [
      [2, 'pcs', '0.100000'],
      [1, 'm', '0.100000'],
    ],
  );
  const fullHistory = (await call('/' + newContract + '/history'))
    .body as ContractHistoryDto;
  assert.equal(fullHistory.shareVersions.length, 4);
  const lookup = (await call('/lookups')).body as ContractEditorLookupsDto;
  assert.equal(lookup.accountId, account);
  assert.deepEqual(lookup.directions, ['INCOME']);
  assert.ok(lookup.sources.some((s) => s.id === document));
  // F2: same-tenant source ownership does not confer direction or intake rights.
  const secretSource = randomUUID(),
    intakeSource = randomUUID(),
    unclassifiedSource = randomUUID();
  for (const [id, hash] of [
    [secretSource, 'c'],
    [intakeSource, 'd'],
    [unclassifiedSource, 'e'],
  ])
    await owner.query(
      'INSERT INTO "SourceDocument"(id,"orgId",sha256,filename,"blobKey","sourceVersion","updatedAt","updatedBy") VALUES($1,$2,$3,$4,\'TEST-only\',\'TEST-v1\',now(),$5)',
      [id, org, hash!.repeat(64), 'TEST sensitive opposite direction', account],
    );
  for (const [id, direction] of [
    [secretSource, 'EXPENDITURE'],
    [intakeSource, 'INCOME'],
  ])
    await owner.query(
      'INSERT INTO "ContractSourceIntake"(id,"orgId","sourceDocumentId",direction,basis,"registeredBy") VALUES($1,$2,$3,$4,\'TEST controlled classification\',$5)',
      [randomUUID(), org, id, direction, account],
    );
  const sourceLookup = (await call('/lookups'))
    .body as ContractEditorLookupsDto;
  assert.equal(
    sourceLookup.sources.some((x) => x.id === secretSource),
    false,
  );
  assert.equal(
    sourceLookup.sources.some((x) => x.id === unclassifiedSource),
    false,
  );
  assert.equal(
    sourceLookup.sources.some((x) => x.id === intakeSource),
    true,
  );
  const withSource = (sourceDocumentId: string): CreateContractCommand => {
    const next = structuredClone(create);
    next.contractId = randomUUID();
    next.code = 'TEST source ' + next.contractId;
    next.clientMutationId = randomUUID();
    next.revision.sources.forEach(
      (x) => (x.sourceDocumentId = sourceDocumentId),
    );
    for (const loc of Object.values(next.revision.headLocs))
      if (loc) loc.sourceDocumentId = sourceDocumentId;
    for (const line of next.revision.lines) {
      line.id = randomUUID();
      if (line.source) line.source.sourceDocumentId = sourceDocumentId;
    }
    return next;
  };
  for (const source of [secretSource, unclassifiedSource]) {
    const denied = withSource(source);
    assert.equal((await post('', denied)).status, 400);
    assert.equal(
      (
        await owner.query('SELECT count(*)::int FROM "Contract" WHERE id=$1', [
          denied.contractId,
        ])
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await owner.query(
          'SELECT count(*)::int FROM "IdempotencyRecord" WHERE key=$1',
          [denied.clientMutationId],
        )
      ).rows[0].count,
      0,
    );
  }
  assert.equal((await post('', withSource(intakeSource))).status, 200);
  await assert.rejects(
    owner.query(
      'UPDATE "ContractSourceIntake" SET direction=\'EXPENDITURE\' WHERE "sourceDocumentId"=$1',
      [intakeSource],
    ),
  );
  await assert.rejects(
    appPool.query(
      'INSERT INTO "ContractSourceIntake"(id,"orgId","sourceDocumentId",direction,basis,"registeredBy") VALUES($1,$2,$3,\'INCOME\',\'TEST forbidden self grant\',$4)',
      [randomUUID(), org, secretSource, account],
    ),
  );
  pass(
    'F2 same-direction cited/explicit-intake sources only; opposite/unclassified lookup and bind denial, rollback, immutable classification and no app self-grant',
  );
  // F1: explicit retirement creates attention once; repeated retired assertion does not.
  const retire = {
    ...reconciled,
    clientMutationId: randomUUID(),
    shares: [
      {
        ...reconciled.shares[0]!,
        expectedVersion: 2,
        retired: true,
        reason: 'TEST explicit retirement',
      },
    ],
  };
  const attentionCount = async () =>
    (
      await owner!.query(
        'SELECT count(*)::int AS n FROM "ContractAttention" WHERE "contractId"=$1 AND kind=\'SHARE_MISASSIGNED\'',
        [newContract],
      )
    ).rows[0].n as number;
  const beforeRetire = await attentionCount();
  assert.equal((await post('/' + newContract + '/shares', retire)).status, 200);
  assert.equal(await attentionCount(), beforeRetire + 1);
  assert.equal(
    (
      await post('/' + newContract + '/shares', {
        ...retire,
        clientMutationId: randomUUID(),
        shares: retire.shares.map((x) => ({ ...x, expectedVersion: 3 })),
      })
    ).status,
    200,
  );
  assert.equal(await attentionCount(), beforeRetire + 1);
  pass(
    'F1 active-to-retired transition produces one attention; repeated retired history does not',
  );
  const restrictedLookup = (await call('/lookups', twinBearer))
    .body as ContractEditorLookupsDto;
  assert.equal(restrictedLookup.accountId, twin);
  assert.deepEqual(restrictedLookup.sources, []);
  assert.deepEqual(restrictedLookup.directions, []);
  await grant('contract.attention');
  const attentionRow = (await call('/' + newContract))
    .body as ContractRegisterItemDto;
  const attention = attentionRow.attention.entries!.find(
    (e) => e.kind === 'CORRECTION',
  )!;
  assert.equal(attention.requiresAnotherPerson, true);
  assert.equal(attention.read, false);
  for (const [targetMember, targetAccount, targetPerson] of [
    [twinMember, twin, person],
    [reviewerMember, reviewer, reviewerPerson],
  ])
    for (const cap of ['contract.view', 'contract.attention'])
      await owner.query(
        'INSERT INTO "ContractGrant"(id,"orgId","membershipId","accountId","personId",capability,direction,scope,"validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,\'INCOME\',\'ORG\',\'2000-01-01\',\'2100-01-01\',\'TEST\',\'TEST\',$7)',
        [
          randomUUID(),
          org,
          targetMember,
          targetAccount,
          targetPerson,
          cap,
          account,
        ],
      );
  const ack = {
    contractId: newContract,
    attentionId: attention.id,
    clientMutationId: randomUUID(),
  };
  assert.equal(
    (await post('/' + newContract + '/attention/read', ack, twinBearer)).status,
    200,
  );
  assert.equal(
    (
      (await call('/' + newContract)).body as ContractRegisterItemDto
    ).attention.entries!.find((e) => e.id === attention.id)!.read,
    false,
  );
  const otherAck = { ...ack, clientMutationId: randomUUID() };
  assert.equal(
    (
      await post(
        '/' + newContract + '/attention/read',
        otherAck,
        reviewerBearer,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await post(
        '/' + newContract + '/attention/read',
        otherAck,
        reviewerBearer,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      (await call('/' + newContract)).body as ContractRegisterItemDto
    ).attention.entries!.find((e) => e.id === attention.id)!.read,
    true,
  );
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "ContractAttentionRead" WHERE "attentionId"=$1',
        [attention.id],
      )
    ).rows[0].n,
    2,
  );
  pass(
    'version-pinned share history, account-isolated lookup authorization and same-Person attention acknowledgement never count as independent viewing',
  );
  assert.deepEqual(
    (
      await owner.query(
        'SELECT snapshot,"updatedAt",version FROM "Revision" WHERE id=$1',
        [submittedRevision],
      )
    ).rows[0],
    reportBefore,
  );
  assert.deepEqual(
    (
      await owner.query(
        'SELECT "designQty","openingCumulative","updatedAt" FROM "ReportItem" WHERE id=$1',
        [designItem],
      )
    ).rows[0],
    designBefore,
  );
  pass(
    'contract registration, correction and share reconciliation never alter a previously submitted report snapshot or existing report design quantity',
  );
  const revokeWrite = await grant('contract.maintain');
  await revoke(revokeWrite);
  // Revoke every live maintenance grant; replay must authorize before returning its old response.
  await owner.query(
    'INSERT INTO "ContractGrantRevocation"(id,"orgId","grantId","revokedBy",reason) SELECT gen_random_uuid(),"orgId",id,$2,\'TEST all writes revoked\' FROM "ContractGrant" g WHERE "orgId"=$1 AND "accountId"=$2 AND capability=\'contract.maintain\' AND NOT EXISTS (SELECT 1 FROM "ContractGrantRevocation" r WHERE r."grantId"=g.id)',
    [org, account],
  );
  assert.equal((await post('', create)).status, 403);
  assert.equal(
    (await post('/' + newContract + '/shares', reconciled)).status,
    403,
  );
  const original = (
    await owner.query(
      'SELECT quantity::text,unit FROM "ContractLineRevision" WHERE "contractId"=$1 AND "lineId"=$2 AND n=1',
      [newContract, lineA],
    )
  ).rows[0];
  assert.equal(original.quantity, '0.300000');
  assert.equal(original.unit, 'm');
  pass(
    'replay reauthorization and immutable original versions retain old facts after revocation',
  );

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
        'DG05 header/line reader, version-pinned shares, create/correct CAS and replay authorization; UI remains pending',
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
