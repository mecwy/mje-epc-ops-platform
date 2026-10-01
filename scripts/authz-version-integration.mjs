// A7-0b database layer (ADR-0003 D5): LoginAccount.authzVersion triggers and the
// app_account_for_identity() first-lock function. Synthetic TEST data in an isolated, freshly
// migrated local database; the application role is a fresh login granted mje_alpha_app.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';

const source = new URL(process.env.DATABASE_URL);
assert.ok(
  ['localhost', '127.0.0.1'].includes(source.hostname),
  'TEST runner only accepts local database',
);
const WATCHDOG_MS = Number(process.env.AUTHZ_TEST_WATCHDOG_MS ?? 180_000);
setTimeout(() => {
  console.error(`FAIL watchdog: run exceeded ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const suffix = randomBytes(6).toString('hex');
const database = `mje_authz_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const admin = new Pool({ connectionString: source.toString() });
// See alpha-integration.mjs: only a 57P01 after this pool's own end() is tolerated.
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
let owner, appPool;
let dbCreated = false,
  roleCreated = false,
  checks = 0;
const pass = (name) => {
  checks++;
  console.log(`PASS ${name}`);
};
const timeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}: no result within ${ms} ms`)),
        ms,
      ).unref(),
    ),
  ]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rejectsWith(client, sql, args, code, label) {
  await client.query('SAVEPOINT negative_case');
  try {
    await client.query(sql, args);
    assert.fail(`${label}: expected database rejection ${code}`);
  } catch (error) {
    assert.equal(error.code, code, `${label}: ${error.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT negative_case');
  }
}

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
    new Pool({ connectionString: appUrl.toString(), max: 4 }),
  );

  const actor = randomUUID(),
    org = randomUUID(),
    project = randomUUID(),
    tenant = randomUUID();
  const personA = randomUUID(),
    personB = randomUUID(),
    personC = randomUUID();
  const accountA = randomUUID(),
    accountB = randomUUID(),
    accountNoPerson = randomUUID();
  const objectA = randomUUID(),
    objectB = randomUUID(),
    objectNoPerson = randomUUID();
  await owner.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST Organization\',now(),$2)',
    [org, actor],
  );
  for (const id of [personA, personB, personC])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST Person\')',
      [id, org, actor],
    );
  await owner.query(
    'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,\'TEST-A\',\'TEST-A\',\'Europe/Belgrade\',\'ACTIVE\')',
    [project, org, actor],
  );
  for (const [id, objectId, personId] of [
    [accountA, objectA, personA],
    [accountB, objectB, personB],
    [accountNoPerson, objectNoPerson, null],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, org, actor, tenant, objectId, personId],
    );
  const version = async (id) =>
    (
      await owner.query(
        'SELECT "authzVersion" AS v FROM "LoginAccount" WHERE id=$1',
        [id],
      )
    ).rows[0].v;
  const versions = async () => [
    await version(accountA),
    await version(accountB),
  ];
  const insertMembership = (id, accountId) =>
    owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'ALPHA_OWNER\',now(),$4,$5)',
      [id, org, actor, accountId, project],
    );

  // --- authzVersion triggers -------------------------------------------------------------
  assert.deepEqual(await versions(), [1, 1]);
  pass('a new account starts at authzVersion 1');

  const membership = randomUUID();
  await insertMembership(membership, accountA);
  assert.deepEqual(await versions(), [2, 1]);
  pass('Membership INSERT bumps only the granted account');

  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()+interval \'1 day\' WHERE id=$1',
    [membership],
  );
  assert.deepEqual(await versions(), [3, 1]);
  pass('Membership UPDATE (activeUntil) bumps the account');

  await owner.query('UPDATE "Membership" SET "accountId"=$2 WHERE id=$1', [
    membership,
    accountB,
  ]);
  assert.deepEqual(await versions(), [4, 2]);
  pass(
    'Membership UPDATE moving accountId bumps both the old and the new account',
  );

  await owner.query('DELETE FROM "Membership" WHERE id=$1', [membership]);
  assert.deepEqual(await versions(), [4, 3]);
  pass('Membership DELETE bumps the account that lost it');

  {
    const tx = await owner.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'ALPHA_OWNER\',now(),$4,$5)',
        [randomUUID(), org, actor, accountA, project],
      );
      assert.equal(
        (
          await tx.query(
            'SELECT "authzVersion" AS v FROM "LoginAccount" WHERE id=$1',
            [accountA],
          )
        ).rows[0].v,
        5,
      );
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
    assert.deepEqual(await versions(), [4, 3]);
    pass(
      'the bump is in the writer transaction: visible inside it, gone with its rollback',
    );
  }

  await owner.query('UPDATE "LoginAccount" SET active=false WHERE id=$1', [
    accountA,
  ]);
  assert.equal(await version(accountA), 5);
  await owner.query('UPDATE "LoginAccount" SET active=true WHERE id=$1', [
    accountA,
  ]);
  assert.equal(await version(accountA), 6);
  pass('LoginAccount.active false and back to true each bump once');

  await owner.query('UPDATE "LoginAccount" SET "personId"=$2 WHERE id=$1', [
    accountA,
    personC,
  ]);
  assert.equal(await version(accountA), 7);
  await owner.query('UPDATE "LoginAccount" SET "personId"=NULL WHERE id=$1', [
    accountA,
  ]);
  assert.equal(await version(accountA), 8);
  await owner.query('UPDATE "LoginAccount" SET "personId"=$2 WHERE id=$1', [
    accountA,
    personA,
  ]);
  assert.equal(await version(accountA), 9);
  pass(
    'LoginAccount.personId change (to another person, to NULL, back) bumps once each',
  );

  await owner.query(
    'UPDATE "LoginAccount" SET "updatedAt"=now(),"updatedBy"=$2,version=version+1,active=active,"personId"="personId" WHERE id=$1',
    [accountA, randomUUID()],
  );
  assert.equal(await version(accountA), 9);
  pass(
    'unrelated column updates (updatedAt, updatedBy, version, same-value active/personId) do not bump',
  );

  {
    const tx = await owner.connect();
    try {
      await tx.query('BEGIN');
      await rejectsWith(
        tx,
        'UPDATE "LoginAccount" SET "authzVersion"=1 WHERE id=$1',
        [accountA],
        'P0001',
        'decrease',
      );
      await tx.query('ROLLBACK');
    } finally {
      tx.release();
    }
  }
  assert.equal(await version(accountA), 9);
  pass('the version never moves back, even for the owner role');

  // --- app_account_for_identity() ---------------------------------------------------------
  {
    const meta = (
      await owner.query(
        `SELECT p.prosecdef, p.proisstrict, p.provolatile, p.proconfig,
          pg_catalog.pg_get_userbyid(p.proowner) AS owner,
          pg_catalog.pg_get_userbyid(c.relowner) AS "tableOwner",
          ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END
            || ':' || x.privilege_type FROM pg_catalog.aclexplode(p.proacl) x ORDER BY 1) AS acl
        FROM pg_catalog.pg_proc p, pg_catalog.pg_class c
        WHERE p.oid = 'public.app_account_for_identity(text,text)'::pg_catalog.regprocedure
          AND c.oid = 'public."LoginAccount"'::pg_catalog.regclass`,
      )
    ).rows[0];
    assert.equal(meta.prosecdef, true);
    assert.equal(meta.proisstrict, true);
    assert.equal(meta.provolatile, 'v');
    assert.deepEqual(meta.proconfig, [
      'search_path=pg_catalog, public, pg_temp',
    ]);
    assert.equal(meta.owner, meta.tableOwner);
    assert.deepEqual(
      meta.acl,
      [`${meta.owner}:EXECUTE`, 'mje_alpha_app:EXECUTE'].sort(),
    );
    for (const fn of [
      'login_account_authz_version()',
      'membership_authz_version()',
    ]) {
      const grantees = (
        await owner.query(
          `SELECT ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::text END
            FROM pg_catalog.aclexplode(p.proacl) x)::text[] AS g, p.prosecdef
          FROM pg_catalog.pg_proc p WHERE p.oid = $1::pg_catalog.regprocedure`,
          [`public.${fn}`],
        )
      ).rows[0];
      assert.equal(grantees.prosecdef, false, fn);
      assert.deepEqual(grantees.g, [meta.owner], fn);
    }
    pass(
      'definer function: SECURITY DEFINER, STRICT, VOLATILE, pinned search_path, owned by the LoginAccount owner, EXECUTE only for owner and mje_alpha_app; trigger functions are invoker and not executable by PUBLIC',
    );
  }

  const app = await appPool.connect();
  const setIdentity = (client, objectId) =>
    client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.object_id', $2, true)",
      [tenant, objectId],
    );
  const call = (client, t, o) =>
    client.query('SELECT * FROM app_account_for_identity($1, $2)', [t, o]);
  try {
    await app.query('BEGIN');
    await setIdentity(app, objectA);
    const own = await call(app, tenant, objectA);
    assert.deepEqual(
      own.fields.map((f) => f.name),
      ['orgId', 'id', 'personId', 'authzVersion'],
    );
    assert.deepEqual(own.rows, [
      { orgId: org, id: accountA, personId: personA, authzVersion: 9 },
    ]);
    pass(
      'as mje_alpha_app the function returns exactly orgId, id, personId, authzVersion for its own identity',
    );

    assert.equal((await call(app, tenant, objectB)).rowCount, 0);
    assert.equal((await call(app, randomUUID(), objectA)).rowCount, 0);
    assert.equal((await call(app, tenant, null)).rowCount, 0);
    assert.equal((await call(app, null, objectA)).rowCount, 0);
    await setIdentity(app, objectB);
    assert.equal((await call(app, tenant, objectA)).rowCount, 0);
    assert.deepEqual(
      (await call(app, tenant, objectB)).rows.map((r) => r.id),
      [accountB],
    );
    await setIdentity(app, objectNoPerson);
    assert.equal((await call(app, tenant, objectNoPerson)).rowCount, 0);
    await app.query('ROLLBACK');
    pass(
      'the function returns nothing for another identity than the session app.tenant_id/app.object_id, for NULL (STRICT), or for an account without a person',
    );

    await owner.query('UPDATE "LoginAccount" SET active=false WHERE id=$1', [
      accountB,
    ]);
    await app.query('BEGIN');
    await setIdentity(app, objectB);
    assert.equal((await call(app, tenant, objectB)).rowCount, 0);
    await app.query('ROLLBACK');
    await owner.query('UPDATE "LoginAccount" SET active=true WHERE id=$1', [
      accountB,
    ]);
    pass('the function returns nothing for an inactive account');

    // A temporary table in the caller's session cannot shadow the real table (pg_temp last).
    await app.query('BEGIN');
    await app.query(
      'CREATE TEMP TABLE "LoginAccount"(LIKE public."LoginAccount") ON COMMIT DROP',
    );
    await setIdentity(app, objectA);
    // A copy of the caller's own row under a made-up identity, only in pg_temp.
    const shadowObject = randomUUID();
    await app.query(
      'INSERT INTO pg_temp."LoginAccount" SELECT * FROM public."LoginAccount" WHERE id=$1',
      [accountA],
    );
    await app.query(
      'UPDATE pg_temp."LoginAccount" SET id=$1,"entraObjectId"=$2',
      [randomUUID(), shadowObject],
    );
    assert.deepEqual(
      (await call(app, tenant, objectA)).rows.map((r) => r.id),
      [accountA],
    );
    await setIdentity(app, shadowObject);
    assert.equal((await call(app, tenant, shadowObject)).rowCount, 0);
    await app.query('ROLLBACK');
    pass('a caller temporary "LoginAccount" does not shadow the real table');

    // --- the share lock is held for the caller's transaction ------------------------------
    const lockHeldUntilCommit = async (label, writerSql, writerArgs) => {
      const writer = await owner.connect();
      try {
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS p'))
          .rows[0].p;
        await app.query('BEGIN');
        await setIdentity(app, objectA);
        const before = (await call(app, tenant, objectA)).rows[0].authzVersion;
        const appPid = (await app.query('SELECT pg_backend_pid() AS p')).rows[0]
          .p;
        // A later statement in the same transaction: the lock outlives the function call.
        await app.query('SELECT 1');
        let settled = false;
        const pending = writer
          .query(writerSql, writerArgs)
          .finally(() => (settled = true));
        pending.catch(() => {});
        // Conservative: the writer must be observed blocked by this app backend within 5 s,
        // otherwise the run fails (an unobserved interleaving is not counted as a pass).
        let blockedBy = [];
        for (let i = 0; i < 50 && !blockedBy.includes(appPid); i++) {
          await pause(100);
          blockedBy = (
            await owner.query('SELECT pg_blocking_pids($1) AS b', [writerPid])
          ).rows[0].b;
        }
        assert.ok(
          blockedBy.includes(appPid),
          `${label}: writer not observed waiting on the app transaction`,
        );
        await pause(300);
        assert.equal(settled, false, `${label}: writer finished early`);
        assert.equal(
          (await call(app, tenant, objectA)).rows[0].authzVersion,
          before,
        );
        await app.query('COMMIT');
        await timeout(pending, 5_000, `${label}: writer after commit`);
        return before;
      } catch (error) {
        await app.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        writer.release();
      }
    };

    const beforeRevoke = await lockHeldUntilCommit(
      'direct UPDATE',
      'UPDATE "LoginAccount" SET active=false WHERE id=$1',
      [accountA],
    );
    assert.equal(await version(accountA), beforeRevoke + 1);
    await app.query('BEGIN');
    await setIdentity(app, objectA);
    assert.equal((await call(app, tenant, objectA)).rowCount, 0);
    await app.query('ROLLBACK');
    await owner.query('UPDATE "LoginAccount" SET active=true WHERE id=$1', [
      accountA,
    ]);
    pass(
      'an owner UPDATE "LoginAccount" waits for the caller transaction holding the function lock, then commits; the next transaction no longer finds the account',
    );

    const grant = randomUUID();
    const beforeGrant = await lockHeldUntilCommit(
      'Membership INSERT',
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'ALPHA_OWNER\',now(),$4,$5)',
      [grant, org, actor, accountA, project],
    );
    const beforeDelete = await lockHeldUntilCommit(
      'Membership DELETE',
      'DELETE FROM "Membership" WHERE id=$1',
      [grant],
    );
    assert.equal(beforeDelete, beforeGrant + 1);
    assert.equal(await version(accountA), beforeGrant + 2);
    await app.query('BEGIN');
    await setIdentity(app, objectA);
    assert.equal(
      (await call(app, tenant, objectA)).rows[0].authzVersion,
      beforeGrant + 2,
    );
    await app.query('ROLLBACK');
    pass(
      'Membership grant and revocation (trigger path) wait for the caller lock; a transaction started after the commit reads the new version',
    );

    // --- negative: the application role ----------------------------------------------------
    const columns = (
      await owner.query(
        `SELECT column_name AS c FROM information_schema.columns
        WHERE table_schema='public' AND table_name='LoginAccount' ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.c);
    assert.ok(columns.includes('authzVersion'));
    await app.query('BEGIN');
    await setIdentity(app, objectA);
    assert.equal(
      (
        await app.query(
          'SELECT "authzVersion" FROM "LoginAccount" WHERE id=$1',
          [accountA],
        )
      ).rowCount,
      1,
    );
    for (const column of columns)
      await rejectsWith(
        app,
        `UPDATE "LoginAccount" SET "${column}"="${column}" WHERE id=$1`,
        [accountA],
        '42501',
        `UPDATE ${column}`,
      );
    await rejectsWith(
      app,
      'DELETE FROM "LoginAccount" WHERE id=$1',
      [accountA],
      '42501',
      'DELETE',
    );
    await rejectsWith(
      app,
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId") VALUES($1,$2,now(),$3,$4,$5)',
      [randomUUID(), org, actor, tenant, randomUUID()],
      '42501',
      'INSERT',
    );
    pass(
      `as mje_alpha_app every LoginAccount column (${columns.length}) refuses UPDATE, and INSERT/DELETE are refused`,
    );

    for (const lock of ['FOR SHARE', 'FOR KEY SHARE', 'FOR UPDATE'])
      await rejectsWith(
        app,
        `SELECT id FROM "LoginAccount" WHERE id=$1 ${lock}`,
        [accountA],
        '42501',
        lock,
      );
    pass(
      'as mje_alpha_app a direct SELECT ... FOR SHARE / KEY SHARE / UPDATE on LoginAccount is refused: the function is the only lock path',
    );

    for (const fn of [
      'login_account_authz_version',
      'membership_authz_version',
    ])
      await rejectsWith(
        app,
        `SELECT public.${fn}()`,
        [],
        '42501',
        `call ${fn}`,
      );
    await rejectsWith(
      app,
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'ALPHA_OWNER\',now(),$4,$5)',
      [randomUUID(), org, actor, accountA, project],
      '42501',
      'app Membership INSERT',
    );
    await app.query('ROLLBACK');
    assert.equal(await version(accountA), beforeGrant + 2);
    pass(
      'as mje_alpha_app the trigger functions cannot be called and Membership cannot be written; the version is unchanged',
    );
  } finally {
    app.release();
  }

  console.log(
    `A7-0b authzVersion/first-lock DB integration: ${checks} checks passed; synthetic TEST data only. The inTransaction protocol and timing tests are separate (agent B).`,
  );
} finally {
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
}
