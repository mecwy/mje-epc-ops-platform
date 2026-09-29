// Issues and escalation (U2.1 rule 10, slice A3) HTTP + database integration test. Synthetic
// TEST data only. Runs against an isolated database created for this run; the application
// connects with a low-privilege role (no ownership, no RLS bypass) exactly as deployed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import {
  AlphaStore,
  IssueStore,
  ReportStore,
} from '../packages/domain/dist/index.js';
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
const database = `mje_issue_test_${suffix}`;
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

  // ---------- synthetic TEST tenancy ----------
  // org A: PM of project A; the same person's second account is PM of project A2 only;
  // an org-wide executive; a project-A executive. org B: its own PM.
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
    personOwner = randomUUID(),
    personB = randomUUID();
  const accountPm = randomUUID(),
    accountTwin = randomUUID(),
    accountExec = randomUUID(),
    accountExecA = randomUUID(),
    accountB = randomUUID();
  const objectPm = randomUUID(),
    objectTwin = randomUUID(),
    objectExec = randomUUID(),
    objectExecA = randomUUID(),
    objectB = randomUUID();
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
    [personOwner, orgA],
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
    [accountExecA, orgA, personExec, objectExecA],
    [accountB, orgB, personB, objectB],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, orgId, seedActor, tenantId, objectId, personId],
    );
  // activeFrom lies in the past: a database clock stepping back (NTP) right after seeding
  // must not make a fresh membership "not yet active".
  const membership = (orgId, accountId, role, projectId) =>
    owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now()-interval \'1 hour\',$5,$6)',
      [randomUUID(), orgId, seedActor, role, accountId, projectId],
    );
  await membership(orgA, accountPm, 'PROJECT_MANAGER', projectA);
  await membership(orgA, accountTwin, 'PROJECT_MANAGER', projectA2);
  await membership(orgA, accountExec, 'EXECUTIVE_READER', null);
  await membership(orgA, accountExecA, 'EXECUTIVE_READER', projectA);
  await membership(orgB, accountB, 'PROJECT_MANAGER', projectB);

  const keys = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [jwk] }));
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    issueStore: new IssueStore(appPool),
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
    twin = await token(objectTwin),
    exec = await token(objectExec),
    execA = await token(objectExecA),
    pmB = await token(objectB);
  async function call(path, bearer, body, idempotencyKey) {
    const response = await fetch(base + '/api/report' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey ?? body.clientMutationId,
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
  const count = async (sql, params = []) =>
    (await owner.query(sql, params)).rows[0].n;
  const D1 = '2026-10-05',
    D2 = '2026-10-06',
    D3 = '2026-10-07',
    D4 = '2026-10-08',
    D5 = '2026-10-09',
    D8 = '2026-10-12';
  const key = () => randomUUID();
  const create = (over = {}) => ({
    projectId: projectA,
    businessDate: D1,
    clientMutationId: key(),
    title: 'TEST cable tray delivery late',
    ...over,
  });
  const list = (date, bearer = pm, projectId = projectA) =>
    call(`/issues?projectId=${projectId}&businessDate=${date}`, bearer);

  await expectStatus(
    call('/items', pm, {
      projectId: projectA,
      clientMutationId: key(),
      items: [
        { kind: 'work', key: 'support', label: 'TEST support', unit: 'set' },
        { kind: 'work', key: 'rail', label: 'TEST rail', unit: 'm' },
        { kind: 'work', key: 'retired', label: 'TEST old', active: false },
        { kind: 'machinery', key: 'crane', label: 'TEST crane' },
      ],
    }),
    200,
  );

  // ---------- create: exactly once, validated references ----------
  assert.equal((await list(D1, null)).status, 401);
  const firstCreate = create({ note: '  TEST first note  ' });
  const i1 = await expectStatus(call('/issues', pm, firstCreate), 200);
  assert.equal(i1.version, 1);
  assert.equal(i1.state, 'OPEN');
  assert.equal(i1.createdOn, D1);
  assert.equal(i1.category, '');
  assert.equal(i1.escalate, false);
  assert.deepEqual(
    i1.notes.map((n) => [n.kind, n.text, n.onDate, n.authorPersonId]),
    [['note', 'TEST first note', D1, personPm]],
  );
  assert.deepEqual(await call('/issues', pm, firstCreate), {
    status: 200,
    body: i1,
  });
  await expectStatus(
    call('/issues', pm, { ...firstCreate, title: 'TEST other' }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await expectStatus(
    call('/issues', pm, create(), randomUUID()),
    400,
    'INVALID_INPUT',
  );
  assert.equal(await count('SELECT count(*)::int AS n FROM "Issue"'), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM "IssueNote"'), 1);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "AuditLog" WHERE action=\'ISSUE_CREATE\'',
    ),
    1,
  );
  pass(
    'create stores title, business date and first note; a replay returns the same body and adds no row or audit; key reuse 409; mismatched Idempotency-Key 400',
  );

  await expectStatus(
    call('/issues', pm, create({ escalate: true })),
    409,
    'CATEGORY_REQUIRED',
  );
  for (const workItemKey of ['nope', 'retired', 'crane'])
    await expectStatus(
      call('/issues', pm, create({ workItemKey })),
      409,
      'ITEM_NOT_FOUND',
    );
  for (const ownerPersonId of [personB, randomUUID()])
    await expectStatus(
      call('/issues', pm, create({ ownerPersonId })),
      409,
      'OWNER_NOT_FOUND',
    );
  await expectStatus(
    call('/issues', pm, create({ title: '  ' })),
    400,
    'INVALID_INPUT',
  );
  await expectStatus(
    call('/issues', pm, create({ category: 'fraud' })),
    400,
    'INVALID_INPUT',
  );
  const withOwner = await expectStatus(
    call(
      '/issues',
      pm,
      create({
        ownerPersonId: personOwner,
        dueOn: D3,
        workItemKey: 'rail',
        category: 'quality',
        escalate: true,
      }),
    ),
    200,
  );
  assert.equal(withOwner.ownerPersonId, personOwner);
  assert.equal(withOwner.dueOn, D3);
  assert.equal(withOwner.workItemKey, 'rail');
  assert.equal(withOwner.escalate, true);
  assert.equal(await count('SELECT count(*)::int AS n FROM "Issue"'), 2);
  pass(
    'escalate without a category 409; unknown, inactive or non-work item 409; owner of another org or unknown 409; blank title and unknown category 400',
  );

  // ---------- roles: executive reads and replies only; other projects and orgs refused ----------
  for (const [path, body] of [
    ['/issues', create()],
    [
      '/issues/note',
      {
        issueId: i1.id,
        businessDate: D1,
        expectedVersion: 1,
        clientMutationId: key(),
        text: 'x',
      },
    ],
    [
      '/issues/escalate',
      {
        issueId: i1.id,
        expectedVersion: 1,
        clientMutationId: key(),
        escalate: true,
        category: 'safety',
      },
    ],
    [
      '/issues/close',
      {
        issueId: i1.id,
        businessDate: D1,
        expectedVersion: 1,
        clientMutationId: key(),
      },
    ],
    [
      '/issues/reopen',
      {
        issueId: i1.id,
        businessDate: D1,
        expectedVersion: 1,
        clientMutationId: key(),
      },
    ],
    [
      '/issues/lag/dismiss',
      {
        projectId: projectA,
        businessDate: D1,
        workItemKey: 'support',
        clientMutationId: key(),
      },
    ],
  ]) {
    await expectStatus(call(path, exec, body), 403, 'READ_ONLY');
    await expectStatus(call(path, execA, body), 403, 'READ_ONLY');
    await expectStatus(call(path, twin, body), 403, 'FORBIDDEN');
    // Another org cannot see the issue at all (RLS) and holds no role on the project.
    const other = await call(path, pmB, body);
    assert.ok(
      [403, 404].includes(other.status) &&
        ['FORBIDDEN', 'NOT_FOUND'].includes(other.body.code),
      `${path} ${JSON.stringify(other.body)}`,
    );
  }
  await expectStatus(call(`/issues/${i1.id}`, pmB), 404, 'NOT_FOUND');
  await expectStatus(list(D1, pmB), 403, 'FORBIDDEN');
  await expectStatus(list(D1, twin), 403, 'FORBIDDEN');
  await expectStatus(list(D1, execA, projectA2), 403, 'FORBIDDEN');
  const reply = {
    issueId: i1.id,
    businessDate: D1,
    clientMutationId: key(),
    text: 'TEST please send the recovery date',
  };
  await expectStatus(call('/issues/reply', pm, reply), 403, 'FORBIDDEN');
  await expectStatus(call('/issues/reply', pmB, reply), 404, 'NOT_FOUND');
  const replied = await expectStatus(call('/issues/reply', exec, reply), 200);
  assert.equal(replied.version, 1); // a reply is appended, the issue is unchanged
  assert.deepEqual(
    replied.notes.map((n) => [n.kind, n.authorPersonId]),
    [
      ['note', personPm],
      ['reply', personExec],
    ],
  );
  assert.deepEqual(await call('/issues/reply', exec, reply), {
    status: 200,
    body: replied,
  });
  await expectStatus(
    call('/issues/reply', execA, { ...reply, clientMutationId: key() }),
    200,
  );
  const execList = await expectStatus(list(D1, exec), 200);
  assert.equal(execList.access, 'read');
  assert.equal(execList.issues.length, 2);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "IssueNote" WHERE kind=\'reply\'',
    ),
    2,
  );
  assert.equal(
    await count('SELECT count(*)::int AS n FROM "Issue" WHERE version<>1'),
    0,
  );
  pass(
    'executives (org-wide and project) may only read and reply; a reply is a note of kind reply and leaves the issue version alone; the project manager cannot reply; the same person on another project and another org are refused',
  );

  // ---------- versions, notes, escalation, expert-controlled close ----------
  const note = (over = {}) => ({
    issueId: i1.id,
    businessDate: D1,
    expectedVersion: 1,
    clientMutationId: key(),
    text: 'TEST supplier confirmed Thursday',
    ...over,
  });
  await expectStatus(
    call('/issues/note', pm, note({ expectedVersion: 0 })),
    409,
    'VERSION_CONFLICT',
  );
  const noteCommand = note();
  const noted = await expectStatus(call('/issues/note', pm, noteCommand), 200);
  assert.equal(noted.version, 2);
  assert.deepEqual(await call('/issues/note', pm, noteCommand), {
    status: 200,
    body: noted,
  });
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "IssueNote" WHERE kind=\'note\' AND "issueId"=$1',
      [i1.id],
    ),
    2,
  );
  const race = await Promise.all([
    call('/issues/note', pm, note({ expectedVersion: 2, text: 'TEST A' })),
    call('/issues/note', pm, note({ expectedVersion: 2, text: 'TEST B' })),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const escalate = (over = {}) => ({
    issueId: i1.id,
    expectedVersion: 3,
    clientMutationId: key(),
    escalate: true,
    ...over,
  });
  await expectStatus(
    call('/issues/escalate', pm, escalate()),
    409,
    'CATEGORY_REQUIRED',
  );
  let i1Now = await expectStatus(
    call('/issues/escalate', pm, escalate({ category: 'resourceGap' })),
    200,
  );
  assert.deepEqual(
    [i1Now.escalate, i1Now.category, i1Now.version],
    [true, 'resourceGap', 4],
  );
  i1Now = await expectStatus(
    call(
      '/issues/escalate',
      pm,
      escalate({ expectedVersion: 4, escalate: false }),
    ),
    200,
  );
  assert.deepEqual(
    [i1Now.escalate, i1Now.category],
    [false, 'resourceGap'], // switching off keeps the category
  );
  const controlled = await expectStatus(
    call(
      '/issues',
      pm,
      create({
        title: 'TEST harness anchor needs safety check',
        category: 'safety',
        escalate: true,
        controlled: true,
      }),
    ),
    200,
  );
  await expectStatus(
    call('/issues/close', pm, {
      issueId: controlled.id,
      businessDate: D1,
      expectedVersion: 1,
      clientMutationId: key(),
    }),
    409,
    'NEEDS_EXPERT',
  );
  await expectStatus(
    call('/issues/reopen', pm, {
      issueId: controlled.id,
      businessDate: D1,
      expectedVersion: 1,
      clientMutationId: key(),
    }),
    409,
    'ISSUE_NOT_CLOSED',
  );
  assert.equal(
    await count('SELECT count(*)::int AS n FROM "Issue" WHERE state=\'OPEN\''),
    3,
  );
  pass(
    'stale expectedVersion 409; note replay adds no second note; concurrent notes on one version: exactly one wins; escalate needs a category and switching off keeps it; an expert-controlled issue cannot be closed by the project manager; reopen needs a closed issue',
  );

  // ---------- rule 1: a submitted day keeps the issues as they were ----------
  const i3 = await expectStatus(
    call(
      '/issues',
      pm,
      create({ businessDate: D2, title: 'TEST inverter pad drainage' }),
    ),
    200,
  );
  const submitted = await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D2,
      expectedVersion: 0,
      clientMutationId: key(),
    }),
    200,
  );
  assert.equal(submitted.revisionNumber, 1);
  const revisionPath = `/revision?projectId=${projectA}&businessDate=${D2}&n=1`;
  const rev1 = await expectStatus(call(revisionPath, pm), 200);
  const frozen = await owner.query(
    'SELECT snapshot::text AS s FROM "Revision" r JOIN "DailyClose" d ON d.id=r."dailyCloseId" WHERE d."businessDate"=$1',
    [D2],
  );
  assert.deepEqual(
    rev1.snapshot.issues.map((i) => [i.title, i.status, i.closedToday]),
    [
      ['TEST cable tray delivery late', 'open', false],
      ['TEST cable tray delivery late', 'open', false],
      ['TEST harness anchor needs safety check', 'open', false],
      ['TEST inverter pad drainage', 'open', false],
    ],
  );
  const snapI1 = rev1.snapshot.issues.find((i) => i.id === i1.id);
  assert.deepEqual(Object.keys(snapI1).sort(), [
    'category',
    'closedToday',
    'controlled',
    'dueOn',
    'escalate',
    'id',
    'last',
    'ownerPersonId',
    'status',
    'title',
    'workItemKey',
  ]);
  assert.equal(snapI1.last.kind, 'note'); // latest of the day, the replies came before the notes
  const closeI1 = {
    issueId: i1.id,
    businessDate: D2,
    expectedVersion: 5,
    clientMutationId: key(),
  };
  const closed = await expectStatus(call('/issues/close', pm, closeI1), 200);
  assert.deepEqual(
    [closed.state, closed.closedOn, closed.closedBy, closed.version],
    ['CLOSED', D2, accountPm, 6],
  );
  await expectStatus(
    call('/issues/close', pm, {
      ...closeI1,
      expectedVersion: 6,
      clientMutationId: key(),
    }),
    409,
    'ISSUE_CLOSED',
  );
  await expectStatus(
    call('/issues/note', pm, {
      issueId: i3.id,
      businessDate: D2,
      expectedVersion: 1,
      clientMutationId: key(),
      text: 'TEST after submission',
    }),
    200,
  );
  await expectStatus(
    call('/issues/escalate', pm, {
      issueId: i3.id,
      expectedVersion: 2,
      clientMutationId: key(),
      escalate: true,
      category: 'quality',
    }),
    200,
  );
  await expectStatus(
    call('/issues/reply', exec, {
      issueId: i3.id,
      businessDate: D2,
      clientMutationId: key(),
      text: 'TEST noted',
    }),
    200,
  );
  // There is no rename command; a later master change is simulated at the database.
  await owner.query('UPDATE "Issue" SET summary=$1 WHERE id=$2', [
    'TEST renamed later',
    i3.id,
  ]);
  const rev1Again = await expectStatus(call(revisionPath, pm), 200);
  assert.deepEqual(rev1Again.snapshot, rev1.snapshot);
  assert.equal(
    (
      await owner.query(
        'SELECT snapshot::text AS s FROM "Revision" r JOIN "DailyClose" d ON d.id=r."dailyCloseId" WHERE d."businessDate"=$1',
        [D2],
      )
    ).rows[0].s,
    frozen.rows[0].s,
  );
  const day2 = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D2}`, pm),
    200,
  );
  assert.equal(day2.state, 'submitted'); // issue changes never start a correction
  const liveI1 = day2.issues.find((i) => i.id === i1.id);
  assert.deepEqual([liveI1.status, liveI1.closedToday], ['closed', true]);
  const liveI3 = day2.issues.find((i) => i.id === i3.id);
  assert.deepEqual(
    [liveI3.title, liveI3.escalate, liveI3.last.kind, liveI3.last.text],
    ['TEST renamed later', true, 'reply', 'TEST noted'],
  );
  pass(
    'the submitted revision freezes the day’s issues (status, closedToday, last note); later close, note, escalation, reply and rename leave it byte-for-byte unchanged and the day stays submitted; the live day shows the change',
  );

  // ---------- listing by business date ----------
  const ids = (body) => body.issues.map((i) => i.id);
  let d1 = await expectStatus(list(D1), 200);
  assert.ok(!ids(d1).includes(i3.id)); // raised on D2
  const d1I1 = d1.issues.find((i) => i.id === i1.id);
  assert.deepEqual(
    [d1I1.status, d1I1.closedToday, d1I1.state],
    ['open', false, 'CLOSED'],
  );
  assert.ok(d1I1.notes.every((n) => n.onDate <= D1));
  const find = (body, id) => body.issues.find((i) => i.id === id);
  let d2 = await expectStatus(list(D2), 200);
  assert.ok(ids(d2).includes(i1.id) && ids(d2).includes(i3.id));
  assert.deepEqual(
    [find(d2, i1.id).status, find(d2, i1.id).closedToday],
    ['closed', true],
  );
  let d3 = await expectStatus(list(D3), 200);
  assert.ok(!ids(d3).includes(i1.id)); // closed on D2
  assert.ok(ids(d3).includes(i3.id));
  await expectStatus(
    call('/issues/close', pm, {
      issueId: i3.id,
      businessDate: D1,
      expectedVersion: 3,
      clientMutationId: key(),
    }),
    409,
    'DATE_BEFORE_CREATED',
  );
  pass(
    'a day lists issues raised on or before it and open as of it, or closed on it (closedToday); closing before the raise date 409',
  );

  // ---------- reopen keeps the history of earlier days ----------
  // D8 is submitted while i1 is closed; the reopen comes later and is dated D4.
  await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D8,
      expectedVersion: 0,
      clientMutationId: key(),
    }),
    200,
  );
  const d8Path = `/revision?projectId=${projectA}&businessDate=${D8}&n=1`;
  const d8Rev = await expectStatus(call(d8Path, pm), 200);
  assert.ok(!d8Rev.snapshot.issues.some((i) => i.id === i1.id));
  const reopen = (over = {}) => ({
    issueId: i1.id,
    businessDate: D4,
    expectedVersion: 6,
    clientMutationId: key(),
    ...over,
  });
  await expectStatus(
    call('/issues/reopen', pm, reopen({ businessDate: D1 })),
    409,
    'DATE_BEFORE_CLOSE',
  );
  const reopened = await expectStatus(
    call('/issues/reopen', pm, reopen()),
    200,
  );
  assert.deepEqual(
    [reopened.state, reopened.closedOn, reopened.closedBy, reopened.version],
    ['REOPENED', null, null, 7],
  );
  assert.deepEqual(
    reopened.transitions.map((t) => [t.kind, t.onDate, t.actorPersonId]),
    [
      ['close', D2, personPm],
      ['reopen', D4, personPm],
    ],
  );
  d1 = await expectStatus(list(D1), 200);
  assert.deepEqual(
    [find(d1, i1.id).status, find(d1, i1.id).closedToday],
    ['open', false],
  );
  d2 = await expectStatus(list(D2), 200);
  assert.deepEqual(
    [find(d2, i1.id).status, find(d2, i1.id).closedToday],
    ['closed', true],
  ); // the close day still shows the close after the reopen
  d3 = await expectStatus(list(D3), 200);
  assert.ok(!ids(d3).includes(i1.id)); // still closed on the day in between
  const d4 = await expectStatus(list(D4), 200);
  assert.deepEqual(
    [
      find(d4, i1.id).status,
      find(d4, i1.id).closedToday,
      find(d4, i1.id).state,
    ],
    ['open', false, 'REOPENED'],
  );
  await expectStatus(
    call('/issues/close', pm, {
      issueId: i1.id,
      businessDate: D3,
      expectedVersion: 7,
      clientMutationId: key(),
    }),
    409,
    'DATE_BEFORE_REOPEN',
  );
  assert.deepEqual(
    (await expectStatus(call(d8Path, pm), 200)).snapshot,
    d8Rev.snapshot,
  );
  const d8Live = await expectStatus(
    call(`/day?projectId=${projectA}&businessDate=${D8}`, pm),
    200,
  );
  assert.equal(find(d8Live, i1.id).status, 'open'); // live view follows the reopen
  // A correction of D2 made after the reopen freezes D2 as it was: i1 closed that day.
  await expectStatus(
    call('/correction/start', pm, {
      projectId: projectA,
      businessDate: D2,
      expectedVersion: 1,
      clientMutationId: key(),
      reason: 'TEST resubmit after reopen',
    }),
    200,
  );
  const d2Rev2 = await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D2,
      expectedVersion: 2,
      clientMutationId: key(),
    }),
    200,
  );
  assert.equal(d2Rev2.revisionNumber, 2);
  const rev2 = await expectStatus(
    call(`/revision?projectId=${projectA}&businessDate=${D2}&n=2`, pm),
    200,
  );
  const rev2I1 = rev2.snapshot.issues.find((i) => i.id === i1.id);
  assert.deepEqual([rev2I1.status, rev2I1.closedToday], ['closed', true]);
  assert.deepEqual(
    (await expectStatus(call(revisionPath, pm), 200)).snapshot,
    rev1.snapshot,
  );
  // Database clocks can step backwards (NTP); order must not depend on stored timestamps.
  const orderOf = (body) =>
    body.issues.map((i) => [i.id, i.last?.text ?? null, i.status]);
  const beforeSkew = orderOf(await expectStatus(list(D2), 200));
  // The newest issue of the day and the newest note of i1 get the oldest timestamps.
  await owner.query(`UPDATE "Issue" SET "createdAt"='2000-01-01' WHERE id=$1`, [
    d2.issues.at(-1).id,
  ]);
  await owner.query(
    `UPDATE "IssueNote" SET "createdAt"='2000-01-01' WHERE id=(SELECT id FROM "IssueNote" WHERE "issueId"=$1 ORDER BY seq DESC LIMIT 1)`,
    [i1.id],
  );
  await owner.query(
    `UPDATE "IssueTransition" SET "createdAt"='2000-01-01' WHERE "issueId"=$1 AND kind='reopen'`,
    [i1.id],
  );
  assert.deepEqual(orderOf(await expectStatus(list(D2), 200)), beforeSkew);
  assert.equal(find(await expectStatus(list(D4), 200), i1.id).status, 'open');
  // Several issues share createdOn D1: reverse their stored timestamps (first newest, last
  // oldest); the list must still follow creation order (seq).
  const d1Before = await expectStatus(list(D1), 200);
  assert.ok(d1Before.issues.length >= 3);
  const d1Ids = ids(d1Before);
  for (const [n, id] of d1Ids.entries())
    await owner.query(`UPDATE "Issue" SET "createdAt"=$1 WHERE id=$2`, [
      `${2100 - n}-01-01`,
      id,
    ]);
  assert.deepEqual(ids(await expectStatus(list(D1), 200)), d1Ids);

  // Same-day transitions on the creation day, with timestamps reversed afterwards: only the
  // application order (seq) may decide which one is last.
  const transition = async (issue, path, expectedVersion) =>
    expectStatus(
      call(`/issues/${path}`, pm, {
        issueId: issue.id,
        businessDate: D3,
        expectedVersion,
        clientMutationId: key(),
      }),
      200,
    );
  const reverseTransitionClock = (issueId) =>
    owner.query(
      `UPDATE "IssueTransition" t SET "createdAt"=timestamptz '2100-01-01' - make_interval(secs => r.n)
      FROM (SELECT id, row_number() OVER (ORDER BY seq) AS n FROM "IssueTransition" WHERE "issueId"=$1) r
      WHERE t.id=r.id`,
      [issueId],
    );
  const flip = await expectStatus(
    call(
      '/issues',
      pm,
      create({ businessDate: D3, title: 'TEST combiner box label' }),
    ),
    200,
  );
  await transition(flip, 'close', 1);
  await transition(flip, 'reopen', 2);
  await transition(flip, 'close', 3);
  const back = await expectStatus(
    call(
      '/issues',
      pm,
      create({ businessDate: D3, title: 'TEST fence gate hinge' }),
    ),
    200,
  );
  await transition(back, 'close', 1);
  await transition(back, 'reopen', 2);
  for (const id of [flip.id, back.id]) await reverseTransitionClock(id);
  assert.equal(
    await count(
      `SELECT count(*)::int AS n FROM "IssueTransition" a JOIN "IssueTransition" b ON a."issueId"=b."issueId" AND a.seq<b.seq AND a."createdAt"<=b."createdAt" WHERE a."issueId" = ANY($1::uuid[])`,
      [[flip.id, back.id]],
    ),
    0,
  ); // every later transition now carries an earlier timestamp
  const onD3 = await expectStatus(list(D3), 200);
  assert.deepEqual(
    [find(onD3, flip.id).status, find(onD3, flip.id).closedToday],
    ['closed', true],
  );
  assert.deepEqual(
    [find(onD3, back.id).status, find(onD3, back.id).closedToday],
    ['open', false],
  );
  const onD4 = await expectStatus(list(D4), 200);
  assert.ok(!ids(onD4).includes(flip.id)); // closed on D3
  assert.equal(find(onD4, back.id).status, 'open');
  assert.deepEqual(
    (
      await expectStatus(call(`/issues/${flip.id}`, pm), 200)
    ).issue.transitions.map((t) => [t.kind, t.onDate]),
    [
      ['close', D3],
      ['reopen', D3],
      ['close', D3],
    ],
  );
  assert.deepEqual(
    (
      await expectStatus(call(`/issues/${back.id}`, pm), 200)
    ).issue.transitions.map((t) => t.kind),
    ['close', 'reopen'],
  );
  const one = await expectStatus(call(`/issues/${i1.id}`, exec), 200);
  assert.equal(one.access, 'read');
  assert.equal(one.issue.notes.length, 5); // first note, two replies, two notes
  assert.equal(one.issue.transitions.length, 2);
  assert.equal(
    (await expectStatus(call(`/issues/${i1.id}`, execA), 200)).issue.id,
    i1.id,
  );
  await expectStatus(call('/issues/not-an-id', pm), 400, 'INVALID_INPUT');
  pass(
    'close D2 then reopen dated D4: D2 still shows closed + closedToday, D3 excludes it, D4 shows it open; reopen before the close and close before the reopen 409; a revision submitted before the reopen is unchanged; a later correction of D2 freezes the close; with stored timestamps reversed, issues of one creation day, the last note and same-day close/reopen/close on the creation day still follow application order; GET one returns every note and transition',
  );

  // ---------- lag reminder: 3 consecutive submitted days under 80 % ----------
  for (const date of [D3, D4, D5]) {
    await expectStatus(
      call('/plan/draft', pm, {
        projectId: projectA,
        targetBusinessDate: date,
        clientMutationId: key(),
        rows: [
          { item: 'support', target: '300' },
          { item: 'rail', target: '100' },
        ],
      }),
      200,
    );
    await expectStatus(
      call('/plan/confirm', pm, {
        projectId: projectA,
        targetBusinessDate: date,
        clientMutationId: key(),
      }),
      200,
    );
  }
  const submitDay = async (date, qty) => {
    await expectStatus(
      call('/facts', pm, {
        projectId: projectA,
        businessDate: date,
        expectedVersion: 0,
        clientMutationId: key(),
        facts: { qty },
      }),
      200,
    );
    await expectStatus(
      call('/submit', pm, {
        projectId: projectA,
        businessDate: date,
        expectedVersion: 1,
        clientMutationId: key(),
      }),
      200,
    );
  };
  const lag = async (date, bearer = pm) =>
    (
      await expectStatus(
        call(`/issues/lag?projectId=${projectA}&businessDate=${date}`, bearer),
        200,
      )
    ).suggestions.map((s) => s.workItemKey);
  const issuesBefore = await count('SELECT count(*)::int AS n FROM "Issue"');
  await submitDay(D3, { support: '100', rail: '90' });
  await submitDay(D5, { support: '120', rail: '50' });
  assert.deepEqual(await lag(D5), []); // D4 not submitted: the streak is broken
  await expectStatus(
    call('/facts', pm, {
      projectId: projectA,
      businessDate: D4,
      expectedVersion: 0,
      clientMutationId: key(),
      facts: { qty: { support: '90', rail: '95' } },
    }),
    200,
  );
  assert.deepEqual(await lag(D5), []); // a draft is not a submitted day
  await expectStatus(
    call('/submit', pm, {
      projectId: projectA,
      businessDate: D4,
      expectedVersion: 1,
      clientMutationId: key(),
    }),
    200,
  );
  assert.deepEqual(await lag(D5), ['support']); // rail was at or above 80 % on D3 and D4
  assert.deepEqual(await lag(D5, exec), ['support']);
  assert.deepEqual(await lag(D4), []); // D2 has no baseline
  assert.equal(
    await count('SELECT count(*)::int AS n FROM "Issue"'),
    issuesBefore,
  ); // a reminder never creates an issue
  const lagIssue = await expectStatus(
    call(
      '/issues',
      pm,
      create({
        businessDate: D5,
        title: 'TEST support installation behind plan',
        category: 'progressLag',
        workItemKey: 'support',
      }),
    ),
    200,
  );
  assert.equal(lagIssue.escalate, false); // not escalated, still suppresses the reminder
  assert.deepEqual(await lag(D5), []);
  await expectStatus(
    call('/issues/close', pm, {
      issueId: lagIssue.id,
      businessDate: D5,
      expectedVersion: 1,
      clientMutationId: key(),
    }),
    200,
  );
  assert.deepEqual(await lag(D5), ['support']);
  const dismiss = {
    projectId: projectA,
    businessDate: D5,
    workItemKey: 'support',
    clientMutationId: key(),
  };
  await expectStatus(
    call('/issues/lag/dismiss', pm, { ...dismiss, workItemKey: 'crane' }),
    409,
    'ITEM_NOT_FOUND',
  );
  const dismissed = await expectStatus(
    call('/issues/lag/dismiss', pm, dismiss),
    200,
  );
  assert.deepEqual(await call('/issues/lag/dismiss', pm, dismiss), {
    status: 200,
    body: dismissed,
  });
  await expectStatus(
    call('/issues/lag/dismiss', pm, { ...dismiss, clientMutationId: key() }),
    200,
  ); // dismissing again changes nothing
  assert.deepEqual(await lag(D5), []);
  assert.equal(await count('SELECT count(*)::int AS n FROM "LagDismissal"'), 1);
  assert.equal(
    await count(
      'SELECT count(*)::int AS n FROM "AuditLog" WHERE action=\'ISSUE_LAG_DISMISS\'',
    ),
    1,
  );
  pass(
    'lag reminder after 3 consecutive submitted days under 80 % of the baseline; a missing or unsubmitted day breaks the streak; an open progress-lag issue (escalated or not) and a dismissal suppress it; closing the issue brings it back; the reminder never creates an issue',
  );

  // ---------- database-level protections ----------
  // A dedicated issue with no notes or transitions, so a tenant transfer that also moves the
  // project is valid for every foreign key: only RLS can refuse it.
  const probe = randomUUID();
  await owner.query(
    'INSERT INTO "Issue"(id,"orgId","updatedAt","updatedBy",kind,summary,"projectId","createdOn") VALUES($1,$2,now(),$3,\'SITE_REPORT\',\'TEST probe\',$4,$5::date)',
    [probe, orgA, seedActor, projectA, D1],
  );
  const transfer =
    'UPDATE "Issue" SET "orgId"=$1, "projectId"=$2, "ownerPersonId"=NULL, "closedBy"=NULL, "taskId"=NULL, "sourceId"=NULL WHERE id=$3';
  const transferParams = [orgB, projectB, probe];
  {
    // The same payload succeeds for the owner (no RLS), proving it is FK-valid.
    const ownerClient = await owner.connect();
    try {
      await ownerClient.query('BEGIN');
      assert.equal(
        (await ownerClient.query(transfer, transferParams)).rowCount,
        1,
      );
      await ownerClient.query('ROLLBACK');
    } finally {
      ownerClient.release();
    }
  }
  const rejectsWith = async (client, statement, params, check) => {
    await client.query('SAVEPOINT probe');
    let error;
    try {
      await client.query(statement, params);
    } catch (e) {
      error = e;
    }
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert.ok(error, `accepted: ${statement}`);
    check(error);
  };
  const rls = (e) => {
    assert.equal(e.code, '42501', e.message);
    assert.match(e.message, /row-level security policy for table "Issue"/);
  };
  const constraint = (name) => (e) => {
    assert.equal(e.code, '23514', e.message);
    assert.equal(e.constraint, name);
  };
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
    for (const table of [
      'Issue',
      'IssueNote',
      'IssueTransition',
      'LagDismissal',
    ])
      assert.equal(
        (await client.query(`SELECT count(*)::int AS n FROM "${table}"`))
          .rows[0].n,
        0,
        table,
      );
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
    assert.equal(
      (await client.query('SELECT count(*)::int AS n FROM "IssueNote"')).rows[0]
        .n,
      await count('SELECT count(*)::int AS n FROM "IssueNote"'),
    );
    assert.equal(
      (
        await client.query(
          'SELECT count(*)::int AS n FROM "Issue" WHERE id=$1',
          [probe],
        )
      ).rows[0].n,
      1,
    );
    await rejectsWith(client, transfer, transferParams, rls);
    await rejectsWith(
      client,
      'INSERT INTO "Issue"(id,"orgId","updatedAt","updatedBy",kind,summary,"projectId","createdOn") VALUES($1,$2,now(),$3,\'SITE_REPORT\',\'TEST\',$4,\'2026-10-05\')',
      [randomUUID(), orgB, accountB, projectB],
      rls,
    );
    const insertA =
      'INSERT INTO "Issue"(id,"orgId","updatedAt","updatedBy",kind,summary,"projectId","createdOn",category,escalate) VALUES($1,$2,now(),$3,\'SITE_REPORT\',\'TEST\',$4,\'2026-10-05\',$5,$6)';
    await rejectsWith(
      client,
      insertA,
      [randomUUID(), orgA, accountPm, projectA, 'fraud', false],
      constraint('Issue_category_check'),
    );
    await rejectsWith(
      client,
      insertA,
      [randomUUID(), orgA, accountPm, projectA, null, true],
      constraint('Issue_escalate_category_check'),
    );
    for (const statement of [
      'UPDATE "IssueNote" SET text=\'tamper\'',
      'DELETE FROM "IssueNote"',
      'DELETE FROM "Issue"',
      'UPDATE "LagDismissal" SET "workItemKey"=\'rail\'',
      'DELETE FROM "LagDismissal"',
      'UPDATE "IssueTransition" SET "onDate"=\'2026-01-01\'',
      'DELETE FROM "IssueTransition"',
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
    `SELECT action, count(*)::int AS n FROM "AuditLog" WHERE action LIKE 'ISSUE_%' GROUP BY action ORDER BY action`,
  );
  assert.deepEqual(
    Object.fromEntries(audits.rows.map((r) => [r.action, r.n])),
    {
      // i1, owner/rail issue, controlled, i3, two same-day issues, progress-lag issue
      ISSUE_CREATE: 7,
      // i1, same-day close/reopen/close (2) and close/reopen (1), progress-lag issue
      ISSUE_CLOSE: 5,
      // i1 on, i1 off, i3 on
      ISSUE_ESCALATE: 3,
      ISSUE_LAG_DISMISS: 1,
      // i1 once (replayed), race winner, i3
      ISSUE_NOTE: 3,
      // i1, one per same-day issue
      ISSUE_REOPEN: 3,
      // exec (replayed), project executive, exec on i3
      ISSUE_REPLY: 3,
    },
  );
  const shapes = await owner.query(
    `SELECT DISTINCT jsonb_typeof(after) AS t FROM "AuditLog" WHERE action LIKE 'ISSUE_%'`,
  );
  assert.deepEqual(
    shapes.rows.map((r) => r.t),
    ['object'],
  );
  const closeAudit = await owner.query(
    `SELECT before->>'state' AS b, after->>'state' AS a, after->>'closedOn' AS "on" FROM "AuditLog" WHERE action='ISSUE_CLOSE' AND "entityId"=$1`,
    [i1.id],
  );
  assert.deepEqual(closeAudit.rows, [{ b: 'OPEN', a: 'CLOSED', on: D2 }]);
  pass(
    'RLS hides issues, notes, transitions and dismissals from another org; an FK-valid tenant transfer and a cross-org insert are refused by RLS (42501); category and escalate-without-category are refused by their CHECK constraints (23514); the app role cannot update or delete notes, transitions or dismissals nor delete issues; every write is audited once with before/after JSON',
  );

  console.log(
    `Issue HTTP/DB integration: ${checks} checks passed; synthetic TEST data only. Expert verification, photos linked to issues and the web UI are later slices.`,
  );
} finally {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
}
