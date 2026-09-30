// cloud-add-member.mjs database integration test. Synthetic TEST data only. Runs the unchanged
// entry point (Dev-shape guards, sanitising handler, one transaction) as a child process
// against an isolated database created for this run, with add-member-test-hooks.mjs replacing
// only the Azure credential and the Azure server endpoint. Seeds the rows cloud-bootstrap.mjs
// creates. The concurrency case lines both runs up on locks (pg_stat_activity) instead of
// sleeping and hoping. Everything is bounded: each child, each query and a whole-run watchdog.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { assertLocalDatabase } from './local-db.mjs';

const source = assertLocalDatabase(process.env.DATABASE_URL);
const suffix = randomBytes(6).toString('hex');
const database = `mje_add_member_test_${suffix}`;
const admin = new Pool({ connectionString: source.toString(), max: 2 });
const isolated = new URL(source);
isolated.pathname = `/${database}`;
const missing = new URL(source);
missing.pathname = `/${database}_missing`;
const tolerateShutdown = (pool) =>
  pool.on('error', (error) => {
    if (error?.code !== '57P01') throw error;
  });
const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(
  new URL('./cloud-add-member.mjs', import.meta.url),
);
const hooks = fileURLToPath(
  new URL('./add-member-test-hooks.mjs', import.meta.url),
);
let owner,
  dbCreated = false,
  checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};

// ---------- harness: nothing may wait forever ----------
let currentStep = 'setup';
const step = (name) => {
  currentStep = name;
};
const WATCHDOG_MS = Number(process.env.ADD_MEMBER_TEST_WATCHDOG_MS ?? 180_000);
const MIGRATE_MS = Number(process.env.ADD_MEMBER_TEST_MIGRATE_MS ?? 120_000);
const RUN_MS = 30_000;
function withTimeout(promise, ms, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `timed out after ${ms} ms: ${label} (step: ${currentStep})`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
const git = (...args) => {
  try {
    return execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
};
const revision = `${git('rev-parse', '--short', 'HEAD') || 'unknown'}${git('status', '--porcelain') ? '+uncommitted' : ''}`;
const failure = (why) =>
  console.error(
    `ADD-MEMBER TEST FAILED at step "${currentStep}": ${why}; source ${revision}; TEST database ${database}`,
  );
/** Process groups of running children; the watchdog and cleanup kill whatever is left. */
const children = new Set();
function killChildren() {
  for (const pid of children) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
    children.delete(pid);
  }
}
/** Runs a child in its own process group; resolves with its exit status and output. */
function runChild(command, args, env, ms, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    children.add(child.pid);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      killChildren();
      reject(
        new Error(`timed out after ${ms} ms: ${label} (process group killed)`),
      );
    }, ms);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child.pid);
      resolve({ status: code ?? signal, out: out.trim() });
    });
  });
}
/** Clients holding locks for a scenario; always rolled back and released in `finally`. */
const held = new Set();
async function releaseHeld() {
  for (const client of [...held]) {
    held.delete(client);
    await withTimeout(
      client.query('ROLLBACK').catch(() => undefined),
      5_000,
      'rolling back a held lock',
    ).catch(() => undefined);
    client.release(true);
  }
}
let shuttingDown = false;
process.on('uncaughtException', (error) => {
  if (shuttingDown && /terminat/i.test(String(error?.message))) {
    console.error(`cleanup: ${error.message}`);
    return;
  }
  failure(`uncaught: ${String(error?.message ?? error).split('\n')[0]}`);
  process.exit(1);
});
async function dropTestDatabase() {
  shuttingDown = true;
  if (dbCreated) {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    dbCreated = false;
  }
}
const watchdog = setTimeout(() => {
  failure(`watchdog: the run did not finish within ${WATCHDOG_MS} ms`);
  killChildren();
  void withTimeout(
    releaseHeld().then(dropTestDatabase),
    20_000,
    'watchdog cleanup',
  )
    .catch((error) => console.error(`watchdog cleanup: ${error.message}`))
    .finally(() => process.exit(1));
}, WATCHDOG_MS);

// ---------- the bootstrap's identifiers and TEST values ----------
const id = (name) => {
  const h = createHash('sha256')
    .update(`mje-dev-bootstrap:${name}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const org = id('org'),
  project = id('project'),
  ownerPerson = id('person'),
  actor = id('seed');
const TENANT = randomUUID(),
  OTHER_TENANT = randomUUID(),
  OWNER = randomUUID();
const memberPerson = (objectId) => id(`member-person:${TENANT}:${objectId}`);
const memberAccount = (objectId) => id(`member-account:${TENANT}:${objectId}`);
const jwt = (claims) =>
  `TEST.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.TEST`;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NAMES = ['TEST 总监', 'TEST 经理 二', 'TEST 别名', 'TEST 并发'];

const printed = [];
/** One execution of the real entry point, as the Dev job would run it. */
async function addMember(settings, test = {}) {
  const token = test.token ?? jwt({ tid: TENANT });
  const result = await runChild(
    process.execPath,
    ['--import', hooks, script],
    {
      NODE_ENV: 'production',
      AZURE_CLIENT_ID: 'TEST',
      PGHOST: 'mjeepc-dev-pg-test.postgres.database.azure.com',
      PGUSER: 'mjeepc-dev-migration',
      OWNER_TENANT_ID: TENANT,
      MEMBER_ROLE: 'EXECUTIVE_READER',
      MEMBER_DISPLAY_NAME: NAMES[0],
      PROJECT_CODE: 'TEST-R11',
      ...settings,
      ADD_MEMBER_TEST_DATABASE_URL: (test.database ?? isolated).toString(),
      ADD_MEMBER_TEST_TOKEN: token,
      ...(test.credential
        ? { ADD_MEMBER_TEST_CREDENTIAL: test.credential }
        : {}),
    },
    RUN_MS,
    'cloud-add-member run',
  );
  printed.push(result.out);
  return result;
}
const stops = (result, pattern, label) => {
  assert.equal(result.status, 1, `${label}: ${result.out}`);
  assert.match(result.out, pattern, label);
  assert.equal(result.out.split('\n').length, 1, `${label}: one line`);
};
const ready = (result, role, label) => {
  assert.equal(result.status, 0, `${label}: ${result.out}`);
  assert.equal(
    result.out,
    `TEST project TEST-R11: member account ready as ${role}\nDev add-member completed.`,
    label,
  );
};
const q = (sql, params) =>
  withTimeout(owner.query(sql, params), 15_000, 'query');
const count = async (sql, params) => (await q(sql, params)).rows[0].n;
const accountOf = async (objectId) =>
  (
    await q(
      'SELECT id, active, "personId", "orgId" FROM "LoginAccount" WHERE "entraTenantId"=$1 AND "entraObjectId"=$2',
      [TENANT, objectId],
    )
  ).rows;
const membershipsOf = async (accountId) =>
  (
    await q(
      `SELECT role, "projectId", "activeUntil", extract(epoch FROM now() - "activeFrom")::int AS age
      FROM "Membership" WHERE "accountId"=$1`,
      [accountId],
    )
  ).rows;
const insertPerson = (personId, orgId, name) =>
  q(
    'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4)',
    [personId, orgId, actor, name],
  );
const insertAccount = (accountId, orgId, objectId, personId) =>
  q(
    `INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId")
    VALUES($1,$2,now(),$3,$4,$5,$6)`,
    [accountId, orgId, actor, TENANT, objectId, personId],
  );
const insertMembership = (membershipId, orgId, accountId, role, projectId) =>
  q(
    `INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId")
    VALUES($1,$2,now(),$3,$4,now() - interval '1 hour',$5,$6)`,
    [membershipId, orgId, actor, role, accountId, projectId],
  );

try {
  step('create TEST database');
  await withTimeout(
    admin.query(`CREATE DATABASE "${database}"`),
    15_000,
    'create database',
  );
  dbCreated = true;
  step('migrate');
  const migrated = await runChild(
    'pnpm',
    ['db:migrate'],
    { ...process.env, DATABASE_URL: isolated.toString() },
    MIGRATE_MS,
    'db:migrate',
  );
  assert.equal(migrated.status, 0, 'db:migrate failed');
  owner = tolerateShutdown(
    new Pool({ connectionString: isolated.toString(), max: 4 }),
  );

  step('before the bootstrap');
  stops(
    await addMember({ MEMBER_OBJECT_ID: randomUUID() }),
    /^Cloud add-member stopped: the TEST organisation is missing; run the bootstrap first$/,
    'no bootstrap',
  );
  pass('without the bootstrap rows the run stops and creates nothing');

  step('seed the bootstrap rows');
  await q(
    `INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,'TEST Organization',now(),$2)`,
    [org, actor],
  );
  await insertPerson(ownerPerson, org, 'TEST 项目经理');
  await q(
    `INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status)
    VALUES($1,$2,now(),$3,'TEST-R11','TEST 屋顶光伏 3.0MWp','Europe/Belgrade','ACTIVE')`,
    [project, org, actor],
  );
  const ownerAccount = id(`account:${TENANT}:${OWNER}`);
  await insertAccount(ownerAccount, org, OWNER, ownerPerson);
  await insertMembership(
    id(`membership:${ownerAccount}`),
    org,
    ownerAccount,
    'PROJECT_MANAGER',
    project,
  );

  step('first add and idempotent rerun');
  const A = randomUUID();
  ready(
    await addMember({ MEMBER_OBJECT_ID: A }),
    'executive reader',
    'first add',
  );
  const [a] = await accountOf(A);
  assert.equal(a.orgId, org);
  assert.equal(a.active, true);
  assert.equal(a.personId, memberPerson(A));
  assert.deepEqual(
    (
      await q('SELECT "orgId", "displayName" FROM "Person" WHERE id=$1', [
        a.personId,
      ])
    ).rows,
    [{ orgId: org, displayName: NAMES[0] }],
  );
  const [m] = await membershipsOf(a.id);
  assert.equal(m.role, 'EXECUTIVE_READER');
  assert.equal(m.projectId, project);
  assert.equal(m.activeUntil, null);
  assert.ok(m.age >= 3590 && m.age <= 3700, `activeFrom age ${m.age}`);
  const totals = async () =>
    (
      await q(
        `SELECT (SELECT count(*) FROM "Person")::int p, (SELECT count(*) FROM "LoginAccount")::int a,
        (SELECT count(*) FROM "Membership")::int m`,
      )
    ).rows[0];
  const afterFirst = await totals();
  ready(await addMember({ MEMBER_OBJECT_ID: A }), 'executive reader', 'rerun');
  assert.deepEqual(await totals(), afterFirst, 'rerun adds no rows');
  const B = randomUUID();
  ready(
    await addMember({
      MEMBER_OBJECT_ID: B,
      MEMBER_ROLE: 'PROJECT_MANAGER',
      MEMBER_DISPLAY_NAME: NAMES[1],
    }),
    'project manager',
    'manager',
  );
  pass(
    'first add creates one TEST person, account and current membership (active from one hour ago); a rerun adds nothing; a manager can be added',
  );

  step('role change and rename');
  stops(
    await addMember({ MEMBER_OBJECT_ID: A, MEMBER_ROLE: 'PROJECT_MANAGER' }),
    /another role on the TEST project \(not changed automatically\)$/,
    'role change',
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: A, MEMBER_DISPLAY_NAME: NAMES[2] }),
    /exists with another display name \(not renamed automatically\)$/,
    'rename',
  );
  assert.deepEqual(
    (await membershipsOf(a.id)).map((r) => r.role),
    ['EXECUTIVE_READER'],
  );
  assert.equal(
    (await q('SELECT "displayName" FROM "Person" WHERE id=$1', [a.personId]))
      .rows[0].displayName,
    NAMES[0],
  );
  pass('another role or another display name is refused and nothing changes');

  step('tenant');
  const T = randomUUID();
  stops(
    await addMember(
      { MEMBER_OBJECT_ID: T },
      { token: jwt({ tid: OTHER_TENANT }) },
    ),
    /the configured tenant is not the tenant of this database server$/,
    'tenant mismatch',
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: T }, { token: 'TEST-not-a-jwt' }),
    /the server tenant could not be established$/,
    'unreadable tenant',
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: T }, { token: jwt({ tid: 'TEST' }) }),
    /the server tenant could not be established$/,
    'non-GUID tenant',
  );
  assert.equal((await accountOf(T)).length, 0);
  pass(
    'a token from another tenant, or one whose tenant cannot be read, stops the run before any write',
  );

  step('owner recognition');
  stops(
    await addMember({ MEMBER_OBJECT_ID: OWNER }),
    /the member object id is the owner account$/,
    'owner by person',
  );
  // The second marker: the bootstrap's membership id, even on an account linked elsewhere.
  const O2 = randomUUID(),
    o2Account = randomUUID();
  await insertPerson(memberPerson(O2), org, NAMES[0]);
  await insertAccount(o2Account, org, O2, memberPerson(O2));
  await insertMembership(
    id(`membership:${o2Account}`),
    org,
    o2Account,
    'PROJECT_MANAGER',
    project,
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: O2 }),
    /the member object id is the owner account$/,
    'owner by membership',
  );
  pass(
    "the owner's account is recognised by the bootstrap person and by the bootstrap membership",
  );

  step('another person');
  const C = randomUUID(),
    otherPerson = randomUUID();
  await insertPerson(otherPerson, org, 'TEST 其他');
  await insertAccount(randomUUID(), org, C, otherPerson);
  stops(
    await addMember({ MEMBER_OBJECT_ID: C }),
    /the member object id already belongs to another person$/,
    'another person',
  );
  const D = randomUUID();
  await insertAccount(randomUUID(), org, D, null);
  stops(
    await addMember({ MEMBER_OBJECT_ID: D }),
    /not linked to a person \(not linked automatically\)$/,
    'unlinked',
  );
  assert.equal(
    await count('SELECT count(*)::int n FROM "Person" WHERE id = ANY($1)', [
      [memberPerson(C), memberPerson(D)],
    ]),
    0,
  );
  pass(
    'an account linked to another person, or to none, is refused and not relinked',
  );

  step('inactive rows');
  await q(
    `UPDATE "Membership" SET "activeUntil"=now() - interval '1 minute' WHERE "accountId"=$1`,
    [a.id],
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: A }),
    /membership that is not active \(not reactivated automatically\)$/,
    'inactive membership',
  );
  assert.equal((await membershipsOf(a.id)).length, 1);
  await q('UPDATE "LoginAccount" SET active=false WHERE id=$1', [a.id]);
  stops(
    await addMember({ MEMBER_OBJECT_ID: A }),
    /inactive \(not reactivated automatically\)$/,
    'inactive account',
  );
  assert.equal((await accountOf(A))[0].active, false);
  pass(
    'an ended membership or an inactive account stops the run and stays as it was',
  );

  step('rollback on a database failure');
  // The account id the script derives is already taken: the Person insert has run, then the
  // account insert fails. The whole transaction must roll back, and the log gets a code only.
  const F = randomUUID();
  await insertAccount(memberAccount(F), org, randomUUID(), otherPerson);
  const failed = await addMember({ MEMBER_OBJECT_ID: F });
  assert.equal(failed.status, 1);
  assert.equal(failed.out, 'Cloud add-member failed: code 23505');
  assert.equal(
    await count('SELECT count(*)::int n FROM "Person" WHERE id=$1', [
      memberPerson(F),
    ]),
    0,
    'the Person written before the failure is rolled back',
  );
  assert.equal((await accountOf(F)).length, 0);
  pass(
    'a database error mid-transaction rolls everything back and prints only its code',
  );

  step('cross-org readiness');
  const E = randomUUID(),
    otherOrg = randomUUID(),
    otherOrgPerson = randomUUID(),
    otherOrgAccount = randomUUID();
  await q(
    `INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,'TEST Other',now(),$2)`,
    [otherOrg, actor],
  );
  await insertPerson(otherOrgPerson, otherOrg, 'TEST 其他组织');
  await insertAccount(otherOrgAccount, otherOrg, E, otherOrgPerson);
  await insertMembership(
    randomUUID(),
    otherOrg,
    otherOrgAccount,
    'EXECUTIVE_READER',
    null,
  );
  stops(
    await addMember({ MEMBER_OBJECT_ID: E }),
    /does not resolve to exactly one eligible account$/,
    'cross-org',
  );
  assert.deepEqual(
    (await accountOf(E)).map((r) => r.orgId),
    [otherOrg],
  );
  assert.equal(
    await count('SELECT count(*)::int n FROM "Person" WHERE id=$1', [
      memberPerson(E),
    ]),
    0,
  );
  pass(
    'an identity already eligible in another organisation fails readiness; the TEST rows are rolled back',
  );

  step('concurrent runs asking for different roles');
  // An existing, active, person-linked account without a membership. The test holds the
  // Membership table in SHARE mode: reads pass, inserts wait. Without serialisation both runs
  // read "no membership" and both wait at their insert, so releasing them always yields two
  // roles. With it, the second run waits for the first before reading anything, and then sees
  // the first run's role. Either way two runs are waiting on a lock before the release.
  const G = randomUUID();
  await insertPerson(memberPerson(G), org, NAMES[3]);
  await insertAccount(randomUUID(), org, G, memberPerson(G));
  const [g] = await accountOf(G);
  const blocker = await withTimeout(owner.connect(), 5_000, 'connect');
  held.add(blocker);
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE "Membership" IN SHARE MODE');
  const concurrent = Promise.all(
    ['EXECUTIVE_READER', 'PROJECT_MANAGER'].map((role) =>
      addMember({
        MEMBER_OBJECT_ID: G,
        MEMBER_ROLE: role,
        MEMBER_DISPLAY_NAME: NAMES[3],
      }),
    ),
  );
  concurrent.catch(() => undefined);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const waiting = await count(
      `SELECT count(*)::int n FROM pg_stat_activity
      WHERE datname=$1 AND application_name='mje-add-member-test' AND wait_event_type='Lock'`,
      [database],
    );
    if (waiting === 2) break;
    assert.ok(
      Date.now() < deadline,
      `both runs should be waiting on a lock (waiting: ${waiting})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await blocker.query('COMMIT');
  held.delete(blocker);
  blocker.release();
  const results = await withTimeout(concurrent, RUN_MS, 'concurrent runs');
  const ok = results.filter((r) => r.status === 0);
  const refused = results.filter((r) => r.status !== 0);
  assert.equal(
    ok.length,
    1,
    `exactly one run succeeds: ${results.map((r) => r.out).join(' / ')}`,
  );
  assert.equal(refused.length, 1);
  stops(
    refused[0],
    /another role on the TEST project \(not changed automatically\)$/,
    'second concurrent run',
  );
  const roles = (await membershipsOf(g.id)).map((r) => r.role);
  assert.equal(roles.length, 1, `exactly one role: ${roles.join(',')}`);
  pass(
    `two overlapping runs asking for different roles leave exactly one role (${roles[0]}); the other run stops`,
  );

  step('sanitised output on database and credential failures');
  const unreachable = await addMember(
    { MEMBER_OBJECT_ID: randomUUID() },
    { database: missing },
  );
  assert.equal(unreachable.status, 1);
  assert.equal(unreachable.out, 'Cloud add-member failed: code 3D000');
  const credential = await addMember(
    { MEMBER_OBJECT_ID: randomUUID() },
    { credential: 'fail' },
  );
  assert.equal(credential.status, 1);
  assert.equal(
    credential.out,
    'Cloud add-member failed: CredentialUnavailableError',
  );
  const empty = await addMember(
    { MEMBER_OBJECT_ID: randomUUID() },
    { credential: 'empty' },
  );
  stops(
    empty,
    /^Cloud add-member stopped: managed identity database token unavailable$/,
    'empty token',
  );
  pass(
    'connection and credential failures print a code or error name only, never the database, endpoint or identifiers',
  );

  step('inactive project');
  await q(`UPDATE "Project" SET status='CLOSED' WHERE id=$1`, [project]);
  stops(
    await addMember({ MEMBER_OBJECT_ID: randomUUID() }),
    /the TEST project is not active$/,
    'inactive project',
  );
  pass('an inactive TEST project stops the run');

  step('output scan');
  for (const out of printed) {
    assert.doesNotMatch(out, GUID, `identifier printed: ${out}`);
    for (const name of [...NAMES, 'TEST 项目经理'])
      assert.ok(!out.includes(name), `display name printed: ${out}`);
    for (const secret of [database, source.password, '169.254', 'TEST.'].filter(
      Boolean,
    ))
      assert.ok(!out.includes(secret), `detail printed: ${out}`);
  }
  pass(`${printed.length} runs printed no identifier, name, database or token`);

  console.log(
    `cloud-add-member DB integration: ${checks} checks passed; synthetic TEST data only; Azure and real sign-in not exercised.`,
  );
  step('done');
} catch (error) {
  failure(String(error?.message ?? error).split('\n')[0]);
  process.exitCode = 1;
} finally {
  killChildren();
  await releaseHeld();
  const incomplete = [];
  const bounded = (work, label) =>
    withTimeout(Promise.resolve().then(work), 10_000, label).catch((error) => {
      incomplete.push(label);
      console.error(`cleanup: ${error.message}`);
    });
  if (owner) await bounded(() => owner.end(), 'owner.end');
  await bounded(dropTestDatabase, 'drop TEST database');
  await bounded(() => admin.end(), 'admin.end');
  if (incomplete.length) {
    failure(
      `cleanup incomplete (${incomplete.join(', ')}); TEST database ${dbCreated ? 'NOT dropped' : 'dropped'}`,
    );
    process.exitCode = 1;
  }
  clearTimeout(watchdog);
  setTimeout(() => {
    failure('open handles kept the process alive after cleanup; forced exit');
    process.exit(1);
  }, 10_000).unref();
}
