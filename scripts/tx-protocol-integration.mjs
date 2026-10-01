// A7-0b controlled timing tests (ADR-0003 D5): the account transaction protocol of inTransaction
// against PostgreSQL 17, over HTTP, with the application connecting as a fresh login granted
// mje_alpha_app. Synthetic TEST data in an isolated, freshly migrated local database; photo bytes
// go to an in-memory fake Blob store (no emulator needed) that can stall.
// Interleavings are synchronised on the database (pg_stat_activity, pg_blocking_pids, a session
// advisory lock), not on sleeps; every wait has a bound and the run has a watchdog. Each case runs
// even when an earlier one failed (so the same script shows which cases an older implementation
// fails); the exit code is 1 when any case failed.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  AlphaStore,
  IssueStore,
  PhotoStore,
  ReportStore,
} from '../packages/domain/dist/index.js';
import { testJpeg } from '../packages/testing/dist/index.js';
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
const WATCHDOG_MS = Number(process.env.TX_TEST_WATCHDOG_MS ?? 300_000);
setTimeout(() => {
  console.error(`FAIL watchdog: run exceeded ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS).unref();
const suffix = randomBytes(6).toString('hex');
const database = `mje_tx_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const admin = new Pool({ connectionString: source.toString() });
const tolerateShutdown = (pool) => {
  let closing = false;
  const end = pool.end.bind(pool);
  pool.end = () => {
    closing = true;
    return end();
  };
  return pool.on('error', (error) => {
    if (closing && error?.code === '57P01') return;
    // An idle client whose session the server ended is dropped by the pool; not a failure.
    if (['25P03', '25P04'].includes(error?.code)) return;
    throw error;
  });
};
const isolated = new URL(source);
isolated.pathname = `/${database}`;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const now = () => performance.now();
const results = [];
const settled = (promise) => {
  const s = { done: false, at: null, value: undefined, error: undefined };
  s.promise = promise.then(
    (value) => Object.assign(s, { done: true, at: now(), value }),
    (error) => Object.assign(s, { done: true, at: now(), error }),
  );
  return s;
};
async function waitFor(check, ms, label) {
  const until = now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (now() > until) throw new Error(`${label}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function within(s, ms, label) {
  await Promise.race([
    s.promise,
    new Promise((r) => setTimeout(r, ms).unref()),
  ]);
  if (!s.done) throw new Error(`${label}: no result within ${ms} ms`);
  return s;
}

let owner, appPool, app, app2;
let dbCreated = false,
  roleCreated = false;
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
    new Pool({ connectionString: appUrl.toString(), max: 8 }),
  );

  // ---------- fake Blob store: content-addressed, can stall after writing ----------
  const objects = new Map();
  let stall = null;
  const stalls = [];
  const fakeBlobs = {
    async put(key, bytes, contentType, signal) {
      const prior = objects.get(key);
      if (prior && !prior.bytes.equals(Buffer.from(bytes)))
        throw new Error('TEST blob holds other bytes');
      objects.set(key, { bytes: Buffer.from(bytes), contentType });
      if (!stall) return;
      // Written, then the call never returns (a lost response): only the caller's deadline or
      // the test's cleanup ends it.
      const s = stall;
      stall = null;
      s.signal = signal ?? null;
      stalls.push(s);
      s.entered();
      return new Promise((resolve) => (s.release = resolve));
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { bytes: o.bytes, contentType: o.contentType } : null;
    },
  };
  const armStall = () =>
    new Promise((entered) => {
      stall = { entered, release: null, signal: null };
    });
  // Errors the stores threw (their SQLSTATE), recorded before the HTTP filter maps them.
  const thrown = [];
  const recording = (store) =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args) => {
          try {
            return await value.apply(target, args);
          } catch (error) {
            thrown.push(error?.code ?? error?.message);
            throw error;
          }
        };
      },
    });

  // ---------- synthetic TEST tenancy ----------
  const tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID();
  const org = randomUUID(),
    projectA = randomUUID(),
    projectA2 = randomUUID(),
    seed = randomUUID();
  await owner.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST Organization\',now(),$2)',
    [org, seed],
  );
  for (const [id, code] of [
    [projectA, 'TEST-A'],
    [projectA2, 'TEST-A2'],
  ])
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,\'Europe/Belgrade\',\'ACTIVE\')',
      [id, org, seed, code],
    );
  const keys = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [jwk] }));
  async function token(oid) {
    const t = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      tid: tenantId,
      oid,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-subject',
      iat: t,
      nbf: t - 1,
      exp: t + 900,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .sign(keys.privateKey);
  }
  const membership = async (accountId, role, projectId) => {
    const id = randomUUID();
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now()-interval \'1 hour\',$5,$6)',
      [id, org, seed, role, accountId, projectId],
    );
    return id;
  };
  /** A fresh project manager of project A (own person, account and token) per case. */
  async function newPm() {
    const person = randomUUID(),
      account = randomUUID(),
      oid = randomUUID();
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST Person\')',
      [person, org, seed],
    );
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [account, org, seed, tenantId, oid, person],
    );
    const m = await membership(account, 'PROJECT_MANAGER', projectA);
    return { account, membershipId: m, bearer: await token(oid) };
  }
  // The revocation / grant SQL a writer (owner role) runs; both move LoginAccount.authzVersion.
  const REVOKE = 'UPDATE "Membership" SET "activeUntil"=now() WHERE id=$1';
  const GRANT =
    'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES(gen_random_uuid(),$1,now(),$2,\'PROJECT_MANAGER\',now(),$3,$4)';

  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: recording(new ReportStore(appPool)),
    issueStore: new IssueStore(appPool),
    photoStore: recording(new PhotoStore(appPool, fakeBlobs)),
  });
  await app.listen(0, '127.0.0.1');
  // Same pool; the photo store's own Blob deadline is far away, so only the server's
  // idle-in-transaction bound can end a stalled upload.
  app2 = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    issueStore: new IssueStore(appPool),
    photoStore: recording(
      new PhotoStore(appPool, fakeBlobs, { blobDeadlineMs: 120_000 }),
    ),
  });
  await app2.listen(0, '127.0.0.1');
  const base = await app.getUrl(),
    base2 = await app2.getUrl();

  async function call(path, bearer, body, b = base) {
    const response = await fetch(b + '/api/report' + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': body.clientMutationId,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function upload(bearer, fields, bytes, b = base) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'p');
    const response = await fetch(b + '/api/report/photos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Idempotency-Key': fields.clientMutationId,
      },
      body: form,
    });
    return { status: response.status, body: await response.json() };
  }
  const camera = (businessDate) => ({
    projectId: projectA,
    businessDate,
    clientMutationId: randomUUID(),
    source: 'camera',
    lat: '44.800000',
    lon: '20.400000',
    accuracyM: '12',
    fixAt: `${businessDate}T08:00:00Z`,
    takenAt: `${businessDate}T08:00:02Z`,
  });
  const items = (n, label = 'TEST item') => ({
    projectId: projectA,
    clientMutationId: randomUUID(),
    items: Array.from({ length: n }, (_, i) => ({
      kind: 'work',
      key: `k${i}`,
      label: `${label} ${i}`,
      unit: 'set',
    })),
  });
  /** The one application backend inside a transaction (the request under test). */
  const requestBackend = () =>
    owner
      .query(
        `SELECT pid, state, wait_event_type AS "waitType", pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE usename=$1 AND datname=$2 AND xact_start IS NOT NULL AND pid<>pg_backend_pid()`,
        [username, database],
      )
      .then((r) => (r.rows.length === 1 ? r.rows[0] : null));
  /** Starts a writer statement on its own owner connection; returns its pid and outcome. */
  async function writer(sql, args) {
    const c = await owner.connect();
    const pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const s = settled(c.query(sql, args));
    s.promise.finally(() => c.release());
    return { pid, s };
  }
  const blockedBy = async (pid, blocker) =>
    (
      await owner.query('SELECT pg_blocking_pids($1) AS b', [pid])
    ).rows[0].b.includes(blocker);
  const alive = async (pid) =>
    (await owner.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid]))
      .rowCount === 1;
  const count = async (sql, args) =>
    Number((await owner.query(sql, args)).rows[0].n);

  async function testCase(name, run) {
    const t0 = now();
    try {
      await run();
      results.push({ name, ok: true });
      console.log(`PASS ${name} (${Math.round(now() - t0)} ms)`);
    } catch (error) {
      results.push({ name, ok: false });
      console.log(
        `FAIL ${name} (${Math.round(now() - t0)} ms): ${error?.message}`,
      );
    }
  }

  // ---------- T1 revocation committed first: the request is refused ----------
  await testCase(
    'T1 revocation committed before the request: 403',
    async () => {
      const pm = await newPm();
      assert.equal((await call('/items', pm.bearer, items(1))).status, 200);
      await owner.query(REVOKE, [pm.membershipId]);
      const r = await call('/items', pm.bearer, items(1));
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'FORBIDDEN');
    },
  );

  // ---------- T2 revocation while the request holds the account lock ----------
  await testCase(
    'T2 revocation issued while a request holds the account lock: the revoker waits, the request completes, the next request is refused',
    async () => {
      const pm = await newPm();
      const date = '2026-10-12';
      const hold = await owner.connect();
      let held = true;
      const holdPid = (await hold.query('SELECT pg_backend_pid() AS p')).rows[0]
        .p;
      // The request will wait on the report-day lock held here, inside its transaction.
      await hold.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        `${org}:day:${projectA}:${date}`,
      ]);
      let request, revoker;
      try {
        request = settled(
          upload(pm.bearer, camera(date), testJpeg({ tag: 't2' })),
        );
        const r = await waitFor(
          async () => {
            const b = await requestBackend();
            return b?.blockers.includes(holdPid) ? b : null;
          },
          3000,
          'request waiting on the day lock',
        );
        revoker = await writer(REVOKE, [pm.membershipId]);
        await waitFor(
          async () => {
            if (revoker.s.done)
              throw new Error(
                'the revocation committed while the request was in flight (no account lock)',
              );
            return blockedBy(revoker.pid, r.pid);
          },
          1500,
          'revoker blocked by the request',
        );
        await hold.query('SELECT pg_advisory_unlock_all()');
        held = false;
        await within(request, 4000, 'request');
        await within(revoker.s, 4000, 'revoker');
        assert.equal(request.value?.status, 200, JSON.stringify(request.value));
        assert.ok(revoker.s.at >= request.at - 50, 'revoker finished first');
        const next = await call('/items', pm.bearer, items(1));
        assert.equal(next.status, 403);
      } finally {
        if (held) await hold.query('SELECT pg_advisory_unlock_all()');
        hold.release();
        await request?.promise;
        await revoker?.s.promise;
      }
    },
  );

  // ---------- T3 revocation before an idempotent replay ----------
  await testCase(
    'T3 revocation (and demotion) before an idempotent replay: refused, nothing replayed',
    async () => {
      const pm = await newPm();
      const command = items(2, 'TEST replay');
      const first = await call('/items', pm.bearer, command);
      assert.equal(first.status, 200);
      const replay = await call('/items', pm.bearer, command);
      assert.deepEqual(replay.body, first.body);
      // Demoted to reader: the writer check precedes the replay lookup.
      const reader = await membership(pm.account, 'EXECUTIVE_READER', null);
      await owner.query(REVOKE, [pm.membershipId]);
      const demoted = await call('/items', pm.bearer, command);
      assert.equal(demoted.status, 403);
      assert.equal(demoted.body.code, 'READ_ONLY');
      assert.equal(demoted.body.items, undefined);
      await owner.query(REVOKE, [reader]);
      const revoked = await call('/items', pm.bearer, command);
      assert.equal(revoked.status, 403);
      assert.equal(revoked.body.code, 'FORBIDDEN');
      assert.equal(revoked.body.items, undefined);
      assert.equal(
        await count(
          'SELECT count(*) AS n FROM "IdempotencyRecord" WHERE key=$1',
          [command.clientMutationId],
        ),
        1,
      );
    },
  );

  // ---------- T4 stalled Blob: the operation deadline ends the transaction ----------
  await testCase(
    'T4 stalled Blob (15 s deadline): RETRY, account lock released, the waiting writer proceeds, no late commit, retry reuses the object',
    async () => {
      const pm = await newPm();
      const date = '2026-10-13';
      const fields = camera(date);
      const bytes = testJpeg({ tag: 't4' });
      const blobKey = `${org}/${sha256(bytes)}`;
      const entered = armStall();
      const t0 = now();
      const request = settled(upload(pm.bearer, fields, bytes));
      let grant;
      try {
        await Promise.race([
          entered,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('no Blob put')), 3000).unref(),
          ),
        ]);
        const r = await waitFor(requestBackend, 2000, 'request backend');
        grant = await writer(GRANT, [org, seed, pm.account, projectA2]);
        await waitFor(
          async () => {
            if (grant.s.done)
              throw new Error(
                'the grant committed while the request was in flight (no account lock)',
              );
            return blockedBy(grant.pid, r.pid);
          },
          1500,
          'grant blocked by the request',
        );
        await within(request, 20_000, 'stalled request');
        const elapsed = request.at - t0;
        assert.equal(request.value?.status, 503, JSON.stringify(request.value));
        assert.equal(request.value.body.code, 'RETRY');
        assert.ok(
          elapsed > 14_000 && elapsed < 19_000,
          `answered after ${elapsed} ms`,
        );
        assert.equal(
          stalls.at(-1).signal?.aborted,
          true,
          'Blob signal aborted',
        );
        await within(grant.s, 3000, 'grant after the deadline');
        assert.equal(grant.s.error, undefined);
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "PhotoEvidence" WHERE "blobKey"=$1',
            [blobKey],
          ),
          0,
        );
        // The stalled call returns late: nothing commits after the RETRY.
        stalls.at(-1).release?.();
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "PhotoEvidence" WHERE "blobKey"=$1',
            [blobKey],
          ),
          0,
          'late commit',
        );
        const sizeBefore = objects.size;
        const retry = await upload(pm.bearer, fields, bytes);
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.equal(objects.size, sizeBefore, 'retry wrote a second object');
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "PhotoEvidence" WHERE "blobKey"=$1',
            [blobKey],
          ),
          1,
        );
        assert.ok(thrown.includes('BLOB_DEADLINE'), thrown.join(','));
      } finally {
        stall = null;
        for (const s of stalls) s.release?.();
        await request.promise;
        await grant?.s.promise;
      }
    },
  );

  // ---------- T5 stalled Blob without the app deadline: the server's idle bound ----------
  await testCase(
    'T5 stalled Blob, app deadline off: the server ends the session (25P03), RETRY, client discarded, writer proceeds, no commit',
    async () => {
      const pm = await newPm();
      const date = '2026-10-14';
      const fields = camera(date);
      const bytes = testJpeg({ tag: 't5' });
      const blobKey = `${org}/${sha256(bytes)}`;
      const entered = armStall();
      const t0 = now();
      thrown.length = 0;
      const request = settled(upload(pm.bearer, fields, bytes, base2));
      let grant, pid;
      try {
        await Promise.race([
          entered,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('no Blob put')), 3000).unref(),
          ),
        ]);
        const r = await waitFor(requestBackend, 2000, 'request backend');
        pid = r.pid;
        grant = await writer(GRANT, [org, seed, pm.account, projectA2]);
        await waitFor(
          async () => {
            if (grant.s.done)
              throw new Error(
                'the grant committed while the request was in flight (no account lock)',
              );
            return blockedBy(grant.pid, r.pid);
          },
          1500,
          'grant blocked by the request',
        );
        await within(request, 26_000, 'stalled request');
        const elapsed = request.at - t0;
        assert.equal(request.value?.status, 503, JSON.stringify(request.value));
        assert.equal(request.value.body.code, 'RETRY');
        assert.ok(
          elapsed > 19_000 && elapsed < 24_000,
          `answered after ${elapsed} ms`,
        );
        assert.ok(thrown.includes('25P03'), `store threw ${thrown.join(',')}`);
        assert.equal(
          stalls.at(-1).signal?.aborted,
          true,
          'Blob signal aborted',
        );
        assert.equal(await alive(pid), false, 'terminated backend still alive');
        await within(grant.s, 3000, 'grant after the termination');
        assert.equal(grant.s.error, undefined);
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "PhotoEvidence" WHERE "blobKey"=$1',
            [blobKey],
          ),
          0,
        );
        // The pool hands out working clients afterwards (the dead one was discarded).
        const next = await Promise.all(
          Array.from({ length: 8 }, () =>
            call(
              `/photos?projectId=${projectA}&businessDate=${date}`,
              pm.bearer,
            ),
          ),
        );
        assert.deepEqual(
          next.map((n) => n.status),
          Array(8).fill(200),
        );
      } finally {
        stall = null;
        for (const s of stalls) s.release?.();
        await request.promise;
        await grant?.s.promise;
      }
    },
  );

  // ---------- T6 many short statements past 30 s: transaction_timeout ----------
  await testCase(
    'T6 many-statement transaction past 30 s: 25P04, RETRY, nothing committed, the waiting writer proceeds within ~30 s',
    async () => {
      // TEST-only trigger: every item upsert of this case takes 0.2 s (each statement far below
      // statement_timeout, never idle in between); 200 items need 40 s.
      await owner.query(`CREATE FUNCTION test_slow_item() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
      await owner.query(`CREATE TRIGGER test_slow_item BEFORE INSERT ON "ReportItem"
        FOR EACH ROW WHEN (NEW.label LIKE 'TEST slow%') EXECUTE FUNCTION test_slow_item()`);
      const pm = await newPm();
      const command = items(200, 'TEST slow');
      thrown.length = 0;
      const t0 = now();
      const request = settled(call('/items', pm.bearer, command));
      let grant;
      try {
        const r = await waitFor(requestBackend, 3000, 'request backend');
        grant = await writer(GRANT, [org, seed, pm.account, projectA2]);
        await waitFor(
          async () => {
            if (grant.s.done)
              throw new Error(
                'the grant committed while the request was in flight (no account lock)',
              );
            return blockedBy(grant.pid, r.pid);
          },
          1500,
          'grant blocked by the request',
        );
        await within(request, 38_000, 'long request');
        const elapsed = request.at - t0;
        assert.equal(request.value?.status, 503, JSON.stringify(request.value));
        assert.equal(request.value.body.code, 'RETRY');
        assert.ok(thrown.includes('25P04'), `store threw ${thrown.join(',')}`);
        assert.ok(
          elapsed > 29_000 && elapsed < 33_000,
          `answered after ${elapsed} ms`,
        );
        await within(grant.s, 3000, 'grant after the termination');
        assert.ok(grant.s.at - t0 < 33_000, 'writer waited past ~30 s');
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "ReportItem" WHERE "orgId"=$1 AND label LIKE \'TEST slow%\'',
            [org],
          ),
          0,
        );
        assert.equal(
          await count(
            'SELECT count(*) AS n FROM "IdempotencyRecord" WHERE key=$1',
            [command.clientMutationId],
          ),
          0,
        );
      } finally {
        await request.promise;
        await grant?.s.promise;
        await owner.query('DROP TRIGGER test_slow_item ON "ReportItem"');
        await owner.query('DROP FUNCTION test_slow_item()');
      }
    },
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    `A7-0b transaction protocol timing: ${results.length - failed.length}/${results.length} cases passed; synthetic TEST data only.`,
  );
  if (failed.length) process.exitCode = 1;
} finally {
  if (app) await app.close();
  if (app2) await app2.close();
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
}
