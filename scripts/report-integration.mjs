// Site Daily Close (U2.1, slice A2) HTTP + database integration test. Synthetic TEST data only.
// Runs against an isolated database created for this run; the application connects with a
// low-privilege role (no ownership, no RLS bypass) exactly as deployed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { AlphaStore, ReportStore } from '../packages/domain/dist/index.js';
// Test hook of the report exit (ADR-0003 D2.2): which projector served a read. It installs only
// in a test process; this runner is one.
process.env.NODE_ENV = 'test';
import { observeReportProjections } from '../packages/domain/dist/report-reader.js';
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
// pool.end() resolves before idle sockets finish closing; DROP DATABASE ... WITH (FORCE) can
// then terminate one (57P01) and the pool would re-emit it as an unhandled 'error'. Only that
// termination, and only after this pool's own end() was called, is ignored; any other pool
// error, or a 57P01 while the pool is in use, still fails the run.
const tolerateShutdown = (pool) => {
  let closing = false;
  const end = pool.end.bind(pool);
  pool.end = () => {
    closing = true;
    return end();
  };
  return pool.on('error', (error) => {
    if (closing && error?.code === '57P01') return;
    throw error;
  });
};
// Resolves once `count` sessions are waiting on the advisory lock for `key` (as taken by
// hashtextextended(key, 0)); fails after a timeout instead of guessing with a sleep.
const waitForLockWaiters = async (key, count, timeoutMs = 15000) => {
  let timer;
  let stopped = false;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${count} lock waiters`)),
      timeoutMs,
    );
  });
  const poll = async () => {
    while (!stopped) {
      const { n } = (
        await owner.query(
          `SELECT count(*)::int AS n FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
            AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
          [key],
        )
      ).rows[0];
      if (n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  // A hard bound: a stalled connection or query cannot outlast the timeout either.
  try {
    await Promise.race([poll(), expired]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
};
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
  owner = tolerateShutdown(new Pool({ connectionString: isolated.toString() }));
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(isolated);
  appUrl.username = username;
  appUrl.password = password;
  appPool = tolerateShutdown(
    new Pool({ connectionString: appUrl.toString(), max: 6 }),
  );

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

  // Deterministic: while another session holds the project/date plan lock, neither a draft
  // save nor a confirm can complete; both finish once it is released.
  const D9 = '2026-10-13';
  let d9Confirmed = false;
  const lockKey = `${orgA}:plan:${projectA}:${D9}`;
  const holder = await owner.connect();
  try {
    await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      lockKey,
    ]);
    const settled = { save: false, confirm: false };
    const draftCmd = {
      projectId: projectA,
      targetBusinessDate: D9,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '321' }],
    };
    const blockedSave = call('/plan/draft', pm, draftCmd).then((r) => {
      settled.save = true;
      return r;
    });
    const blockedConfirm = call('/plan/confirm', pm, {
      projectId: projectA,
      targetBusinessDate: D9,
      clientMutationId: randomUUID(),
    }).then((r) => {
      settled.confirm = true;
      return r;
    });
    // Wait (bounded) until both requests are observed waiting on exactly this lock.
    await waitForLockWaiters(lockKey, 2);
    assert.deepEqual(settled, { save: false, confirm: false });
    await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
      lockKey,
    ]);
    const [saveResult, confirmResult] = await Promise.all([
      blockedSave,
      blockedConfirm,
    ]);
    assert.equal(saveResult.status, 200);
    // the confirm either ran first (no draft yet: empty plan) or after the save (confirms 321)
    d9Confirmed = confirmResult.status === 200;
    if (confirmResult.status === 200)
      assert.deepEqual(confirmResult.body.rows, [
        { item: 'support', target: '321' },
      ]);
    else assert.equal(confirmResult.body.code, 'PLAN_EMPTY');

    // audit contents: a creation has no "before", an overwrite records the previous rows;
    // replaying the same command adds nothing
    const overwrite = {
      ...draftCmd,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '654' }],
    };
    await expectStatus(call('/plan/draft', pm, overwrite), 200);
    const draftAudits = async () =>
      (
        await owner.query(
          `SELECT before, after, reason, "actorAccountId", "correlationId" FROM "AuditLog"
          WHERE action='REPORT_PLAN_DRAFT' AND reason=$1 ORDER BY "createdAt", "correlationId"`,
          [D9],
        )
      ).rows;
    const before = await draftAudits();
    const created = before.find(
      (a) => a.correlationId === draftCmd.clientMutationId,
    );
    const replaced = before.find(
      (a) => a.correlationId === overwrite.clientMutationId,
    );
    assert.equal(created.actorAccountId, accountPm);
    assert.deepEqual(created.after, draftCmd.rows);
    assert.deepEqual(replaced.after, overwrite.rows);
    assert.deepEqual(
      replaced.before,
      confirmResult.status === 200 ? null : draftCmd.rows,
    );
    await expectStatus(call('/plan/draft', pm, overwrite), 200); // replay
    assert.equal((await draftAudits()).length, before.length);
  } finally {
    // Destroy the connection rather than return it: a failure before the unlock would
    // otherwise hand a session that still holds the advisory lock back to the pool.
    holder.release(true);
  }
  pass(
    'concurrent draft save and confirm never lose a saved draft; both wait for the plan lock; two confirms create one version; draft audits record before/after and replays add none',
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

  // ---------- OD18: a reader only ever gets submitted content from the server ----------
  const D10 = '2026-10-14';
  const dayOf = (date, bearer) =>
    expectStatus(
      call(`/day?projectId=${projectA}&businessDate=${date}`, bearer),
      200,
    );
  const planOf = (date, bearer) =>
    expectStatus(
      call(`/plan?projectId=${projectA}&targetBusinessDate=${date}`, bearer),
      200,
    );
  // A response body as text without its random values: a string that is exactly an ISO
  // timestamp or a UUID is left out, so a search for a draft figure cannot match digits inside
  // one (L7), while the figure in any other form ("654 m", "654.0", a label) is still found.
  const RANDOM =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const withoutRandom = (v) =>
    JSON.stringify(v, (_, x) =>
      typeof x === 'string' && RANDOM.test(x) ? undefined : x,
    );
  const blank = {
    weather: '',
    temperature: '',
    qty: {},
    cumulative: {},
    narrative: { construction: '', quality: '', safety: '' },
    people: {},
    presence: {},
    machinery: {},
    materials: {},
    milestones: {},
    noWork: null,
    updated: {},
  };
  const nothing = (r) => {
    assert.equal(r.access, 'read');
    assert.equal(r.state, 'empty');
    assert.equal(r.version, 0);
    assert.equal(r.currentRevisionNumber, 0);
    assert.equal(r.correctionReason, null);
    assert.deepEqual(r.facts, blank);
    assert.equal(r.baseline, null);
    assert.deepEqual(r.planStatus, { status: 'none', n: null });
    assert.deepEqual(r.nextPlan, { status: 'none', n: null, rows: [] });
    assert.equal(r.previousSubmittedDate, null);
    assert.deepEqual(r.cumulativeBase, {});
    assert.deepEqual(r.materialsCumulative, {});
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.photos, []);
    assert.equal(r.unlinkedPhotos, 0);
    assert.deepEqual(r.revisions, []);
  };
  // The day list as sent, byte for byte, before any of the unsubmitted work below.
  const daysText = async (bearer) => {
    const response = await fetch(
      `${base}/api/report/days?projectId=${projectA}&from=${D1}&to=${D10}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    assert.equal(response.status, 200);
    return response.text();
  };
  const readerDaysBefore = await daysText(exec);
  const writerDaysBefore = await daysText(pm);
  // Unsubmitted work: a plan draft for D10 (the day after the empty D9), a D10 draft day,
  // and an open correction on D1 with an edit and a newer confirmed plan for D1.
  await expectStatus(
    call('/plan/draft', pm, {
      projectId: projectA,
      targetBusinessDate: D10,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '7771' }],
    }),
    200,
  );
  await expectStatus(
    call(
      '/facts',
      pm,
      cmd({
        businessDate: D10,
        facts: facts({ weather: 'TEST unsubmitted draft' }),
      }),
    ),
    200,
  );
  const openCorrection = await expectStatus(
    correction('start', pm, {
      expectedVersion: await dayVersion(D1),
      reason: 'TEST reader must not see this',
    }),
    200,
  );
  const correctionEdit = await expectStatus(
    call(
      '/facts',
      pm,
      cmd({
        expectedVersion: openCorrection.version,
        facts: {
          ...rev2.snapshot.facts,
          weather: 'TEST correction in progress',
        },
      }),
    ),
    200,
  );
  await expectStatus(
    call('/plan/draft', pm, {
      ...planTarget,
      clientMutationId: randomUUID(),
      rows: [{ item: 'support', target: '400' }],
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

  // empty day (no row): nothing of the day, not even a next-day plan built from a draft
  nothing(await dayOf(D9, exec));
  const pmD9 = await dayOf(D9, pm);
  assert.equal(pmD9.nextPlan.status, 'draft'); // the writer's live view is unchanged
  // draft day: "not submitted yet", none of the draft facts
  const readerD10 = await dayOf(D10, exec);
  nothing(readerD10);
  assert.ok(!JSON.stringify(readerD10).includes('TEST unsubmitted draft'));
  const pmD10 = await dayOf(D10, pm);
  assert.equal(pmD10.state, 'draft');
  assert.equal(pmD10.facts.weather, 'TEST unsubmitted draft');
  // correcting day: revision 2 as submitted, not the correction draft, its reason or new plan
  const readerD1 = await dayOf(D1, exec);
  assert.equal(readerD1.state, 'submitted');
  assert.equal(readerD1.version, 0);
  assert.equal(readerD1.currentRevisionNumber, 2);
  assert.equal(readerD1.correctionReason, null);
  assert.deepEqual(readerD1.facts, rev2.snapshot.facts);
  assert.deepEqual(readerD1.items, rev2.snapshot.items);
  assert.deepEqual(readerD1.baseline, rev2.snapshot.baseline);
  // C20: revision 2 froze the next-day plan as a draft; a reader gets its status, no rows.
  assert.equal(rev2.snapshot.nextPlan.status, 'draft');
  assert.deepEqual(readerD1.nextPlan, { ...rev2.snapshot.nextPlan, rows: [] });
  assert.deepEqual(readerD1.cumulativeBase, rev2.snapshot.cumulativeBase);
  assert.deepEqual(
    readerD1.materialsCumulative,
    rev2.snapshot.materialsCumulative,
  );
  assert.deepEqual(readerD1.issues, rev2.snapshot.issues);
  assert.deepEqual(readerD1.coverage, rev2.snapshot.coverage);
  assert.deepEqual(readerD1.photos, []);
  assert.equal(readerD1.unlinkedPhotos, 0);
  assert.deepEqual(
    readerD1.revisions.map((r) => [r.n, r.reason]),
    [
      [1, ''],
      [2, 'TEST 支架数量填错'],
    ],
  );
  assert.ok(!JSON.stringify(readerD1).includes('TEST correction in progress'));
  assert.ok(
    !JSON.stringify(readerD1).includes('TEST reader must not see this'),
  );
  const pmD1 = await dayOf(D1, pm);
  assert.equal(pmD1.state, 'correcting');
  assert.equal(pmD1.version, correctionEdit.version);
  assert.equal(pmD1.facts.weather, 'TEST correction in progress');
  assert.equal(pmD1.correctionReason, 'TEST reader must not see this');
  assert.equal(pmD1.baseline.n, 3);
  // submitted no-work day: the frozen revision, read-only version 0
  const readerD4 = await dayOf(D4, exec);
  assert.equal(readerD4.state, 'submitted');
  assert.equal(readerD4.version, 0);
  assert.equal(readerD4.currentRevisionNumber, 1);
  assert.deepEqual(readerD4.facts, d4.snapshot.facts);
  assert.deepEqual(readerD4.facts.noWork, {
    reason: 'weather',
    note: 'TEST 大雨',
  });
  assert.deepEqual(
    readerD4.revisions.map((r) => r.n),
    [1],
  );
  assert.equal((await dayOf(D4, pm)).version, 1);
  // days: only submitted days; a draft day is not listed, a correction in progress is the
  // submitted day. The reader's response is byte-identical to the one before the draft was
  // started and the correction opened; the writer's changed.
  const readerDaysAfter = await daysText(exec);
  const writerDaysAfter = await daysText(pm);
  assert.equal(readerDaysAfter, readerDaysBefore);
  assert.notEqual(writerDaysAfter, writerDaysBefore);
  const writerDays = JSON.parse(writerDaysAfter);
  const readerDays = JSON.parse(readerDaysAfter);
  assert.deepEqual(
    writerDays.find((d) => d.businessDate === D10),
    { businessDate: D10, state: 'draft', revision: 0 },
  );
  assert.deepEqual(
    writerDays.find((d) => d.businessDate === D1),
    { businessDate: D1, state: 'correcting', revision: 2 },
  );
  assert.deepEqual(
    readerDays,
    writerDays
      .filter((d) => ['submitted', 'correcting'].includes(d.state))
      .map((d) => ({ ...d, state: 'submitted' })),
  );
  assert.deepEqual(
    readerDays.find((d) => d.businessDate === D1),
    { businessDate: D1, state: 'submitted', revision: 2 },
  );
  assert.ok(!readerDays.some((d) => d.businessDate === D10));
  // plans: the draft is hidden; confirmed versions stay visible
  const readerPlanD10 = await planOf(D10, exec);
  assert.equal(readerPlanD10.draft, null);
  assert.deepEqual(readerPlanD10.status, { status: 'none', n: null });
  assert.ok(!withoutRandom(readerPlanD10).includes('7771'));
  const writerPlanD10 = await planOf(D10, pm);
  assert.deepEqual(writerPlanD10.draft, [{ item: 'support', target: '7771' }]);
  assert.deepEqual(writerPlanD10.status, { status: 'draft', n: null });
  const readerPlanD9 = await planOf(D9, exec);
  const writerPlanD9 = await planOf(D9, pm);
  assert.deepEqual(writerPlanD9.draft, [{ item: 'support', target: '654' }]);
  assert.equal(readerPlanD9.draft, null);
  assert.deepEqual(readerPlanD9.versions, writerPlanD9.versions);
  assert.notEqual(readerPlanD9.status.status, 'draft');
  assert.ok(!withoutRandom(readerPlanD9).includes('654'));
  assert.deepEqual(
    (await planOf(D1, exec)).versions.map((x) => x.n),
    [1, 2, 3],
  );
  // after the correction is cancelled: the same submitted revision 2
  await expectStatus(
    correction('cancel', pm, { expectedVersion: correctionEdit.version }),
    200,
  );
  const readerD1After = await dayOf(D1, exec);
  assert.deepEqual(readerD1After, readerD1);
  assert.notEqual((await dayOf(D1, pm)).version, 0);
  pass(
    'OD18: a reader gets nothing of an empty or draft day, only revision 2 of a correcting day (not the correction, its reason or a newer plan), the frozen no-work revision, version 0; days list submitted days only (correcting→submitted, drafts left out) and are byte-identical before and after a draft and a correction are started; plan drafts are hidden while confirmed versions stay; the writer view is unchanged',
  );

  // ---------- A7-0c (C20): a frozen draft next-day plan's rows are withheld from readers ----------
  // A submission freezes the next-day plan as it stands, a draft included (stored as is). A
  // reader gets its status but no rows on every path (the revision and the day); a confirmed
  // frozen plan stays visible; the writer and the stored snapshot are unchanged.
  {
    const C1 = '2026-11-02',
      C2 = '2026-11-03',
      C3 = '2026-11-04';
    const draftFor = (target, value) =>
      expectStatus(
        call('/plan/draft', pm, {
          projectId: projectA,
          targetBusinessDate: target,
          clientMutationId: randomUUID(),
          rows: [{ item: 'support', target: value }],
        }),
        200,
      );
    const submitDay = async (date) => {
      const saved = await expectStatus(
        call('/facts', pm, cmd({ businessDate: date, facts: facts() })),
        200,
      );
      await expectStatus(
        call(
          '/submit',
          pm,
          cmd({ businessDate: date, expectedVersion: saved.version }),
        ),
        200,
      );
    };
    const revisionOf = (date, bearer) =>
      expectStatus(
        call(
          `/revision?projectId=${projectA}&businessDate=${date}&n=1`,
          bearer,
        ),
        200,
      );
    await draftFor(C2, '8641');
    await submitDay(C1);
    const writerRev = await revisionOf(C1, pm);
    assert.deepEqual(writerRev.snapshot.nextPlan, {
      status: 'draft',
      n: null,
      rows: [],
    });
    // The writer's live day preview remains unchanged; only the stored revision omits draft rows.
    assert.deepEqual((await dayOf(C1, pm)).nextPlan, {
      status: 'draft',
      n: null,
      rows: [{ item: 'support', target: '8641' }],
    });
    const readerRev = await revisionOf(C1, exec);
    assert.deepEqual(readerRev.snapshot.nextPlan, {
      status: 'draft',
      n: null,
      rows: [],
    });
    const readerDay = await dayOf(C1, exec);
    assert.equal(readerDay.state, 'submitted');
    assert.deepEqual(readerDay.nextPlan, readerRev.snapshot.nextPlan);
    for (const shown of [readerRev, readerDay])
      assert.ok(!withoutRandom(shown).includes('8641'));
    // The draft confirmed later: the frozen revision still says draft; still no rows for a reader.
    await expectStatus(
      call('/plan/confirm', pm, {
        projectId: projectA,
        targetBusinessDate: C2,
        clientMutationId: randomUUID(),
      }),
      200,
    );
    assert.deepEqual(
      (await revisionOf(C1, exec)).snapshot.nextPlan,
      readerRev.snapshot.nextPlan,
    );
    assert.deepEqual(
      (await revisionOf(C1, pm)).snapshot.nextPlan,
      writerRev.snapshot.nextPlan,
    );
    // A next-day plan confirmed before the submission: its frozen rows stay visible.
    await draftFor(C3, '8642');
    await expectStatus(
      call('/plan/confirm', pm, {
        projectId: projectA,
        targetBusinessDate: C3,
        clientMutationId: randomUUID(),
      }),
      200,
    );
    await submitDay(C2);
    const confirmed = {
      status: 'confirmed',
      n: 1,
      rows: [{ item: 'support', target: '8642' }],
    };
    assert.deepEqual((await revisionOf(C2, pm)).snapshot.nextPlan, confirmed);
    assert.deepEqual((await revisionOf(C2, exec)).snapshot.nextPlan, confirmed);
    assert.deepEqual((await dayOf(C2, exec)).nextPlan, confirmed);

    // Reconstruct a pre-A7-2a immutable revision: no C19 keys, but a C20-era
    // draft row, so the writer/read-only projections and absence semantics are exercised.
    const day = (
      await owner.query(
        `SELECT d.id, d."currentRevisionNumber", r.snapshot
         FROM "DailyClose" d JOIN "Revision" r
           ON r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
         WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date`,
        [orgA, projectA, C1],
      )
    ).rows[0];
    assert.equal(day.currentRevisionNumber, 1);
    const legacySnapshot = structuredClone(day.snapshot);
    delete legacySnapshot.primaryWorkItemKey;
    delete legacySnapshot.milestones;
    legacySnapshot.nextPlan = {
      status: 'draft',
      n: null,
      rows: [{ item: 'support', target: '8641' }],
    };
    const legacyRevisionId = randomUUID();
    await owner.query(
      `INSERT INTO "Revision"(id,"orgId","updatedAt","updatedBy","revisionNumber","baseRevisionNumber",state,reason,snapshot,"submittedAt","dailyCloseId")
       VALUES($1,$2,now(),$3,2,1,'SUBMITTED','TEST legacy snapshot',$4,now(),$5)`,
      [legacyRevisionId, orgA, accountPm, legacySnapshot, day.id],
    );
    await owner.query(
      `INSERT INTO "RevisionEvent"(id,"orgId","updatedAt","updatedBy",action,reason,"actorPersonId","revisionId")
       VALUES($1,$2,now(),$3,'TEST_FIXTURE','TEST legacy snapshot',$4,$5)`,
      [randomUUID(), orgA, accountPm, personPm, legacyRevisionId],
    );
    await owner.query(
      `UPDATE "DailyClose" SET "currentRevisionNumber"=2 WHERE id=$1`,
      [day.id],
    );
    const legacyRevisionOf = (bearer) =>
      expectStatus(
        call(`/revision?projectId=${projectA}&businessDate=${C1}&n=2`, bearer),
        200,
      );
    const writerLegacy = await legacyRevisionOf(pm);
    assert.deepEqual(writerLegacy.snapshot, legacySnapshot);
    assert.equal(
      Object.hasOwn(writerLegacy.snapshot, 'primaryWorkItemKey'),
      false,
    );
    assert.equal(Object.hasOwn(writerLegacy.snapshot, 'milestones'), false);
    const readerLegacy = await legacyRevisionOf(exec);
    assert.equal(
      Object.hasOwn(readerLegacy.snapshot, 'primaryWorkItemKey'),
      false,
    );
    assert.equal(Object.hasOwn(readerLegacy.snapshot, 'milestones'), false);
    assert.deepEqual(readerLegacy.snapshot.nextPlan.rows, []);
    assert.deepEqual((await dayOf(C1, exec)).nextPlan, {
      status: 'draft',
      n: null,
      rows: [],
    });

    await owner.query(
      `UPDATE "Project" SET "primaryWorkItemKey"='support' WHERE id=$1`,
      [projectA],
    );
    const oldSnapshotAfterMasterEdit = (
      await owner.query(`SELECT snapshot FROM "Revision" WHERE id=$1`, [
        legacyRevisionId,
      ])
    ).rows[0].snapshot;
    assert.deepEqual(oldSnapshotAfterMasterEdit, legacySnapshot);
    assert.equal(
      Object.hasOwn(oldSnapshotAfterMasterEdit, 'primaryWorkItemKey'),
      false,
    );
    assert.equal(
      Object.hasOwn(oldSnapshotAfterMasterEdit, 'milestones'),
      false,
    );
    pass(
      'C19 legacy revisions remain absent/unfrozen after master edits; writer sees stored rows unchanged and readers project only draft rows away',
    );
  }
  pass(
    'C20: a new revision freezes draft status without draft rows while the writer live preview stays unchanged; later confirmation does not alter it, and a pre-confirmed plan freezes its rows',
  );

  // ---------- A7-0a (ADR-0003): OD18 on write rejections and conflicts ----------
  // D10 holds a draft (above); DE has no record at all. A reader's day list counts neither, and
  // a reader's write to either is refused READ_ONLY with the same body (excluding the per-call
  // correlationId): never a VERSION_CONFLICT that would tell a day row exists.
  const DE = '2026-10-25';
  const readerDaysOf = (from, to) =>
    expectStatus(
      call(`/days?projectId=${projectA}&from=${from}&to=${to}`, execA),
      200,
    );
  assert.deepEqual(await readerDaysOf(D10, D10), []);
  assert.deepEqual(await readerDaysOf(DE, DE), []);
  assert.equal((await readerDaysOf(D10, DE)).length, 0);
  const withoutCorrelation = ({ correlationId, ...rest }) => {
    assert.match(correlationId, /^[0-9a-f-]{36}$/);
    return rest;
  };
  for (const [path, over] of [
    ['/facts', { facts: facts() }],
    ['/submit', {}],
    ['/no-work', { reason: 'rest', note: '' }],
  ])
    for (const expectedVersion of [0, 1, 2]) {
      const onDraft = await call(
        path,
        execA,
        cmd({ businessDate: D10, expectedVersion, ...over }),
      );
      const onEmpty = await call(
        path,
        execA,
        cmd({ businessDate: DE, expectedVersion, ...over }),
      );
      assert.equal(onDraft.status, 403, JSON.stringify(onDraft.body));
      assert.equal(onEmpty.status, onDraft.status);
      assert.deepEqual(withoutCorrelation(onDraft.body), { code: 'READ_ONLY' });
      assert.deepEqual(
        withoutCorrelation(onEmpty.body),
        withoutCorrelation(onDraft.body),
      );
    }
  // The writer's own conflict on the draft day carries only code and correlationId (#45: the
  // client re-reads to show "you entered X, it is now Y"), no draft value.
  const conflict = await expectStatus(
    call(
      '/facts',
      pm,
      cmd({ businessDate: D10, expectedVersion: 0, facts: facts() }),
    ),
    409,
    'VERSION_CONFLICT',
  );
  assert.deepEqual(withoutCorrelation(conflict), { code: 'VERSION_CONFLICT' });
  assert.equal((await dayOf(D10, pm)).facts.weather, 'TEST unsubmitted draft');
  pass(
    "OD18 (A7-0a): a reader's day list counts no draft or empty day; a reader's facts / submit / no-work on a draft day and on a day without a record get the same READ_ONLY body (excluding correlationId), never VERSION_CONFLICT; a writer's VERSION_CONFLICT carries only code and correlationId",
  );

  // ---------- A7-0a (ADR-0003 D2.2): every report read route runs its exit projector ----------
  const projectors = [];
  observeReportProjections((p) => projectors.push(p));
  try {
    for (const [path, writer, reader] of [
      ['/projects', 'report.projects', 'report.projects'],
      [
        `/days?projectId=${projectA}&from=${D1}&to=${D10}`,
        'report.days.writer',
        'report.days.reader',
      ],
      [
        `/day?projectId=${projectA}&businessDate=${D1}`,
        'report.day.writer',
        'report.day.reader',
      ],
      [
        `/revision?projectId=${projectA}&businessDate=${D1}&n=1`,
        'report.revision.writer',
        'report.revision.reader',
      ],
      [
        `/plan?projectId=${projectA}&targetBusinessDate=${D10}`,
        'report.plan.writer',
        'report.plan.reader',
      ],
      [`/items?projectId=${projectA}`, 'report.items', 'report.items'],
    ])
      for (const [bearer, projector] of [
        [pm, writer],
        [execA, reader],
      ]) {
        projectors.length = 0;
        await expectStatus(call(path, bearer), 200);
        assert.deepEqual(projectors, [projector], path);
      }
    // A refused read reaches no projector.
    projectors.length = 0;
    await expectStatus(
      call(`/day?projectId=${projectB}&businessDate=${D1}`, pm),
      403,
      'FORBIDDEN',
    );
    assert.deepEqual(projectors, []);
  } finally {
    observeReportProjections(null);
  }
  pass(
    'ADR-0003 D2.2: each report read route (projects, days, day, revision, plan, items) runs the report exit projector for the writer and for the reader; a refused read runs none',
  );

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
      // cancel A + cancel B + OD18 cancel; start A, reopen, start B, OD18 start
      REPORT_CORRECTION_CANCEL: 3,
      REPORT_CORRECTION_START: 4,
      REPORT_NO_WORK: 1,
      // D1 v1, v2, v3 (OD18); D6 five race rounds + one of two concurrent confirms; D9 if it confirmed; C20: C2, C3
      REPORT_PLAN_CONFIRM: 11 + (d9Confirmed ? 1 : 0),
      // D1, D2, D1 again; D6 2 × 5 rounds + '999'; D9 save + overwrite; OD18: D10, D1; C20: C2, C3
      REPORT_PLAN_DRAFT: 20,
      // D1, race winner, three correction edits, D7, D8 (+ D8 late save if it won); OD18: D10, D1 edit; C20: C1, C2
      REPORT_SAVE_FACTS: saveVsSubmit[0].status === 200 ? 12 : 11,
      REPORT_SAVE_ITEMS: 2,
      // D1, D1 resubmit, D7 once (same key twice), D8 if submit won; C20: C1, C2
      REPORT_SUBMIT: saveVsSubmit[1].status === 200 ? 6 : 5,
    },
  );
  pass(
    'RLS hides every report table from another org and refuses writes into it; the app role cannot update or delete revisions or plan versions; every write is audited',
  );

  // Source-report extension: synthetic cells only, after the existing audit-count checks.
  {
    const date = '2027-02-10';
    const sourceCell = (raw, state = 'value') => ({
      raw,
      state,
      at: {
        document: 'testDoc',
        table: 0,
        row: 1,
        cell: 2,
        gridSpan: 2,
        verticalMerge: 'restart',
      },
    });
    const sourceReport = {
      schemaVersion: 1,
      documents: {
        testDoc: {
          sha256: 'a'.repeat(64),
          label: 'TEST source report',
          format: 'docx',
        },
      },
      peopleTotal: sourceCell(' 7 '),
      workPercent: { support: sourceCell(' 12% ') },
      materials: {
        rail: {
          cumulative: sourceCell('17'),
          percent: sourceCell('unknown', 'unknown'),
          unit: sourceCell('m'),
          note: sourceCell('  ', 'blank'),
        },
      },
    };
    const request = cmd({ businessDate: date, facts: facts({ sourceReport }) });
    const read = (bearer = pm) =>
      expectStatus(
        call(`/day?projectId=${projectA}&businessDate=${date}`, bearer),
        200,
      );
    const revision = (n, bearer = pm) =>
      expectStatus(
        call(
          `/revision?projectId=${projectA}&businessDate=${date}&n=${n}`,
          bearer,
        ),
        200,
      );
    let saved = await expectStatus(call('/facts', pm, request), 200);
    assert.deepEqual((await read()).facts.sourceReport, sourceReport);
    assert.deepEqual(
      await expectStatus(call('/facts', pm, request), 200),
      saved,
    );
    await expectStatus(
      call('/facts', pm, {
        ...request,
        facts: facts({ sourceReport, weather: 'different payload' }),
      }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    await expectStatus(
      call(
        '/facts',
        exec,
        cmd({
          businessDate: date,
          expectedVersion: saved.version,
          facts: facts({ sourceReport }),
        }),
      ),
      403,
    );
    await expectStatus(
      call(
        '/facts',
        pmB,
        cmd({
          businessDate: date,
          expectedVersion: saved.version,
          facts: facts({ sourceReport }),
        }),
      ),
      403,
    );
    assert.equal((await read(exec)).facts.sourceReport, undefined);
    pass(
      'source cells round-trip exactly; same-key replay, foreign tenant and reader writes remain protected',
    );

    for (const badFacts of [
      facts({ sourceReport: null }),
      facts({ sourceReport: { ...sourceReport, undocumented: 'TEST' } }),
      facts({
        sourceReport: {
          ...sourceReport,
          workPercent: { unregistered: sourceCell('1%') },
        },
      }),
      facts({
        sourceReport: {
          ...sourceReport,
          materials: { support: { unit: sourceCell('m') } },
        },
      }),
      facts({ originalPeopleTotal: '7' }),
    ]) {
      await expectStatus(
        call(
          '/facts',
          pm,
          cmd({
            businessDate: date,
            expectedVersion: saved.version,
            facts: badFacts,
          }),
        ),
        400,
      );
      assert.equal((await read()).version, saved.version);
      assert.deepEqual((await read()).facts.sourceReport, sourceReport);
    }
    pass(
      'invalid, null, unknown and wrong-kind source fields are refused atomically without changing the draft',
    );

    // An old client has no knowledge of sourceReport. Saving its facts must preserve it.
    const oldClient = cmd({
      businessDate: date,
      expectedVersion: saved.version,
      facts: facts({ weather: 'TEST old client edit' }),
    });
    saved = await expectStatus(call('/facts', pm, oldClient), 200);
    assert.deepEqual((await read()).facts.sourceReport, sourceReport);
    const auditSource = (
      await owner.query(
        `SELECT "after" FROM "AuditLog" WHERE "correlationId"=$1 AND action='REPORT_SAVE_FACTS'`,
        [oldClient.clientMutationId],
      )
    ).rows[0];
    assert.deepEqual(auditSource.after.sourceReport, sourceReport);
    await expectStatus(
      call(
        '/facts',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: saved.version - 1,
          facts: facts({ sourceReport }),
        }),
      ),
      409,
      'VERSION_CONFLICT',
    );
    pass(
      'old-client omission preserves source cells in the locked draft and effective audit; stale versions cannot overwrite',
    );

    let submittedSource = await expectStatus(
      call(
        '/submit',
        pm,
        cmd({ businessDate: date, expectedVersion: saved.version }),
      ),
      200,
    );
    const original = JSON.stringify(await revision(1));
    assert.deepEqual(
      (await revision(1, exec)).snapshot.facts.sourceReport,
      sourceReport,
    );
    await expectStatus(
      call(
        '/facts',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: submittedSource.version,
          facts: facts({ sourceReport }),
        }),
      ),
      409,
      'LOCKED',
    );
    let correctingSource = await expectStatus(
      call(
        '/correction/start',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: submittedSource.version,
          reason: 'TEST source correction',
        }),
      ),
      200,
    );
    const revised = { ...sourceReport, peopleTotal: sourceCell('8') };
    saved = await expectStatus(
      call(
        '/facts',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: correctingSource.version,
          facts: facts({ sourceReport: revised }),
        }),
      ),
      200,
    );
    assert.deepEqual((await read(exec)).facts.sourceReport, sourceReport);
    assert.deepEqual((await read()).facts.sourceReport, revised);
    const cancelledSource = await expectStatus(
      call(
        '/correction/cancel',
        pm,
        cmd({ businessDate: date, expectedVersion: saved.version }),
      ),
      200,
    );
    assert.deepEqual((await read()).facts.sourceReport, sourceReport);
    assert.equal(JSON.stringify(await revision(1)), original);
    correctingSource = await expectStatus(
      call(
        '/correction/start',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: cancelledSource.version,
          reason: 'TEST append revised source',
        }),
      ),
      200,
    );
    saved = await expectStatus(
      call(
        '/facts',
        pm,
        cmd({
          businessDate: date,
          expectedVersion: correctingSource.version,
          facts: facts({ sourceReport: revised }),
        }),
      ),
      200,
    );
    submittedSource = await expectStatus(
      call(
        '/submit',
        pm,
        cmd({ businessDate: date, expectedVersion: saved.version }),
      ),
      200,
    );
    assert.equal(submittedSource.revisionNumber, 2);
    assert.deepEqual((await revision(2)).snapshot.facts.sourceReport, revised);
    assert.equal(JSON.stringify(await revision(1)), original);
    assert.deepEqual((await read(exec)).facts.sourceReport, revised);
    pass(
      'source corrections require a new revision; cancellation restores source; readers never see unpublished source changes',
    );

    const noWorkDate = '2027-02-11';
    const onlySource = {
      weather: '',
      temperature: '',
      qty: {},
      cumulative: {},
      people: {},
      presence: {},
      machinery: {},
      materials: {},
      milestones: {},
      updated: {},
      narrative: { construction: '', quality: '', safety: '' },
      noWork: null,
      sourceReport: {
        ...sourceReport,
        peopleTotal: sourceCell('  ', 'blank'),
        workPercent: {},
        materials: {},
      },
    };
    const sourceOnlySave = await expectStatus(
      call('/facts', pm, cmd({ businessDate: noWorkDate, facts: onlySource })),
      200,
    );
    assert.equal(sourceOnlySave.state, 'draft');
    await expectStatus(
      call(
        '/no-work',
        pm,
        cmd({
          businessDate: noWorkDate,
          expectedVersion: sourceOnlySave.version,
          reason: 'rest',
          note: 'TEST',
        }),
      ),
      200,
    );
    const noWorkSnapshot = await expectStatus(
      call(
        `/revision?projectId=${projectA}&businessDate=${noWorkDate}&n=1`,
        pm,
      ),
      200,
    );
    assert.deepEqual(
      noWorkSnapshot.snapshot.facts.sourceReport,
      onlySource.sourceReport,
    );
    pass(
      'explicit blank source is a recorded fact and survives no-work submission',
    );
  }

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
