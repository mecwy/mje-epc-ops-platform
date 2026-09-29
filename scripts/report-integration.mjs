// Site Daily Close (U2.1, slice A2) HTTP + database integration test. Synthetic TEST data only.
// Runs against an isolated database created for this run; the application connects with a
// low-privilege role (no ownership, no RLS bypass) exactly as deployed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
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
  'TEST runner only accepts local database',
);
const suffix = randomBytes(6).toString('hex');
const database = `mje_report_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const admin = new Pool({ connectionString: source.toString() });
const isolated = new URL(source);
isolated.pathname = `/${database}`;
let owner, appPool, app;
let dbCreated = false,
  roleCreated = false,
  checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  dbCreated = true;
  execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: isolated.toString() },
    stdio: 'pipe',
  });
  owner = new Pool({ connectionString: isolated.toString() });
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(isolated);
  appUrl.username = username;
  appUrl.password = password;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 6 });

  // ---------- synthetic TEST tenancy: org A (PM, executive, twin account), org B (PM) ----------
  const tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID();
  const orgA = randomUUID(),
    orgB = randomUUID();
  const projectA = randomUUID(),
    projectA2 = randomUUID(),
    projectB = randomUUID();
  const personPm = randomUUID(),
    personExec = randomUUID(),
    personB = randomUUID();
  const accountPm = randomUUID(),
    accountExec = randomUUID(),
    accountTwin = randomUUID(),
    accountB = randomUUID(),
    accountExpired = randomUUID(),
    accountExecA = randomUUID();
  const objectPm = randomUUID(),
    objectExec = randomUUID(),
    objectTwin = randomUUID(),
    objectB = randomUUID(),
    objectExpired = randomUUID(),
    objectExecA = randomUUID();
  const seedActor = randomUUID();
  for (const [orgId, name] of [
    [orgA, 'TEST Organization A'],
    [orgB, 'TEST Organization B'],
  ])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [orgId, name, seedActor],
    );
  for (const [id, orgId] of [
    [personPm, orgA],
    [personExec, orgA],
    [personB, orgB],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST Person\')',
      [id, orgId, seedActor],
    );
  for (const [id, orgId, code] of [
    [projectA, orgA, 'TEST-A'],
    [projectA2, orgA, 'TEST-A2'],
    [projectB, orgB, 'TEST-B'],
  ])
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,\'Europe/Belgrade\',\'ACTIVE\')',
      [id, orgId, seedActor, code],
    );
  for (const [id, orgId, personId, objectId] of [
    [accountPm, orgA, personPm, objectPm],
    [accountTwin, orgA, personPm, objectTwin],
    [accountExec, orgA, personExec, objectExec],
    [accountB, orgB, personB, objectB],
    [accountExpired, orgA, personPm, objectExpired],
    [accountExecA, orgA, personExec, objectExecA],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, orgId, seedActor, tenantId, objectId, personId],
    );
  const membership = (orgId, accountId, role, projectId) =>
    owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now(),$5,$6)',
      [randomUUID(), orgId, seedActor, role, accountId, projectId],
    );
  await membership(orgA, accountPm, 'PROJECT_MANAGER', projectA);
  await membership(orgA, accountTwin, 'PROJECT_MANAGER', projectA2); // same person, other project only
  await membership(orgA, accountExec, 'EXECUTIVE_READER', null); // org-wide read
  await membership(orgB, accountB, 'PROJECT_MANAGER', projectB);
  await membership(orgA, accountExecA, 'EXECUTIVE_READER', projectA); // one project only
  await owner.query(
    'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","activeUntil","accountId","projectId") VALUES($1,$2,now(),$3,\'PROJECT_MANAGER\',now()-interval \'2 days\',now()-interval \'1 hour\',$4,$5)',
    [randomUUID(), orgA, seedActor, accountExpired, projectA],
  );

  const keys = await generateKeyPair('RS256');
  const key = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [key] }));
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function token(oid) {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      tid: tenantId,
      oid,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-subject',
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .sign(keys.privateKey);
  }
  const pm = await token(objectPm),
    expired = await token(objectExpired),
    execA = await token(objectExecA),
    exec = await token(objectExec),
    twin = await token(objectTwin),
    pmB = await token(objectB);
  async function call(path, bearer, body) {
    const response = await fetch(base + '/api/report' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': body.clientMutationId,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }
  const expectStatus = async (promise, status, code) => {
    const r = await promise;
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (code) assert.equal(r.body.code, code);
    return r.body;
  };
  const D1 = '2026-10-05',
    D2 = '2026-10-06',
    D4 = '2026-10-08';
  const facts = (over = {}) => ({
    weather: '晴',
    temperature: '18℃',
    qty: { support: '120', rail: '' },
    cumulative: { support: '1200' },
    narrative: { construction: 'TEST', quality: '', safety: '' },
    people: { manager: '1', installer: '8' },
    presence: { [personPm]: 'present' },
    machinery: { crane: '1' },
    materials: { rail: '300' },
    milestones: {},
    noWork: null,
    updated: { support: '2026-10-05T15:00:00+02:00' },
    ...over,
  });
  const cmd = (over = {}) => ({
    projectId: projectA,
    businessDate: D1,
    expectedVersion: 0,
    clientMutationId: randomUUID(),
    ...over,
  });

  // ---------- authentication and roles ----------
  assert.equal((await call('/projects')).status, 401);
  await expectStatus(call('/projects', await token(randomUUID())), 403);
  const projects = await expectStatus(call('/projects', pm), 200);
  assert.deepEqual(
    projects.projects.map((p) => [p.code, p.access]),
    [['TEST-A', 'write']],
  );
  const execProjects = await expectStatus(call('/projects', exec), 200);
  assert.deepEqual(
    execProjects.projects.map((p) => [p.code, p.access]),
    [
      ['TEST-A', 'read'],
      ['TEST-A2', 'read'],
    ],
  );
  pass(
    'no token 401; unknown identity 403; PM writes one project; executive reads the org',
  );

  await expectStatus(
    call('/items', pm, {
      projectId: projectA,
      clientMutationId: randomUUID(),
      items: [
        {
          kind: 'work',
          key: 'support',
          label: '支架',
          unit: 'set',
          designQty: '9600',
        },
        {
          kind: 'work',
          key: 'rail',
          label: '导轨',
          unit: 'm',
          designQty: '16800',
        },
        { kind: 'machinery', key: 'crane', label: '吊车' },
        {
          kind: 'material',
          key: 'rail',
          label: '导轨',
          unit: 'm',
          openingCumulative: '12000',
        },
      ],
    }),
    200,
  );
  await expectStatus(
    call('/facts', exec, cmd({ facts: facts() })),
    403,
    'READ_ONLY',
  );
  await expectStatus(
    call('/items', exec, {
      projectId: projectA,
      clientMutationId: randomUUID(),
      items: [{ kind: 'work', key: 'x', label: 'x' }],
    }),
    403,
    'READ_ONLY',
  );
  await expectStatus(
    call('/facts', twin, cmd({ facts: facts() })),
    403,
    'FORBIDDEN',
  );
  await expectStatus(
    call('/facts', pmB, cmd({ facts: facts() })),
    403,
    'FORBIDDEN',
  );
  await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pmB),
    403,
  );
  await expectStatus(call('/projects', expired), 403, 'FORBIDDEN');
  await expectStatus(
    call('/facts', expired, cmd({ facts: facts() })),
    403,
    'FORBIDDEN',
  );
  const execAProjects = await expectStatus(call('/projects', execA), 200);
  assert.deepEqual(
    execAProjects.projects.map((p) => [p.code, p.access]),
    [['TEST-A', 'read']],
  );
  await expectStatus(
    call(`/day?projectId=${projectA2}&businessDate=${D1}`, execA),
    403,
    'FORBIDDEN',
  );
  pass(
    'executive cannot write; same person on another project cannot write; other org cannot read or write; an expired membership is refused; a project-scoped executive sees only that project',
  );

  // ---------- reading never creates a day ----------
  const empty = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(empty.state, 'empty');
  assert.equal(empty.version, 0);
  assert.deepEqual(
    empty.items.map((i) => `${i.kind}:${i.key}`),
    ['machinery:crane', 'material:rail', 'work:support', 'work:rail'],
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "DailyClose"')).rows[0]
      .n,
    0,
  );
  pass('GET day on an unknown date returns an empty view and writes nothing');

  // ---------- plans: draft is not a baseline; confirm once ----------
  const planTarget = { projectId: projectA, targetBusinessDate: D1 };
  await expectStatus(
    call('/plan/draft', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
      rows: [
        { item: 'support', target: '300' },
        { item: 'rail', target: '' },
      ],
    }),
    200,
  );
  let view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(view.baseline, null);
  assert.deepEqual(view.planStatus, { status: 'draft', n: null });
  const confirmed = await expectStatus(
    call('/plan/confirm', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
    }),
    200,
  );
  assert.equal(confirmed.n, 1);
  assert.deepEqual(confirmed.rows, [{ item: 'support', target: '300' }]);
  await expectStatus(
    call('/plan/confirm', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
    }),
    409,
    'PLAN_NO_CHANGE',
  );
  await expectStatus(
    call('/plan/draft', pm, {
      projectId: projectA,
      targetBusinessDate: D2,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '' }],
    }),
    200,
  );
  await expectStatus(
    call('/plan/confirm', pm, {
      projectId: projectA,
      targetBusinessDate: D2,
      clientMutationId: randomUUID(),
    }),
    409,
    'PLAN_EMPTY',
  );
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.deepEqual(view.baseline, {
    n: 1,
    rows: [{ item: 'support', target: '300' }],
  });
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "PlanVersion"')).rows[0]
      .n,
    1,
  );
  pass(
    'plan draft is never the baseline; confirm creates v1 once; no change / empty plan are rejected',
  );

  // ---------- facts: versions, concurrency, idempotency ----------
  const first = cmd({ facts: facts() });
  const saved = await expectStatus(call('/facts', pm, first), 200);
  assert.deepEqual(saved, { businessDate: D1, version: 1, state: 'draft' });
  const replay = await expectStatus(call('/facts', pm, first), 200);
  assert.deepEqual(replay, saved);
  await expectStatus(
    call('/facts', pm, { ...first, facts: facts({ weather: '雨' }) }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expectStatus(
    call('/facts', pm, cmd({ facts: facts() })),
    409,
    'VERSION_CONFLICT',
  ); // expectedVersion 0 again
  const race = await Promise.all([
    call(
      '/facts',
      pm,
      cmd({ expectedVersion: 1, facts: facts({ weather: 'A' }) }),
    ),
    call(
      '/facts',
      pm,
      cmd({ expectedVersion: 1, facts: facts({ weather: 'B' }) }),
    ),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(view.version, 2);
  assert.ok(['A', 'B'].includes(view.facts.weather));
  assert.equal(view.state, 'draft');
  assert.deepEqual(view.cumulativeBase, {});
  assert.deepEqual(view.materialsCumulative, {
    rail: { value: '12300', complete: true },
  }); // opening 12000 + today 300
  pass(
    'expectedVersion 0 creates; replay returns the same body; key reuse with a new body 409; concurrent saves: exactly one wins',
  );

  await expectStatus(
    call(
      '/facts',
      pm,
      cmd({ expectedVersion: 2, facts: facts({ qty: { support: 'abc' } }) }),
    ),
    400,
    'INVALID_INPUT',
  );
  await expectStatus(
    call('/facts', pm, {
      ...cmd({ expectedVersion: 2, facts: facts() }),
      projectId: 'not-a-uuid',
    }),
    400,
  );
  const wrongKey = cmd({ expectedVersion: 2, facts: facts() });
  const mismatch = await fetch(base + '/api/report/facts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pm}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(wrongKey),
  });
  assert.equal(mismatch.status, 400);
  pass(
    'malformed numbers, ids and a mismatched Idempotency-Key are rejected before any write',
  );

  // ---------- submit: coverage recorded, never blocking; then locked ----------
  const submitted = await expectStatus(
    call('/submit', pm, cmd({ expectedVersion: 2 })),
    200,
  );
  assert.equal(submitted.revisionNumber, 1);
  assert.equal(submitted.state, 'submitted');
  assert.ok(
    submitted.coverage.missing.some(
      (m) => m.key === 'cumulative' || m.key === 'photo' || m.key === 'quality',
    ),
  );
  assert.deepEqual(submitted.coverage.invalid, []);
  const rev1 = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D1}&n=1`, pm),
    200,
  );
  assert.equal(rev1.snapshot.facts.weather, view.facts.weather);
  assert.deepEqual(rev1.snapshot.baseline, {
    n: 1,
    rows: [{ item: 'support', target: '300' }],
  });
  assert.deepEqual(rev1.snapshot.nextPlan.status, 'draft'); // D2 draft existed at submit time
  assert.equal(rev1.snapshot.previousSubmittedDate, null);
  await expectStatus(
    call(
      '/facts',
      pm,
      cmd({ expectedVersion: 3, facts: facts({ weather: 'late' }) }),
    ),
    409,
    'LOCKED',
  );
  await expectStatus(
    call('/submit', pm, cmd({ expectedVersion: 3 })),
    409,
    'LOCKED',
  );
  await expectStatus(
    call('/no-work', pm, cmd({ expectedVersion: 3, reason: 'rest', note: '' })),
    409,
    'LOCKED',
  );
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(view.state, 'submitted');
  assert.equal(view.version, 3); // failed writes did not bump the version
  pass(
    'submit freezes revision 1 with baseline, next-plan status and coverage; the day is then locked',
  );

  // ---------- rule 1: later plan and item changes do not alter the submitted snapshot ----------
  await expectStatus(
    call('/plan/draft', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '350' }],
    }),
    200,
  );
  await expectStatus(
    call('/plan/confirm', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
    }),
    200,
  );
  await expectStatus(
    call('/plan/confirm', pm, {
      projectId: projectA,
      targetBusinessDate: D2,
      clientMutationId: randomUUID(),
    }),
    409,
    'PLAN_EMPTY',
  );
  await expectStatus(
    call('/items', pm, {
      projectId: projectA,
      clientMutationId: randomUUID(),
      items: [
        {
          kind: 'work',
          key: 'support',
          label: '支架（改）',
          unit: 'set',
          designQty: '9700',
        },
      ],
    }),
    200,
  );
  const rev1Again = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D1}&n=1`, pm),
    200,
  );
  assert.deepEqual(rev1Again.snapshot, rev1.snapshot);
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.deepEqual(view.baseline, {
    n: 2,
    rows: [{ item: 'support', target: '350' }],
  }); // live view moves on
  pass(
    'a new plan version and edited master rows leave revision 1 byte-for-byte unchanged',
  );

  // ---------- rule 2: correction = reason + new revision; v1 preserved; cancel restores ----------
  const dayVersion = async (date) =>
    (
      await expectStatus(
        call(`/day?projectId=${projectA}&businessDate=${date}`, pm),
        200,
      )
    ).version;
  const correction = (path, bearer, over) =>
    call(`/correction/${path}`, bearer, {
      projectId: projectA,
      businessDate: D1,
      clientMutationId: randomUUID(),
      ...over,
    });
  let v = await dayVersion(D1);
  await expectStatus(
    correction('start', pm, { expectedVersion: v, reason: '' }),
    400,
  );
  await expectStatus(
    correction('start', exec, { expectedVersion: v, reason: 'x' }),
    403,
    'READ_ONLY',
  );
  await expectStatus(
    correction('start', pm, {
      businessDate: D2,
      expectedVersion: 0,
      reason: 'x',
    }),
    409,
    'NOT_SUBMITTED',
  );
  await expectStatus(
    correction('cancel', pm, { expectedVersion: v }),
    409,
    'NOT_CORRECTING',
  );
  await expectStatus(
    correction('start', pm, { expectedVersion: v - 1, reason: 'x' }),
    409,
    'VERSION_CONFLICT',
  );
  const correcting = await expectStatus(
    correction('start', pm, {
      expectedVersion: v,
      reason: 'TEST 支架数量填错',
    }),
    200,
  );
  assert.equal(correcting.state, 'correcting');
  const edited = await expectStatus(
    call(
      '/facts',
      pm,
      cmd({
        expectedVersion: correcting.version,
        facts: facts({ weather: 'edited-then-cancelled' }),
      }),
    ),
    200,
  );
  // a cancel sent before the edit arrives after it: refused, the edit survives
  await expectStatus(
    correction('cancel', pm, { expectedVersion: correcting.version }),
    409,
    'VERSION_CONFLICT',
  );
  const cancelled = await expectStatus(
    correction('cancel', pm, { expectedVersion: edited.version }),
    200,
  );
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(view.state, 'submitted');
  assert.equal(view.facts.weather, rev1.snapshot.facts.weather); // draft restored from the snapshot
  const reopened = await expectStatus(
    correction('start', pm, {
      expectedVersion: cancelled.version,
      reason: 'TEST 支架数量填错',
    }),
    200,
  );
  const fixed = await expectStatus(
    call(
      '/facts',
      pm,
      cmd({
        expectedVersion: reopened.version,
        facts: facts({
          qty: { support: '130', rail: '' },
          cumulative: { support: '1210' },
        }),
      }),
    ),
    200,
  );
  const resubmitted = await expectStatus(
    call('/submit', pm, cmd({ expectedVersion: fixed.version })),
    200,
  );
  assert.equal(resubmitted.revisionNumber, 2);
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.deepEqual(
    view.revisions.map((r) => [r.n, r.reason]),
    [
      [1, ''],
      [2, 'TEST 支架数量填错'],
    ],
  );
  assert.deepEqual(
    (
      await expectStatus(
        call(`/revision?projectId=${projectA}&businessDate=${D1}&n=1`, pm),
        200,
      )
    ).snapshot,
    rev1.snapshot,
  );
  const rev2 = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D1}&n=2`, pm),
    200,
  );
  assert.equal(rev2.snapshot.facts.qty.support, '130');
  assert.equal(rev2.snapshot.correctionReason, 'TEST 支架数量填错');
  // correction B is open and edited; a stale cancel from correction A must not wipe it
  const correctionB = await expectStatus(
    correction('start', pm, {
      expectedVersion: view.version,
      reason: 'TEST 天气填错',
    }),
    200,
  );
  const editedB = await expectStatus(
    call(
      '/facts',
      pm,
      cmd({
        expectedVersion: correctionB.version,
        facts: { ...rev2.snapshot.facts, weather: 'TEST B edit' },
      }),
    ),
    200,
  );
  await expectStatus(
    correction('cancel', pm, { expectedVersion: fixed.version }),
    409,
    'VERSION_CONFLICT',
  );
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, pm),
    200,
  );
  assert.equal(view.state, 'correcting');
  assert.equal(view.facts.weather, 'TEST B edit');
  await expectStatus(
    correction('cancel', pm, { expectedVersion: editedB.version }),
    200,
  );
  v = await dayVersion(D1);
  pass(
    'correction needs a reason, a submitted day and the current version; stale cancels are refused; cancel restores the snapshot; resubmit = revision 2, revision 1 intact',
  );

  // ---------- rule 3: carry-over from the last submitted day, however many days back ----------
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D4}`, pm),
    200,
  );
  assert.equal(view.previousSubmittedDate, D1);
  assert.deepEqual(view.cumulativeBase, {
    support: { value: '1210', asOf: D1 },
  });
  // carried from D1; today's receipt is still blank on a work day, so not complete yet
  assert.deepEqual(view.materialsCumulative, {
    rail: { value: '12300', complete: false },
  });
  assert.equal(view.baseline, null);
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "DailyClose"')).rows[0]
      .n,
    1,
  );
  const days = await expectStatus(
    call(`/days?projectId=${projectA}&from=${D1}&to=${D4}`, pm),
    200,
  );
  assert.deepEqual(days, [
    { businessDate: D1, state: 'submitted', revision: 2 },
  ]);
  pass(
    'three days later the cumulative base and material cumulative come from the last submitted day; skipped days create no rows',
  );

  // ---------- rule 6: no work ----------
  const noWork = await expectStatus(
    call(
      '/no-work',
      pm,
      cmd({
        businessDate: D4,
        expectedVersion: 0,
        reason: 'weather',
        note: 'TEST 大雨',
      }),
    ),
    200,
  );
  assert.equal(noWork.revisionNumber, 1);
  assert.deepEqual(noWork.coverage, { missing: [], invalid: [] });
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D4}`, pm),
    200,
  );
  assert.equal(view.state, 'submitted');
  assert.deepEqual(view.facts.noWork, { reason: 'weather', note: 'TEST 大雨' });
  await expectStatus(
    call(
      '/no-work',
      pm,
      cmd({ businessDate: D4, expectedVersion: 1, reason: 'rest', note: '' }),
    ),
    409,
    'LOCKED',
  );
  pass(
    'no-work submits immediately with its reason and no missing items; the day is then locked',
  );

  // ---------- carry-over through a no-work day (D1 → D4 no work → D5) ----------
  const d4 = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D4}&n=1`, pm),
    200,
  );
  assert.deepEqual(d4.snapshot.cumulativeCarry, {
    support: { value: '1210', asOf: D1 },
  });
  assert.deepEqual(d4.snapshot.materialsCumulative, {
    rail: { value: '12300', complete: true },
  });
  const D5 = '2026-10-09';
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D5}`, pm),
    200,
  );
  assert.equal(view.previousSubmittedDate, D4);
  assert.deepEqual(view.cumulativeBase, {
    support: { value: '1210', asOf: D1 },
  });
  pass(
    'a no-work day hands on the last declared cumulative and the material total unchanged',
  );

  // ---------- plan draft vs confirm: every successful save is confirmed or still a draft ----------
  const D6 = '2026-10-10';
  const plan6 = (clientMutationId, target) =>
    call('/plan/draft', pm, {
      projectId: projectA,
      targetBusinessDate: D6,
      clientMutationId,
      rows: [{ item: 'support', target }],
    });
  const confirm6 = () =>
    call('/plan/confirm', pm, {
      projectId: projectA,
      targetBusinessDate: D6,
      clientMutationId: randomUUID(),
    });
  for (let i = 0; i < 5; i++) {
    await expectStatus(plan6(randomUUID(), `${100 + i}`), 200);
    const [confirmed, saved] = await Promise.all([
      confirm6(),
      plan6(randomUUID(), `${200 + i}`),
    ]);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const plan = await expectStatus(
      call(`/plan?projectId=${projectA}&targetBusinessDate=${D6}`, pm),
      200,
    );
    const target = confirmed.body.rows[0].target;
    if (target === `${200 + i}`) assert.equal(plan.draft, null);
    else {
      assert.equal(target, `${100 + i}`);
      assert.deepEqual(plan.draft, [{ item: 'support', target: `${200 + i}` }]);
    }
  }
  await expectStatus(plan6(randomUUID(), '999'), 200);
  const twoConfirms = await Promise.all([confirm6(), confirm6()]);
  assert.deepEqual(twoConfirms.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    twoConfirms.find((r) => r.status === 409).body.code,
    'PLAN_NO_CHANGE',
  );
  const versions6 = (
    await owner.query(
      'SELECT number FROM "PlanVersion" WHERE "targetBusinessDate"=$1::date ORDER BY number',
      [D6],
    )
  ).rows.map((r) => r.number);
  assert.deepEqual(versions6, [1, 2, 3, 4, 5, 6]);
  pass(
    'concurrent draft save and confirm never lose a saved draft; two confirms create one version',
  );

  // ---------- same-key submit twice at once; save vs submit ----------
  const D7 = '2026-10-11',
    D8 = '2026-10-12';
  await expectStatus(
    call('/facts', pm, cmd({ businessDate: D7, facts: facts() })),
    200,
  );
  const sameKey = cmd({ businessDate: D7, expectedVersion: 1 });
  const both = await Promise.all([
    call('/submit', pm, sameKey),
    call('/submit', pm, sameKey),
  ]);
  assert.deepEqual(
    both.map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(both[0].body, both[1].body);
  assert.equal(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM "Revision" r JOIN "DailyClose" d ON d.id=r."dailyCloseId" WHERE d."businessDate"=$1::date`,
        [D7],
      )
    ).rows[0].n,
    1,
  );
  await expectStatus(
    call('/facts', pm, cmd({ businessDate: D8, facts: facts() })),
    200,
  );
  const saveVsSubmit = await Promise.all([
    call(
      '/facts',
      pm,
      cmd({
        businessDate: D8,
        expectedVersion: 1,
        facts: facts({ weather: 'late' }),
      }),
    ),
    call('/submit', pm, cmd({ businessDate: D8, expectedVersion: 1 })),
  ]);
  assert.deepEqual(saveVsSubmit.map((r) => r.status).sort(), [200, 409]);
  view = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D8}`, pm),
    200,
  );
  if (saveVsSubmit[1].status === 200) {
    assert.equal(view.state, 'submitted');
    assert.notEqual(view.facts.weather, 'late');
  } else assert.equal(view.state, 'draft');
  pass(
    'the same submit sent twice at once yields one revision and one response; save and submit on one version: exactly one wins',
  );

  // ---------- executive read ----------
  const execView = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D1}`, exec),
    200,
  );
  assert.equal(execView.access, 'read');
  assert.equal(execView.revisions.length, 2);
  await expectStatus(
    call('/submit', exec, cmd({ expectedVersion: 5 })),
    403,
    'READ_ONLY',
  );
  pass('executive sees the submitted day and its revisions, and cannot submit');

  // ---------- database-level protections: RLS and no updates on revisions ----------
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
    for (const table of [
      'DailyClose',
      'DailyReportDraft',
      'PlanVersion',
      'PlanDraft',
      'ReportItem',
      'Revision',
    ])
      assert.equal(
        (await client.query(`SELECT count(*)::int AS n FROM "${table}"`))
          .rows[0].n,
        0,
        table,
      );
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
    const revisionsA = (
      await client.query('SELECT count(*)::int AS n FROM "Revision"')
    ).rows[0].n;
    assert.equal(
      revisionsA,
      (await owner.query('SELECT count(*)::int AS n FROM "Revision"')).rows[0]
        .n,
    );
    for (const [statement, params] of [
      [
        'INSERT INTO "PlanDraft"(id,"orgId","projectId","targetBusinessDate",rows,"updatedBy") VALUES($1,$2,$3,\'2026-12-01\',\'[]\',$4)',
        [randomUUID(), orgB, projectB, accountB],
      ],
      ['UPDATE "DailyReportDraft" SET "orgId"=$1', [orgB]],
    ]) {
      await client.query('SAVEPOINT rls');
      await assert.rejects(
        client.query(statement, params),
        /row-level security|violates|foreign key/,
        statement,
      );
      await client.query('ROLLBACK TO SAVEPOINT rls');
    }
    // Each denied statement aborts the transaction; a savepoint isolates the next check.
    for (const statement of [
      'UPDATE "Revision" SET reason=\'tamper\'',
      'DELETE FROM "Revision"',
      'DELETE FROM "PlanVersion"',
      'UPDATE "PlanVersion" SET number=9',
    ]) {
      await client.query('SAVEPOINT guard');
      await assert.rejects(
        client.query(statement),
        /permission denied/,
        statement,
      );
      await client.query('ROLLBACK TO SAVEPOINT guard');
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const audits = await owner.query(
    'SELECT action, count(*)::int AS n FROM "AuditLog" GROUP BY action ORDER BY action',
  );
  assert.deepEqual(
    Object.fromEntries(audits.rows.map((r) => [r.action, r.n])),
    {
      // cancel A + cancel B; start A, reopen, start B
      REPORT_CORRECTION_CANCEL: 2,
      REPORT_CORRECTION_START: 3,
      REPORT_NO_WORK: 1,
      // D1 v1, v2; D6 five race rounds + one of two concurrent confirms
      REPORT_PLAN_CONFIRM: 8,
      // D1, D2, D1 again; D6 2 × 5 rounds + '999'
      REPORT_PLAN_DRAFT: 14,
      // D1, race winner, three correction edits, D7, D8 (+ D8 late save if it won)
      REPORT_SAVE_FACTS: saveVsSubmit[0].status === 200 ? 8 : 7,
      REPORT_SAVE_ITEMS: 2,
      // D1, D1 resubmit, D7 once (same key twice), D8 if submit won
      REPORT_SUBMIT: saveVsSubmit[1].status === 200 ? 4 : 3,
    },
  );
  pass(
    'RLS hides every report table from another org and refuses writes into it; the app role cannot update or delete revisions or plan versions; every write is audited',
  );

  console.log(
    `Report HTTP/DB integration: ${checks} checks passed; synthetic TEST data only. Photos, issues, field devices and the web UI are later slices.`,
  );
} finally {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
}
