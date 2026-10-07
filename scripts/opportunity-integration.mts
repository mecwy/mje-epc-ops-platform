/** DG06 synthetic TEST only: disposable local PostgreSQL/RLS and signed real HTTP. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  AlphaStore,
  OpportunityCommands,
  OpportunityReader,
} from '../packages/domain/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import {
  blankOpportunityFacts,
  type OpportunityFacts,
  type OpportunityItemDto,
  type OpportunityHistoryDto,
  type UpdateOpportunityCommand,
  type RecordOpportunityDecisionCommand,
  type RequestOpportunityDecisionCommand,
  type CreateOpportunityCommand,
} from '../packages/contracts/dist/index.js';
import { assertLocalDatabase } from './local-db.mjs';
const source = assertLocalDatabase(process.env['DATABASE_URL'] ?? ''),
  suffix = randomBytes(6).toString('hex'),
  database = `mje_dg06_test_${suffix}`,
  username = `mje_dg06_${suffix}`;
const url = new URL(source);
url.pathname = `/${database}`;
const admin = new Pool({ connectionString: source.toString() });
let owner: Pool | undefined,
  appPool: Pool | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined,
  created = false,
  roleCreated = false;
const org = randomUUID(),
  otherOrg = randomUUID(),
  tenant = randomUUID(),
  person = randomUUID(),
  foreignPerson = randomUUID(),
  account = randomUUID(),
  oid = randomUUID(),
  member = randomUUID(),
  twin = randomUUID(),
  twinOid = randomUUID(),
  twinMember = randomUUID(),
  decider = randomUUID(),
  deciderPerson = randomUUID(),
  deciderOid = randomUUID(),
  deciderMember = randomUUID(),
  foreignAccount = randomUUID(),
  foreignOid = randomUUID(),
  foreignMember = randomUUID();
const company = randomUUID(),
  foreignCompany = randomUUID(),
  document = randomUUID(),
  foreignDocument = randomUUID(),
  unclassifiedDocument = randomUUID(),
  contractDocument = randomUUID(),
  opp = randomUUID();
const occurrence = { occurredAt: null, timezone: null, businessDate: null };
const sourceBinding = {
  sourceDocumentId: document,
  reference: 'TEST meeting record',
  location: 'TEST page 1 table A cell B2',
};
let checks = 0;
const pass = (name: string) => {
  checks++;
  console.log('PASS ' + name);
};
async function personRow(id: string, o: string) {
  await owner!.query(
    'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,\'TEST synthetic person\',now(),$3)',
    [id, o, account],
  );
}
async function accountRow(
  id: string,
  o: string,
  p: string,
  obj: string,
  m: string,
) {
  await owner!.query(
    'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$1)',
    [id, o, p, tenant, obj],
  );
  await owner!.query(
    'INSERT INTO "Membership"(id,"orgId","accountId",role,"activeFrom","updatedAt","updatedBy") VALUES($1,$2,$3,\'EXECUTIVE_READER\',now()-interval \'1 day\',now(),$3)',
    [m, o, id],
  );
}
async function grant(
  cap: string,
  target = account,
  p = person,
  m = member,
  scope = 'ORG',
  line: string | null = null,
  targetOpp: string | null = null,
  until = '2100-01-01',
) {
  const id = randomUUID();
  await owner!.query(
    'INSERT INTO "OpportunityGrant"(id,"orgId","membershipId","accountId","personId",capability,scope,"businessLine","opportunityId","validFrom","validUntil",basis,source,"grantedBy") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'2000-01-01\',$10,\'TEST owner grant\',\'TEST fixture\',$11)',
    [id, org, m, target, p, cap, scope, line, targetOpp, until, account],
  );
  return id;
}
async function revoke(id: string) {
  await owner!.query(
    'INSERT INTO "OpportunityGrantRevocation"(id,"orgId","grantId","revokedBy",reason) VALUES($1,$2,$3,$4,\'TEST revoke\')',
    [randomUUID(), org, id, account],
  );
}
const update = (
  changes: UpdateOpportunityCommand['changes'] = [],
): UpdateOpportunityCommand => ({
  opportunityId: opp,
  clientMutationId: randomUUID(),
  expectedVersion: null,
  newFact: null,
  noMaterialChange: true,
  evidence: null,
  obstacle: null,
  occurrence,
  sources: [],
  changes,
  nextStep: { mode: 'KEEP' },
});
const request = (
  base: string | null = null,
): RequestOpportunityDecisionCommand => ({
  opportunityId: opp,
  clientMutationId: randomUUID(),
  expectedRequestId: base,
  requestId: randomUUID(),
  requestedPersonId: deciderPerson,
  explanation: 'TEST protected request 123.45',
  dueOn: { state: 'UNKNOWN', value: null },
  sources: [sourceBinding],
});
function decision(
  version: number,
  base: string | null,
  kind: 'CONTINUE' | 'PAUSE' | 'EXIT' = 'PAUSE',
): RecordOpportunityDecisionCommand {
  return {
    opportunityId: opp,
    clientMutationId: randomUUID(),
    expectedDecisionVersion: version,
    expectedRequestId: base,
    actualDecisionPersonId: deciderPerson,
    decision: {
      kind,
      resumeCondition: kind === 'PAUSE' ? 'TEST permit issued' : null,
      reviewOn: { state: 'UNKNOWN', value: null },
      exitReason: kind === 'EXIT' ? 'TEST tender cancelled' : null,
      reentryCondition: kind === 'EXIT' ? 'TEST new tender' : null,
    },
    recordText: 'TEST protected decision 123.45',
    basis: 'TEST actual authority',
    occurrence,
    proxy: null,
    sources: [sourceBinding],
  };
}
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  try {
    const output = execFileSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
      timeout: 180000,
    });
    writeFileSync(`/private/tmp/${database}-migration.log`, output);
    writeFileSync(`/private/tmp/${database}-migration.exit`, '0\n');
  } catch (e) {
    const x = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    writeFileSync(
      `/private/tmp/${database}-migration.log`,
      Buffer.concat([x.stdout ?? Buffer.alloc(0), x.stderr ?? Buffer.alloc(0)]),
    );
    writeFileSync(
      `/private/tmp/${database}-migration.exit`,
      String(x.status ?? 1) + '\n',
    );
    throw e;
  }
  owner = new Pool({ connectionString: url.toString() });
  const password = randomBytes(24).toString('hex');
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(url);
  appUrl.username = username;
  appUrl.password = password;
  appPool = new Pool({ connectionString: appUrl.toString() });
  for (const id of [org, otherOrg])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST DG06 org\',now(),$2)',
      [id, account],
    );
  for (const [id, o] of [
    [person, org],
    [deciderPerson, org],
    [foreignPerson, otherOrg],
  ] as const)
    await personRow(id, o);
  await accountRow(account, org, person, oid, member);
  await accountRow(twin, org, person, twinOid, twinMember);
  await accountRow(decider, org, deciderPerson, deciderOid, deciderMember);
  await accountRow(
    foreignAccount,
    otherOrg,
    foreignPerson,
    foreignOid,
    foreignMember,
  );
  for (const [id, o] of [
    [company, org],
    [foreignCompany, otherOrg],
  ] as const)
    await owner.query(
      'INSERT INTO "Company"(id,"orgId",name,kind,"updatedAt","updatedBy") VALUES($1,$2,\'TEST Company\',\'TEST\',now(),$3)',
      [id, o, account],
    );
  for (const [id, o, h] of [
    [document, org, 'a'],
    [unclassifiedDocument, org, 'c'],
    [contractDocument, org, 'd'],
    [foreignDocument, otherOrg, 'b'],
  ] as const)
    await owner.query(
      'INSERT INTO "SourceDocument"(id,"orgId",sha256,filename,"blobKey","sourceVersion","updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST opportunity.txt\',\'TEST metadata only\',\'TEST-v1\',now(),$4)',
      [id, o, h.repeat(64), account],
    );
  await owner.query(
    'INSERT INTO "ContractSourceIntake"(id,"orgId","sourceDocumentId",direction,basis,"registeredBy") VALUES($1,$2,$3,\'INCOME\',\'TEST contract-confidential source\',$4)',
    [randomUUID(), org, contractDocument, account],
  );
  await owner.query(
    'INSERT INTO "OpportunitySourceIntake"(id,"orgId","sourceDocumentId",basis,"registeredBy") VALUES($1,$2,$3,\'TEST controlled opportunity metadata\',$4)',
    [randomUUID(), org, document, account],
  );
  // Existing-domain rows are real persisted TEST fixtures, captured before any DG06 command.
  const baselineProject = randomUUID(),
    baselineDay = randomUUID(),
    baselineRevision = randomUUID(),
    baselineAssertion = randomUUID(),
    baselineContract = randomUUID();
  await owner.query(
    'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1,$2,\'TEST-EXISTING\',\'TEST existing project\',\'Europe/Belgrade\',\'ACTIVE\',now(),$3)',
    [baselineProject, org, account],
  );
  await owner.query(
    'INSERT INTO "DailyClose"(id,"orgId","projectId","businessDate","siteTimezone","scopeKey",state,"expectedReason","currentRevisionNumber","updatedAt","updatedBy") VALUES($1,$2,$3,\'2026-10-01\',\'Europe/Belgrade\',\'TEST\',\'SUBMITTED\',\'TEST calendar\',1,now(),$4)',
    [baselineDay, org, baselineProject, account],
  );
  await owner.query(
    'INSERT INTO "Revision"(id,"orgId","dailyCloseId","revisionNumber",state,reason,snapshot,"submittedAt","updatedAt","updatedBy") VALUES($1,$2,$3,1,\'SUBMITTED\',\'TEST original\',$4,now(),now(),$5)',
    [
      baselineRevision,
      org,
      baselineDay,
      {
        TEST: true,
        workforce: { declared: 13, actualMinutes: null },
        quantity: { raw: '100%', accepted: null },
      },
      account,
    ],
  );
  await owner.query(
    'INSERT INTO "SourceAssertion"(id,"orgId","documentId",locator,"rawValue","sourceLayer","updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST original table A B2\',$4,\'TEST\',now(),$5)',
    [
      baselineAssertion,
      org,
      document,
      { TEST: true, raw: '150.000000', unit: 'pcs', merged: 'B2:C2' },
      account,
    ],
  );
  await owner.query(
    'INSERT INTO "DailyQuantityPlan"(id,"orgId","targetBusinessDate",qty,uom,"sourceVersion","sourceId","updatedAt","updatedBy") VALUES($1,$2,\'2026-10-01\',150.000000,\'pcs\',\'TEST original v1\',$3,now(),$4)',
    [randomUUID(), org, baselineAssertion, account],
  );
  await owner.query(
    'INSERT INTO "ContractScope"(id,"orgId","projectId",code,"pricingType",amount,currency,"updatedAt","updatedBy") VALUES($1,$2,$3,\'TEST EXISTING\',\'LUMP_SUM\',100.0000,\'EUR\',now(),$4)',
    [randomUUID(), org, baselineProject, account],
  );
  await owner.query(
    'INSERT INTO "Contract"(id,"orgId",code,direction,"createdBy") VALUES($1,$2,\'TEST-EXISTING\',\'INCOME\',$3)',
    [baselineContract, org, account],
  );
  await owner.query(
    'INSERT INTO "ContractRevision"(id,"orgId","contractId",n,name,"totalState","registeredBy","registeredByPersonId") VALUES($1,$2,$3,1,\'TEST existing contract\',\'UNKNOWN\',$4,$5)',
    [randomUUID(), org, baselineContract, account, person],
  );
  async function existingDomainHashes() {
    const hashes: Record<string, string> = {};
    for (const table of [
      'Project',
      'DailyClose',
      'Revision',
      'SourceDocument',
      'SourceAssertion',
      'DailyQuantityPlan',
      'ContractScope',
      'Contract',
      'ContractRevision',
    ]) {
      const rows = (
        await owner!.query(
          `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "orgId"=$1 ORDER BY id`,
          [org],
        )
      ).rows;
      assert.ok(rows.length > 0, 'populated ' + table);
      hashes[table] = createHash('sha256')
        .update(JSON.stringify(rows))
        .digest('hex');
    }
    return hashes;
  }
  const baselineHashes = await existingDomainHashes();
  const requireApi = createRequire(
      new URL('../apps/api/package.json', import.meta.url),
    ),
    { generateKeyPair, createLocalJWKSet, exportJWK, SignJWT } = await import(
      requireApi.resolve('jose')
    );
  const keys = await generateKeyPair('RS256'),
    audience = randomUUID(),
    clientId = randomUUID(),
    auth = { tenantId: tenant, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(
    auth,
    createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          alg: 'RS256',
          kid: 'TEST-dg06',
        },
      ],
    }),
  );
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    opportunityCommands: new OpportunityCommands(appPool),
    opportunityReader: new OpportunityReader(appPool),
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
      sub: 'TEST-dg06',
      iat: now,
      nbf: now - 1,
      exp: now + 1200,
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST-dg06' })
      .sign(keys.privateKey);
  }
  const bearer = await token(oid),
    twinBearer = await token(twinOid),
    deciderBearer = await token(deciderOid),
    foreignBearer = await token(foreignOid);
  async function call(
    path: string,
    credential: string | null = bearer,
    body?: object,
  ) {
    const response = await fetch(base + '/api/opportunities' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': (body as { clientMutationId: string })
                .clientMutationId,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }
  async function detail() {
    const r = await call('/' + opp);
    assert.equal(r.status, 200);
    return r.body as unknown as OpportunityItemDto;
  }
  async function history() {
    const r = await call('/' + opp + '/history');
    assert.equal(r.status, 200);
    return r.body as unknown as OpportunityHistoryDto;
  }
  async function post(
    path: string,
    c: object,
    expected = 200,
    credential = bearer,
  ) {
    const r = await call(path, credential, c);
    assert.equal(r.status, expected, JSON.stringify(r.body));
    return r;
  }
  assert.equal((await call('', null)).status, 401);
  assert.equal((await call('', bearer)).status, 200);
  assert.deepEqual((await call('', bearer)).body, { items: [] });
  assert.equal((await call('/lookups')).body['canCreateLead'], false);
  pass(
    'verified identity even when no grants or visible items; role grants nothing',
  );
  for (const cap of ['view', 'maintain', 'amount', 'internal'])
    await grant('opportunity.' + cap);
  const creation: CreateOpportunityCommand = {
    opportunityId: opp,
    clientMutationId: randomUUID(),
    expectedVersion: 0,
    code: 'TEST-DG06-ONE',
    facts: blankOpportunityFacts('TEST one sentence'),
    sources: [],
  };
  for (const sourceDocumentId of [unclassifiedDocument, contractDocument]) {
    const rejected = {
      ...creation,
      opportunityId: randomUUID(),
      clientMutationId: randomUUID(),
      code: null,
      sources: [{ ...sourceBinding, sourceDocumentId }],
    };
    await post('', rejected, 400);
    assert.ok(
      !((await call('/lookups')).body['sources'] as { id: string }[]).some(
        (x: { id: string }) => x.id === sourceDocumentId,
      ),
    );
    assert.equal(
      (
        await owner.query(
          'SELECT id FROM "Opportunity" WHERE "orgId"=$1 AND id=$2',
          [org, rejected.opportunityId],
        )
      ).rows.length,
      0,
    );
  }
  pass(
    'unclassified and contract-classified sources cannot be listed or bound by opportunity grants',
  );
  await post('', creation);
  const first = await detail();
  assert.equal(first.revision.facts.informationOwnerPersonId, null);
  assert.equal(first.decisionIsDefault, true);
  assert.equal(first.decisionVersion, 0);
  assert.equal(first.effectiveDecision.kind, 'CONTINUE');
  assert.deepEqual(first.revision.facts.dates.expectedSigning, {
    state: 'UNKNOWN',
    value: null,
  });
  assert.equal(
    (
      await owner.query(
        'SELECT capability,source FROM "OpportunityGrant" WHERE "orgId"=$1 AND "opportunityId"=$2',
        [org, opp],
      )
    ).rows.length,
    2,
  );
  await post('', creation);
  assert.equal(
    (
      await owner.query(
        'SELECT id FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2',
        [org, opp],
      )
    ).rows.length,
    1,
  );
  const tempDecide = await grant('opportunity.decide');
  for (const sourceDocumentId of [unclassifiedDocument, contractDocument]) {
    const sources = [{ ...sourceBinding, sourceDocumentId }];
    await post('/' + opp + '/updates', { ...update(), sources }, 400);
    await post('/' + opp + '/requests', { ...request(), sources }, 400);
    await post(
      '/' + opp + '/decisions',
      { ...decision(0, null), actualDecisionPersonId: person, sources },
      400,
    );
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id',$1,true)", [org]);
      const recordId = (
        await owner.query<{ id: string }>(
          'SELECT id FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2 AND n=1',
          [org, opp],
        )
      ).rows[0]!.id;
      await assert.rejects(
        c.query(
          'INSERT INTO "OpportunityRecordSource"(id,"orgId","recordId","sourceDocumentId",reference,location) VALUES($1,$2,$3,$4,\'TEST forbidden\',\'TEST A1\')',
          [randomUUID(), org, recordId, sourceDocumentId],
        ),
        /source is not eligible/,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  await revoke(tempDecide);
  await assert.rejects(
    appPool.query(
      'INSERT INTO "OpportunitySourceIntake"(id,"orgId","sourceDocumentId",basis,"registeredBy") VALUES($1,$2,$3,\'TEST self classification\',$4)',
      [randomUUID(), org, unclassifiedDocument, account],
    ),
    /permission denied/,
  );
  pass(
    'all mutation kinds and application-role source insert reject ineligible documents; no self-classification',
  );
  pass('minimal lead + Q6 exact-account grant transaction + fixed-key replay');
  const creationMaintainers = (
    await owner.query<{ id: string }>(
      'SELECT id FROM "OpportunityGrant" WHERE "orgId"=$1 AND "accountId"=$2 AND capability=\'opportunity.maintain\' AND scope=\'ORG\'',
      [org, account],
    )
  ).rows;
  for (const g of creationMaintainers) await revoke(g.id);
  const forbiddenCreation = {
    ...creation,
    opportunityId: randomUUID(),
    clientMutationId: randomUUID(),
    code: 'TEST-REVOKED-CREATION',
  };
  await post('', forbiddenCreation, 403);
  await post('', creation, 403);
  assert.equal((await call('/lookups')).body['canCreateLead'], false);
  for (const table of [
    'Opportunity',
    'OpportunityRecord',
    'OpportunityGrant',
  ]) {
    const column = table === 'Opportunity' ? 'id' : 'opportunityId';
    assert.equal(
      (
        await owner.query(
          `SELECT id FROM "${table}" WHERE "orgId"=$1 AND "${column}"=$2`,
          [org, forbiddenCreation.opportunityId],
        )
      ).rows.length,
      0,
    );
  }
  await grant('opportunity.maintain');
  pass(
    'revoked ORG creation authority refuses new creation and stored replay despite retained Q6 exact-opportunity grants',
  );

  const concurrentCreates = [0, 1].map(() => ({
    ...creation,
    opportunityId: randomUUID(),
    clientMutationId: randomUUID(),
    code: null,
  }));
  await Promise.all(concurrentCreates.map((c) => post('', c)));
  assert.equal(
    (
      await owner.query(
        'SELECT id FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=ANY($2::uuid[])',
        [org, concurrentCreates.map((c) => c.opportunityId)],
      )
    ).rows.length,
    2,
  );
  assert.equal(
    (
      await owner.query(
        'SELECT id FROM "OpportunityGrant" WHERE "orgId"=$1 AND "opportunityId"=ANY($2::uuid[])',
        [org, concurrentCreates.map((c) => c.opportunityId)],
      )
    ).rows.length,
    4,
  );
  pass(
    'same account concurrent creates commit without Q6 authzVersion lock upgrade deadlock',
  );
  const twinCreateGrant = await grant(
    'opportunity.maintain',
    twin,
    person,
    twinMember,
  );
  const sharedCode = 'TEST-CONCURRENT-CODE',
    codeCommands = [0, 1].map(() => ({
      ...creation,
      opportunityId: randomUUID(),
      clientMutationId: randomUUID(),
      code: sharedCode,
    }));
  const codeResults = await Promise.all(
    codeCommands.map((c, i) => call('', i === 0 ? bearer : twinBearer, c)),
  );
  assert.deepEqual(codeResults.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    codeResults.find((r) => r.status === 409)!.body['code'],
    'IDENTITY_EXISTS',
  );
  assert.equal(
    (
      await owner.query(
        'SELECT id FROM "Opportunity" WHERE "orgId"=$1 AND code=$2',
        [org, sharedCode],
      )
    ).rows.length,
    1,
  );
  await revoke(twinCreateGrant);
  pass(
    'different accounts racing for one code yield one commit and one typed identity conflict',
  );
  const concurrentId = concurrentCreates[0]!.opportunityId;
  const casCommands = [0, 1].map((i) => ({
    ...update([
      {
        field: 'name' as const,
        before: creation.facts.name,
        after: 'TEST competing name ' + i,
        reason: 'TEST correction',
        basis: null,
      },
    ]),
    opportunityId: concurrentId,
    expectedVersion: 1,
  }));
  const casResults = await Promise.all(
    casCommands.map((c) => call('/' + concurrentId + '/updates', bearer, c)),
  );
  assert.deepEqual(casResults.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    casResults.find((r) => r.status === 409)!.body['code'],
    'VERSION_CONFLICT',
  );
  assert.equal(
    (
      await owner.query(
        'SELECT id FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2',
        [org, concurrentId],
      )
    ).rows.length,
    2,
  );
  pass(
    'concurrent field updates from one baseline append one winner and reject the other atomically',
  );
  for (const mutate of [
    (f: OpportunityFacts) => {
      f.informationOwnerPersonId = foreignPerson;
    },
    (f: OpportunityFacts) => {
      f.assistantPersonIds = [foreignPerson];
    },
    (f: OpportunityFacts) => {
      f.parties = [
        {
          id: randomUUID(),
          role: 'OWNER',
          rawName: { state: 'VALUE', value: 'TEST raw' },
          companyId: foreignCompany,
        },
      ];
    },
  ]) {
    const c = structuredClone(creation);
    c.opportunityId = randomUUID();
    c.clientMutationId = randomUUID();
    c.code = null;
    mutate(c.facts);
    await post('', c, 400);
    assert.equal(
      (
        await owner.query(
          'SELECT id FROM "Opportunity" WHERE "orgId"=$1 AND id=$2',
          [org, c.opportunityId],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await owner.query(
          'SELECT id FROM "OpportunityGrant" WHERE "orgId"=$1 AND "opportunityId"=$2',
          [org, c.opportunityId],
        )
      ).rows.length,
      0,
    );
  }
  await post(
    '',
    {
      ...creation,
      opportunityId: randomUUID(),
      clientMutationId: randomUUID(),
      code: null,
      sources: [{ ...sourceBinding, sourceDocumentId: foreignDocument }],
    },
    400,
  );
  pass(
    'foreign-tenant Person/collaborator/Company/source creates roll back object, event and automatic grants',
  );
  assert.equal((await call('/' + opp, twinBearer)).status, 404);
  assert.equal((await call('/' + opp, foreignBearer)).status, 404);
  assert.deepEqual((await call('', twinBearer)).body, { items: [] });
  pass(
    'same Person other account and other tenant inherit no view or maintenance',
  );
  const rich = update();
  rich.expectedVersion = 1;
  rich.newFact = 'TEST permit application received';
  rich.noMaterialChange = false;
  rich.evidence = 'TEST protected evidence 123.45';
  rich.sources = [sourceBinding];
  const old = first.revision.facts;
  const after = blankOpportunityFacts(old.name);
  after.businessLine = { state: 'VALUE', value: 'TEST A' };
  after.informationOwnerPersonId = person;
  after.assistantPersonIds = [deciderPerson];
  after.internalNote = { state: 'VALUE', value: 'TEST secret 123.45' };
  after.parties = [
    {
      id: randomUUID(),
      role: 'OWNER',
      rawName: { state: 'VALUE', value: 'TEST original company' },
      companyId: company,
    },
  ];
  after.ownerProject.reportedScale = {
    value: { state: 'VALUE', value: '0.000000' },
    unitRaw: 'MWp',
    basis: { state: 'VALUE', value: 'TEST owner project total' },
  };
  after.ownerProject.conditions = [
    {
      id: randomUUID(),
      summary: 'TEST permit',
      responsibleRaw: { state: 'UNKNOWN', value: null },
      status: 'UNKNOWN',
      basis: 'TEST private condition 123.45',
    },
  ];
  after.proposedScopes = [
    {
      id: randomUUID(),
      roleRaw: { state: 'VALUE', value: 'TEST PC' },
      summary: { state: 'VALUE', value: 'TEST phase one only' },
      scale: {
        value: { state: 'UNKNOWN', value: null },
        unitRaw: 'MWh',
        basis: { state: 'UNKNOWN', value: null },
      },
    },
  ];
  after.dates.expectedSigning = { state: 'VALUE', value: '2026-12-01' };
  rich.changes = [
    {
      field: 'businessLine',
      before: old.businessLine,
      after: after.businessLine,
      reason: 'TEST first classification',
      basis: null,
    },
    {
      field: 'informationOwnerPersonId',
      before: null,
      after: person,
      reason: '',
      basis: null,
    },
    {
      field: 'assistantPersonIds',
      before: [],
      after: after.assistantPersonIds,
      reason: '',
      basis: null,
    },
    {
      field: 'internalNote',
      before: { state: 'BLANK', value: null },
      after: after.internalNote,
      reason: '',
      basis: null,
    },
    {
      field: 'parties',
      before: [],
      after: after.parties,
      reason: '',
      basis: null,
    },
    {
      field: 'ownerProject',
      before: creation.facts.ownerProject,
      after: after.ownerProject,
      reason: 'TEST reported source',
      basis: null,
    },
    {
      field: 'proposedScopes',
      before: [],
      after: after.proposedScopes,
      reason: '',
      basis: null,
    },
    {
      field: 'dates',
      before: old.dates,
      after: after.dates,
      reason: 'TEST signing expectation',
      basis: null,
    },
  ];
  rich.nextStep = {
    mode: 'REPLACE',
    baseStepId: null,
    next: {
      id: randomUUID(),
      action: 'TEST ask for permit status',
      ownerPersonId: person,
      dueOn: { state: 'UNKNOWN', value: null },
    },
  };
  await post('/' + opp + '/updates', rich);
  const second = await detail();
  assert.equal(second.version, 2);
  assert.equal(second.rescheduleCount, 0);
  assert.equal(second.lastSubstantiveProgress?.newFact, rich.newFact);
  assert.equal(
    second.revision.facts.ownerProject.reportedScale.value.value,
    '0.000000',
  );
  assert.equal(
    (await history()).updates[0]!.changes.find((x) => x.field === 'dates')!
      .dateChange,
    'CERTAINTY',
  );
  assert.equal(
    (await history()).revisions[0]!.facts.internalNote.visibility,
    'visible',
  );
  pass(
    'append facts and preserved metadata, zero/state/unit/basis, separate project/scope, certainty history',
  );
  const beforeCounts = await owner.query(
    'SELECT count(*)::int AS n FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2',
    [org, opp],
  );
  const stale = structuredClone(rich);
  stale.clientMutationId = randomUUID();
  await post('/' + opp + '/updates', stale, 409);
  assert.deepEqual(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2',
        [org, opp],
      )
    ).rows,
    beforeCounts.rows,
  );
  pass('stale compound update is atomic: no event/history/step/partial facts');
  const newer = update();
  newer.nextStep = {
    mode: 'REPLACE',
    baseStepId: second.nextStep!.id,
    next: {
      id: randomUUID(),
      action: 'TEST revised next step',
      ownerPersonId: null,
      dueOn: { state: 'UNKNOWN', value: null },
    },
  };
  await post('/' + opp + '/updates', newer);
  const staleStep = update();
  staleStep.nextStep = {
    mode: 'COMPLETE_AND_ADD',
    baseStepId: second.nextStep!.id,
    next: {
      id: randomUUID(),
      action: 'TEST stale replacement',
      ownerPersonId: person,
      dueOn: { state: 'UNKNOWN', value: null },
    },
  };
  await post('/' + opp + '/updates', staleStep, 409);
  await post('/' + opp + '/updates', update());
  assert.equal((await detail()).nextStep!.id, newer.nextStep.next.id);
  const complete = update();
  complete.nextStep = {
    mode: 'COMPLETE_AND_ADD',
    baseStepId: newer.nextStep.next.id,
    next: {
      id: randomUUID(),
      action: 'TEST new action',
      ownerPersonId: person,
      dueOn: { state: 'VALUE', value: '2026-12-03' },
    },
  };
  await post('/' + opp + '/updates', complete);
  assert.equal(
    (await history()).updates.at(-1)!.completedStepId,
    newer.nextStep.next.id,
  );
  assert.equal(
    (await detail()).lastSubstantiveProgress!.id,
    second.lastSubstantiveProgress!.id,
  );
  pass(
    'stale step refuses overwrite; explicit KEEP, REPLACE, COMPLETE_AND_ADD; no-change only advances contact',
  );
  const signing = update();
  const current = await detail(),
    dates = structuredClone(current.revision.facts.dates);
  dates.expectedSigning = { state: 'VALUE', value: '2027-01-01' };
  signing.expectedVersion = current.version;
  signing.changes = [
    {
      field: 'dates',
      before: current.revision.facts.dates,
      after: dates,
      reason: 'TEST client changed signing date',
      basis: null,
    },
  ];
  await post('/' + opp + '/updates', signing);
  assert.equal((await detail()).rescheduleCount, 1);
  pass('specific-to-specific signing date counts one reschedule');
  await grant('opportunity.view', decider, deciderPerson, deciderMember);
  const actualDecisionGrant = await grant(
    'opportunity.decide',
    decider,
    deciderPerson,
    deciderMember,
  );
  await post('/' + opp + '/decisions', decision(0, null), 403);
  await post('/' + opp + '/decisions', decision(0, null), 200, deciderBearer);
  assert.equal((await detail()).effectiveDecision.kind, 'PAUSE');
  assert.equal((await detail()).decisionIsDefault, false);
  const req = request();
  await post('/' + opp + '/requests', req);
  assert.equal((await detail()).effectiveDecision.kind, 'PAUSE');
  assert.equal((await detail()).pendingRequest!.id, req.requestId);
  await post('/' + opp + '/requests', request(), 409);
  await post(
    '/' + opp + '/decisions',
    decision(0, req.requestId),
    409,
    deciderBearer,
  );
  await post(
    '/' + opp + '/decisions',
    decision(1, req.requestId, 'EXIT'),
    200,
    deciderBearer,
  );
  const reentry = request();
  await post('/' + opp + '/requests', reentry);
  assert.equal((await detail()).effectiveDecision.kind, 'EXIT');
  assert.equal((await detail()).pendingRequest!.id, reentry.requestId);
  await post('/' + opp + '/updates', update(), 403, deciderBearer);
  pass(
    'first pause/exit/re-entry need decide; requests never change pursuit; decide does not confer maintenance',
  );
  await grant('opportunity.decide');
  const proxy = decision(2, reentry.requestId, 'CONTINUE');
  proxy.proxy = {
    basis: 'TEST explicit proxy authority',
    from: { state: 'VALUE', value: '2026-01-01' },
    until: { state: 'UNKNOWN', value: null },
  };
  await post('/' + opp + '/decisions', proxy);
  const d = (await history()).decisions.at(-1)!;
  assert.equal(d.actualDecisionPersonId, deciderPerson);
  assert.equal(d.recordedByAccountId, account);
  assert.equal(d.proxy.visibility, 'visible');
  const badProxy = decision(3, null);
  badProxy.actualDecisionPersonId = foreignPerson;
  badProxy.proxy = proxy.proxy;
  await post('/' + opp + '/decisions', badProxy, 400);
  pass(
    'proxy requires actual Person decision grant plus basis and period; actor identity stays separate',
  );
  await revoke(actualDecisionGrant);
  await post('/' + opp + '/decisions', proxy, 400);
  assert.equal((await detail()).decisionVersion, 3);
  await grant('opportunity.decide', decider, deciderPerson, deciderMember);
  pass(
    'revoked actual Person authority rejects previously stored proxy replay without another decision',
  );
  const allCaps = ['view', 'maintain', 'amount', 'internal', 'decide'] as const;
  let matrixCases = 0;
  for (const scope of ['ORG', 'BUSINESS_LINE', 'OPPORTUNITY'] as const) {
    for (let mask = 0; mask < 32; mask++) {
      const a = randomUUID(),
        p = randomUUID(),
        obj = randomUUID(),
        m = randomUUID();
      await personRow(p, org);
      await accountRow(a, org, p, obj, m);
      const chosen = allCaps.filter((_c, index) => (mask & (1 << index)) !== 0);
      const gs = [];
      for (const cap of chosen)
        gs.push(
          await grant(
            'opportunity.' + cap,
            a,
            p,
            m,
            scope,
            scope === 'BUSINESS_LINE' ? 'TEST A' : null,
            scope === 'OPPORTUNITY' ? opp : null,
          ),
        );
      const credential = await token(obj),
        visible = chosen.includes('view'),
        text =
          visible && chosen.includes('amount') && chosen.includes('internal');
      for (const path of [
        '',
        '/' + opp,
        '/' + opp + '/history',
        '/worklists',
      ]) {
        const r = await call(path, credential);
        assert.equal(
          r.status,
          path.startsWith('/' + opp) && !visible ? 404 : 200,
        );
        if (r.status === 200) {
          const payload = JSON.stringify(r.body);
          assert.equal(payload.includes('TEST secret 123.45'), text);
          if (!text)
            assert.ok(
              !payload.includes('TEST protected') &&
                !payload.includes('TEST private condition') &&
                !payload.includes('TEST explicit proxy'),
            );
        }
        matrixCases++;
      }
      assert.equal((await call('/lookups', credential)).status, 200);
      matrixCases++;
      const maintained = visible && chosen.includes('maintain');
      await post(
        '/' + opp + '/updates',
        update(),
        visible ? (maintained ? 200 : 403) : 404,
        credential,
      );
      const rq = request((await detail()).pendingRequest?.id ?? null);
      await post(
        '/' + opp + '/requests',
        rq,
        visible ? (maintained ? 200 : 403) : 404,
        credential,
      );
      if (maintained && !text) {
        const r = await call('/' + opp, credential);
        const item = r.body as unknown as OpportunityItemDto;
        assert.equal(item.pendingRequest!.explanation.visibility, 'restricted');
      }
      const ds = await detail(),
        dc = decision(
          ds.decisionVersion,
          ds.pendingRequest?.id ?? null,
          'CONTINUE',
        );
      dc.actualDecisionPersonId = p;
      await post(
        '/' + opp + '/decisions',
        dc,
        visible ? (chosen.includes('decide') ? 200 : 403) : 404,
        credential,
      );
      for (const g of gs) await revoke(g);
      assert.equal((await call('/' + opp, credential)).status, 404);
    }
  }
  pass(
    `capability/scope/path matrix ${matrixCases} real HTTP read cases + write/request/revocation controls`,
  );
  const scopeAccount = randomUUID(),
    scopePerson = randomUUID(),
    scopeOid = randomUUID(),
    scopeMember = randomUUID();
  await personRow(scopePerson, org);
  await accountRow(scopeAccount, org, scopePerson, scopeOid, scopeMember);
  for (const cap of ['view', 'maintain', 'amount', 'internal'])
    await grant(
      'opportunity.' + cap,
      scopeAccount,
      scopePerson,
      scopeMember,
      'BUSINESS_LINE',
      'TEST B',
    );
  assert.equal((await call('/' + opp, await token(scopeOid))).status, 404);
  pass('mismatched business line and exact opportunity scopes do not cross');
  await post(
    '',
    {
      ...creation,
      opportunityId: randomUUID(),
      clientMutationId: randomUUID(),
      code: null,
    },
    403,
    await token(scopeOid),
  );
  const exactAccount = randomUUID(),
    exactPerson = randomUUID(),
    exactOid = randomUUID(),
    exactMember = randomUUID();
  await personRow(exactPerson, org);
  await accountRow(exactAccount, org, exactPerson, exactOid, exactMember);
  await grant(
    'opportunity.maintain',
    exactAccount,
    exactPerson,
    exactMember,
    'OPPORTUNITY',
    null,
    opp,
  );
  await post(
    '',
    {
      ...creation,
      opportunityId: randomUUID(),
      clientMutationId: randomUUID(),
      code: null,
    },
    403,
    await token(exactOid),
  );
  pass(
    'BUSINESS_LINE and manual exact-opportunity maintenance cannot create an unscoped lead',
  );

  const current2 = await detail(),
    lineChange = update([
      {
        field: 'businessLine',
        before: current2.revision.facts.businessLine,
        after: { state: 'VALUE', value: 'TEST B' },
        reason: 'TEST recategorize',
        basis: null,
      },
    ]);
  lineChange.expectedVersion = current2.version;
  const onlyA = randomUUID(),
    pA = randomUUID(),
    oidA = randomUUID(),
    mA = randomUUID();
  await personRow(pA, org);
  await accountRow(onlyA, org, pA, oidA, mA);
  for (const cap of ['view', 'maintain', 'amount', 'internal'])
    await grant('opportunity.' + cap, onlyA, pA, mA, 'BUSINESS_LINE', 'TEST A');
  await post('/' + opp + '/updates', lineChange, 403, await token(oidA));
  assert.equal((await detail()).revision.facts.businessLine.value, 'TEST A');
  pass('line change requires every needed grant across both old and new line');
  const payload = update();
  const bodyString = JSON.stringify(payload),
    hash = createHash('sha256').update(bodyString).digest('hex');
  await post('/' + opp + '/updates', payload);
  const afterFixed = (await detail()).version;
  for (let i = 0; i < 3; i++) {
    assert.equal(
      createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      hash,
    );
    await post('/' + opp + '/updates', payload);
  }
  assert.equal((await detail()).version, afterFixed);
  await post(
    '/' + opp + '/updates',
    {
      ...payload,
      noMaterialChange: false,
      newFact: 'TEST changed body',
      evidence: 'TEST source',
    },
    409,
  );
  await post('/' + opp + '/updates', payload, 404, twinBearer);
  pass(
    'fixed payload/key/version replay once, changed body rejected, account switch refuses replay',
  );
  const exp = randomUUID(),
    ep = randomUUID(),
    eo = randomUUID(),
    em = randomUUID();
  await personRow(ep, org);
  await accountRow(exp, org, ep, eo, em);
  await grant('opportunity.view', exp, ep, em, 'ORG', null, null, '2001-01-01');
  assert.equal((await call('/' + opp, await token(eo))).status, 404);
  pass('expired grants rejected at database decision time');
  await grant('opportunity.view', exp, ep, em);
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()-interval \'1 second\' WHERE "orgId"=$1 AND id=$2',
    [org, em],
  );
  assert.equal((await call('/' + opp, await token(eo))).status, 403);
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=NULL WHERE "orgId"=$1 AND id=$2',
    [org, em],
  );
  await owner.query(
    'UPDATE "LoginAccount" SET active=false WHERE "orgId"=$1 AND id=$2',
    [org, exp],
  );
  assert.equal((await call('/' + opp, await token(eo))).status, 403);
  pass(
    'expired membership and inactive account reject otherwise valid explicit grants',
  );
  const all = (
    await owner.query<{ id: string }>(
      'SELECT id FROM "OpportunityGrant" WHERE "orgId"=$1 AND "accountId"=$2 AND NOT EXISTS(SELECT 1 FROM "OpportunityGrantRevocation" r WHERE r."orgId"=$1 AND r."grantId"="OpportunityGrant".id)',
      [org, account],
    )
  ).rows;
  for (const g of all) await revoke(g.id);
  await post('/' + opp + '/updates', payload, 404);
  assert.equal((await call('/' + opp)).status, 404);
  pass('revocation refuses stored replay before returning its result');
  for (const cap of ['view', 'maintain', 'amount', 'internal', 'decide'])
    await grant('opportunity.' + cap);
  const sourceHistoryBefore = (
    await owner.query(
      'SELECT to_jsonb(t) AS row FROM "OpportunityRecordSource" t WHERE "orgId"=$1 ORDER BY id',
      [org],
    )
  ).rows;
  await owner.query(
    'INSERT INTO "ContractSourceIntake"(id,"orgId","sourceDocumentId",direction,basis,"registeredBy") VALUES($1,$2,$3,\'INCOME\',\'TEST later contract classification\',$4)',
    [randomUUID(), org, document, account],
  );
  assert.ok(
    !((await call('/lookups')).body['sources'] as { id: string }[]).some(
      (x) => x.id === document,
    ),
  );
  const hiddenSources = await history();
  assert.ok(
    hiddenSources.updates.some((x) => x.sources.visibility === 'restricted'),
  );
  assert.ok(
    !JSON.stringify(hiddenSources).includes('TEST page 1 table A cell B2'),
  );
  await post('/' + opp + '/updates', rich, 400);
  assert.deepEqual(
    (
      await owner.query(
        'SELECT to_jsonb(t) AS row FROM "OpportunityRecordSource" t WHERE "orgId"=$1 ORDER BY id',
        [org],
      )
    ).rows,
    sourceHistoryBefore,
  );
  await assert.rejects(
    owner.query('UPDATE "OpportunitySourceIntake" SET id=id WHERE "orgId"=$1', [
      org,
    ]),
    /append-only/,
  );
  pass(
    'later contract ownership hides entire historical source fields and denies stored replay without rewriting original references',
  );

  for (const table of [
    'OpportunityRecord',
    'OpportunityRecordPerson',
    'OpportunityRecordCompany',
    'OpportunityRecordSource',
    'OpportunityGrant',
    'OpportunityGrantRevocation',
  ]) {
    await assert.rejects(
      owner.query(`UPDATE "${table}" SET id=id WHERE "orgId"=$1`, [org]),
      /append-only/,
    );
  }
  pass(
    'all opportunity event/source/reference/grant histories are append-only',
  );
  const finalHashes = await existingDomainHashes();
  assert.deepEqual(finalHashes, baselineHashes);
  writeFileSync(
    `/private/tmp/${database}-preservation.json`,
    JSON.stringify(
      {
        TEST: true,
        before: baselineHashes,
        after: finalHashes,
        unchanged: true,
      },
      null,
      2,
    ) + '\n',
  );
  pass(
    'populated daily-close/submitted Revision/source/design quantity/contract snapshots remain byte-equivalent after real DG06 commands',
  );
  const foundationOutput = execFileSync(
    process.execPath,
    ['--env-file=.env', 'scripts/integration.mjs'],
    {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'pipe',
      timeout: 60000,
    },
  );
  writeFileSync(`/private/tmp/${database}-foundation.log`, foundationOutput);
  writeFileSync(`/private/tmp/${database}-foundation.exit`, '0\n');
  pass(
    'existing foundation tenant/time/ledger checks and private Azurite roundtrip on isolated TEST DB',
  );
  writeFileSync(
    `/private/tmp/${database}-summary.json`,
    JSON.stringify(
      {
        database,
        username,
        checks,
        matrixCases,
        remoteReview: 0,
        remoteCI: 0,
        pass: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${checks} groups; database=${database}; role=${username}; matrix=${matrixCases}`,
  );
} catch (e) {
  const error = e as Error & { code?: string };
  console.error(
    'DG06 TEST FAILED ' + (error.code ?? error.name) + ': ' + error.message,
  );
  process.exitCode = 1;
} finally {
  await app?.close();
  await appPool?.end();
  await owner?.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  console.log(
    'RESOURCE RELEASE ' +
      JSON.stringify({
        databaseAbsent:
          (
            await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
              database,
            ])
          ).rows.length === 0,
        roleAbsent:
          (
            await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
              username,
            ])
          ).rows.length === 0,
      }),
  );
  await admin.end();
}
