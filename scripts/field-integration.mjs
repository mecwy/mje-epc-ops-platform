// Field roster and entry (A6a-1; devices follow in A6a-2) HTTP + database integration test. Synthetic TEST data
// only (TEST names, generated tokens and codes; no coordinates). Runs against an isolated
// database created for this run; the application connects with a low-privilege role (no
// ownership, no RLS bypass) exactly as deployed. Concurrency cases line requests up on the
// locks they take (pg_locks / pg_stat_activity) instead of sleeping and hoping; deadline cases
// move stored timestamps as the owner with triggers disabled (TEST database only).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  AlphaStore,
  FieldStore,
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
const database = `mje_field_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const admin = new Pool({ connectionString: source.toString() });
const tolerateShutdown = (pool) =>
  pool.on('error', (error) => {
    if (error?.code !== '57P01') throw error;
  });
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
// Everything this process prints (the API included) is scanned for secrets at the end.
const printed = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    printed.push(args.map(String).join(' '));
    original(...args);
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Throttles key on the client IP; each scenario sends its own X-Forwarded-For.
process.env.TRUST_PROXY_HOPS = '1';
const DEFAULT_IP = '10.9.9.9';

// ---------- harness: nothing may wait forever ----------
// Every HTTP call and every wait is bounded; locks the test holds are registered and always
// released in `finally` (a checked-out client would make pool.end() wait forever); a watchdog
// aborts the whole run. A failure prints the step, the source revision and the TEST database.
let currentStep = 'setup';
const step = (name) => {
  currentStep = name;
};
const STEP_MS = 30_000;
const WATCHDOG_MS = Number(process.env.FIELD_TEST_WATCHDOG_MS ?? 300_000);
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
/**
 * Runs a child process in its own process group and kills the whole group on timeout. Never
 * synchronous: a blocked event loop would keep the watchdog from firing.
 */
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
function runBounded(command, args, env, ms, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    children.add(child.pid);
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
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child.pid);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? `exit ${code}`})`));
    });
  });
}
const MIGRATE_MS = Number(process.env.FIELD_TEST_MIGRATE_MS ?? 180_000);
const failure = (why) =>
  console.error(
    `FIELD TEST FAILED at step "${currentStep}": ${why}; source ${revision}; TEST database ${database}`,
  );
/** Release functions of every lock the test holds; emptied as they are released. */
const held = new Set();
async function releaseHeld() {
  for (const release of [...held])
    await withTimeout(release(), 5_000, 'releasing a held lock').catch(
      () => undefined,
    );
}
/**
 * During shutdown, DROP ... WITH (FORCE) terminates connections that are still checked out
 * (a held lock, a request cut off by a timeout); their clients then emit 'error'. Only those
 * are tolerated, and only once shutdown has begun.
 */
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
  if (roleCreated) {
    await admin.query(`DROP ROLE IF EXISTS "${username}"`);
    roleCreated = false;
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

try {
  await admin.query(`CREATE DATABASE "${database}"`);
  dbCreated = true;
  await runBounded(
    'pnpm',
    ['db:migrate'],
    { ...process.env, DATABASE_URL: isolated.toString() },
    MIGRATE_MS,
    'db:migrate',
  );
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
    new Pool({ connectionString: appUrl.toString(), max: 10 }),
  );

  // ---------- synthetic TEST tenancy ----------
  const tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID(),
    seedActor = randomUUID();
  const orgA = randomUUID(),
    orgB = randomUUID();
  const projectA = randomUUID(),
    projectA2 = randomUUID(),
    projectB = randomUUID();
  const person = {};
  const names = [];
  const addPerson = async (key, orgId) => {
    person[key] = randomUUID();
    const displayName = `TEST ${key} ${randomBytes(3).toString('hex')}`;
    names.push(displayName);
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4)',
      [person[key], orgId, seedActor, displayName],
    );
  };
  for (const [orgId, name] of [
    [orgA, 'TEST Organization A'],
    [orgB, 'TEST Organization B'],
  ])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [orgId, name, seedActor],
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
  const workersA = ['pm', 'exec', 'pm2', 'f1', 'f2', 'f3', 'f4', 'fx', 'wx'];
  for (let i = 1; i <= 8; i++) workersA.push(`w${i}`);
  for (let i = 1; i <= 40; i++) workersA.push(`o${i}`);
  workersA.push('a2only', 'unrostered');
  for (const k of workersA) await addPerson(k, orgA);
  for (const k of ['pmB', 'wb']) await addPerson(k, orgB);
  const accounts = {};
  const objects = {};
  for (const [key, orgId, personKey] of [
    ['pm', orgA, 'pm'],
    ['twin', orgA, 'pm'],
    ['exec', orgA, 'exec'],
    ['pm2', orgA, 'pm2'],
    ['pmB', orgB, 'pmB'],
  ]) {
    accounts[key] = randomUUID();
    objects[key] = randomUUID();
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [
        accounts[key],
        orgId,
        seedActor,
        tenantId,
        objects[key],
        person[personKey],
      ],
    );
  }
  const membership = (orgId, accountId, role, projectId) =>
    owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now()-interval \'1 hour\',$5,$6)',
      [randomUUID(), orgId, seedActor, role, accountId, projectId],
    );
  await membership(orgA, accounts.pm, 'PROJECT_MANAGER', projectA);
  // The same person's second account is also PM of project A (self-confirm through it).
  await membership(orgA, accounts.twin, 'PROJECT_MANAGER', projectA);
  await membership(orgA, accounts.exec, 'EXECUTIVE_READER', null);
  await membership(orgA, accounts.pm2, 'PROJECT_MANAGER', projectA2);
  await membership(orgB, accounts.pmB, 'PROJECT_MANAGER', projectB);

  // TEST seam on the app's own pool: a gate can hold one request right after a chosen
  // statement, so another transaction can commit between two statements of that request.
  let queryGate = null;
  const realConnect = appPool.connect.bind(appPool);
  appPool.connect = async (...args) => {
    if (typeof args[0] === 'function') return realConnect(...args);
    const client = await realConnect();
    if (!client.gated) {
      client.gated = true;
      const query = client.query.bind(client);
      client.query = async (...q) => {
        const result = await query(...q);
        const text = typeof q[0] === 'string' ? q[0] : (q[0]?.text ?? '');
        const gate = queryGate;
        if (gate && gate.match(text)) {
          queryGate = null;
          gate.hit();
          await gate.opened;
        }
        return result;
      };
    }
    return client;
  };

  const keys = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [jwk] }));
  const fieldStore = new FieldStore(appPool);
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    fieldStore,
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function jwt(oid) {
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
      exp: now + 3600,
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .sign(keys.privateKey);
  }
  const pm = await jwt(objects.pm),
    exec = await jwt(objects.exec),
    pm2 = await jwt(objects.pm2),
    pmB = await jwt(objects.pmB);

  // ---------- HTTP helpers ----------
  const responses = [];
  async function http(path, { method, bearer, body, key, ip = DEFAULT_IP }) {
    const headers = { 'X-Forwarded-For': ip };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const k = key ?? body?.clientMutationId;
    if (k) headers['Idempotency-Key'] = k;
    const label = `${method} ${path}`;
    const r = await withTimeout(
      fetch(base + path, {
        method,
        headers,
        signal: AbortSignal.timeout(STEP_MS),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      STEP_MS,
      label,
    );
    const text = await withTimeout(r.text(), STEP_MS, label);
    responses.push({ path, status: r.status, text });
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  const fpost = (path, token, body, opts = {}) =>
    http('/api/field' + path, { method: 'POST', bearer: token, body, ...opts });
  const pget = (path, bearer) =>
    http('/api/report/field' + path, { method: 'GET', bearer });
  const ppost = (path, bearer, body, key) =>
    http('/api/report/field' + path, { method: 'POST', bearer, body, key });
  const expectStatus = async (promise, status, code) => {
    const r = await promise;
    assert.equal(r.status, status, JSON.stringify(r.body));
    if (code) assert.equal(r.body.code, code);
    return r.body;
  };
  const errorShape = (body) => {
    assert.deepEqual(Object.keys(body).sort(), ['code', 'correlationId']);
    return body.code;
  };

  // ---------- roster helpers ----------
  const rosterV = { [projectA]: 0, [projectA2]: 0, [projectB]: 0 };
  const lastRoster = {};
  async function rosterWrite(path, bearer, projectId, body) {
    const r = await ppost(`/${path}`, bearer, {
      projectId,
      clientMutationId: randomUUID(),
      expectedRosterVersion: rosterV[projectId],
      ...body,
    });
    if (r.status === 200) {
      rosterV[projectId] = r.body.rosterVersion;
      lastRoster[projectId] = r.body;
    }
    return r;
  }
  const crew = async (projectId, code, bearer = pm) =>
    (
      await expectStatus(
        rosterWrite('crews', bearer, projectId, {
          code,
          name: `TEST crew ${code}`,
        }),
        200,
      )
    ).crews.find((c) => c.code === code).id;
  const change = (changes, projectId = projectA, bearer = pm) =>
    rosterWrite('roster/changes', bearer, projectId, { changes });
  const open = (crewId, personId, role = 'MEMBER', from = null) => ({
    op: 'open',
    crewId,
    personId,
    role,
    from,
  });
  const close = (assignmentId, at = null) => ({
    op: 'close',
    assignmentId,
    at,
  });
  const assignment = (personId, role = 'MEMBER') =>
    lastRoster[projectA].assignments
      .filter(
        (a) =>
          a.personId === personId && a.role === role && a.validUntil === null,
      )
      .at(-1).id;

  // ---------- helpers ----------
  const secret = { entry: [] };
  const entryCode = {};
  const count = async (sql, params = []) =>
    (await owner.query(sql, params)).rows[0].n;
  const waitFor = async (sql, params, n, timeoutMs = 15000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await withTimeout(owner.query(sql, params), 5_000, 'lock poll');
      if (r.rows[0].n >= n) return;
      if (Date.now() > until)
        throw new Error(
          `timed out waiting for ${n} lock waiters (step: ${currentStep})`,
        );
      await sleep(20);
    }
  };
  const advisoryWaiters = (key, n) =>
    waitFor(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1
        AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [key],
      n,
    );
  const personKey = (personId, orgId = orgA, projectId = projectA) =>
    `${orgId}:field-person:${projectId}:${personId}`;
  /** Registers a held client; its release runs once, here or in the run's `finally`. */
  function registerHeld(c, unlockSql, params) {
    const release = async () => {
      if (!held.delete(release)) return;
      try {
        await c.query(unlockSql, params);
        c.release();
      } catch (error) {
        c.release(error);
      }
    };
    held.add(release);
    return release;
  }
  // Scheduled instants come from the database clock (the one that judges them), not the host's.
  const dbFuture = async (ms) =>
    (
      await owner.query(
        `SELECT to_char((now() + $1 * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
        [ms],
      )
    ).rows[0].t;
  const untilDb = async (iso, timeoutMs = STEP_MS) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await withTimeout(
        owner.query('SELECT clock_timestamp() > $1::timestamptz AS past', [
          iso,
        ]),
        5_000,
        'database clock poll',
      );
      if (r.rows[0].past) return;
      if (Date.now() > until)
        throw new Error(
          `timed out waiting for the database clock to pass ${iso} (step: ${currentStep})`,
        );
      await sleep(100);
    }
  };

  /**
   * Throttles use fixed, clock-aligned windows. Wait (by the database clock) until at least a
   * minute is left in the current window, so a burst and its assertions never straddle a window
   * boundary.
   */
  const freshWindow = async (windowSec) => {
    const r = await withTimeout(
      owner.query(
        `SELECT extract(epoch FROM clock_timestamp()) % $1 < $1 - 60 AS ok,
          to_char(to_timestamp((floor(extract(epoch FROM clock_timestamp()) / $1) + 1) * $1) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "next"`,
        [windowSec],
      ),
      5_000,
      'window poll',
    );
    if (!r.rows[0].ok) await untilDb(r.rows[0].next, 90_000);
  };

  // ================= entry code =================
  step('entry code');
  const rotateEntry = (projectId, bearer, key = randomUUID()) =>
    ppost(
      '/entry-code/rotate',
      bearer,
      { projectId, clientMutationId: key },
      key,
    );
  {
    const k = randomUUID();
    const first = await expectStatus(rotateEntry(projectA, pm, k), 200);
    const replay = await expectStatus(rotateEntry(projectA, pm, k), 200);
    assert.equal(replay.code, first.code);
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "FieldEntryCode" WHERE "projectId"=$1`,
        [projectA],
      ),
      1,
    );
    const second = await expectStatus(rotateEntry(projectA, pm), 200);
    assert.notEqual(second.code, first.code);
    await expectStatus(
      fpost('/entry', null, { code: first.code }),
      404,
      'ENTRY_CODE_INVALID',
    );
    entryCode[projectA] = second.code;
    entryCode[projectA2] = (
      await expectStatus(rotateEntry(projectA2, pm2), 200)
    ).code;
    entryCode[projectB] = (
      await expectStatus(rotateEntry(projectB, pmB), 200)
    ).code;
    secret.entry.push(
      first.code,
      second.code,
      entryCode[projectA2],
      entryCode[projectB],
    );
    await expectStatus(rotateEntry(projectA, exec), 403, 'READ_ONLY');
    await expectStatus(rotateEntry(projectA2, pm), 403, 'FORBIDDEN');
    // An empty roster still validates the code; a wrong code is refused either way.
    const empty = await expectStatus(
      fpost('/entry', null, { code: entryCode[projectA2] }),
      200,
    );
    assert.deepEqual(empty.roster, []);
    await expectStatus(
      fpost('/entry', null, { code: 'A'.repeat(22) }),
      404,
      'ENTRY_CODE_INVALID',
    );
    await expectStatus(
      fpost('/entry', null, { code: 'short' }),
      400,
      'INVALID_INPUT',
    );
    const audits = await owner.query(
      `SELECT after::text AS a FROM "AuditLog" WHERE action='FIELD_ENTRY_ROTATE'`,
    );
    assert.equal(audits.rows.length, 4);
    pass(
      'entry code: PM rotation is idempotent (replay returns the same code, one row), the previous code stops working, a reader gets READ_ONLY and another project FORBIDDEN; an empty roster still validates the code, a wrong one is ENTRY_CODE_INVALID',
    );
  }

  // ================= roster =================
  step('roster');
  const C = {};
  for (const code of ['C1', 'C2', 'C3', 'C4', 'C5'])
    C[code] = await crew(projectA, code);
  {
    // A stale roster version is refused and changes nothing.
    const stale = await ppost('/crews', pm, {
      projectId: projectA,
      clientMutationId: randomUUID(),
      expectedRosterVersion: rosterV[projectA] - 1,
      code: 'CX',
      name: 'TEST stale',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'VERSION_CONFLICT');
    await expectStatus(
      rosterWrite('crews', pm, projectA, { code: 'C1', name: 'TEST dup' }),
      409,
      'CREW_CODE_TAKEN',
    );
  }
  await expectStatus(
    change([
      ...['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'f1', 'f4'].map((k) =>
        open(C.C1, person[k]),
      ),
      open(C.C1, person.f1, 'FOREMAN'),
      ...['f2', 'w7', 'w8', 'pm', 'f3'].map((k) => open(C.C2, person[k])),
      open(C.C2, person.f2, 'FOREMAN'),
      open(C.C3, person.f3, 'FOREMAN'),
      open(C.C4, person.fx),
      open(C.C4, person.wx),
      open(C.C4, person.fx, 'FOREMAN'),
    ]),
    200,
  );
  await expectStatus(
    change(
      Array.from({ length: 40 }, (_, i) => open(C.C5, person[`o${i + 1}`])),
    ),
    200,
  );
  {
    const CA2 = await crew(projectA2, 'A2', pm2);
    await expectStatus(change([open(CA2, person.a2only)], projectA2, pm2), 200);
    const CB = await crew(projectB, 'B', pmB);
    await expectStatus(change([open(CB, person.wb)], projectB, pmB), 200);
  }
  {
    // Overlaps: one MEMBER interval per person, one FOREMAN per crew, one crew per foreman.
    await expectStatus(
      change([open(C.C2, person.w1)]),
      409,
      'ASSIGNMENT_OVERLAP',
    );
    await expectStatus(
      change([open(C.C1, person.w2, 'FOREMAN')]),
      409,
      'ASSIGNMENT_OVERLAP',
    );
    await expectStatus(
      change([open(C.C5, person.f1, 'FOREMAN')]),
      409,
      'ASSIGNMENT_OVERLAP',
    );
    // Nothing is backdated.
    await expectStatus(
      change([
        open(
          C.C3,
          person.w1,
          'MEMBER',
          new Date(Date.now() - 60_000).toISOString(),
        ),
      ]),
      409,
      'ROSTER_TIME_INVALID',
    );
    await expectStatus(
      change([
        close(
          assignment(person.w1),
          new Date(Date.now() - 60_000).toISOString(),
        ),
      ]),
      409,
      'ROSTER_TIME_INVALID',
    );
    await expectStatus(change([open(C.C1, randomUUID())]), 404, 'NOT_FOUND');
    await expectStatus(change([open(C.C1, person.wb)]), 404, 'NOT_FOUND');
    await expectStatus(
      rosterWrite('crews/end', pm, projectA, { crewId: C.C1 }),
      409,
      'CREW_NOT_EMPTY',
    );
    await expectStatus(
      rosterWrite('roster/changes', exec, projectA, {
        changes: [open(C.C3, person.w1)],
      }),
      403,
      'READ_ONLY',
    );
    // Two overlapping opens at once (different keys, same expected version): one wins.
    const v = rosterV[projectA];
    const race = await Promise.all(
      [C.C3, C.C4].map((crewId) =>
        ppost('/roster/changes', pm, {
          projectId: projectA,
          clientMutationId: randomUUID(),
          expectedRosterVersion: v,
          changes: [open(crewId, person.unrostered)],
        }),
      ),
    );
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    const won = race.find((r) => r.status === 200).body;
    rosterV[projectA] = won.rosterVersion;
    lastRoster[projectA] = won;
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "CrewAssignment" WHERE "personId"=$1`,
        [person.unrostered],
      ),
      1,
    );
    await expectStatus(change([close(assignment(person.unrostered))]), 200);
    // The trigger alone serializes overlapping inserts that bypass the roster lock: the second
    // waits on the person lock, then sees the first and fails (23P01).
    // Both clients go through the lock registry, so a failure here can never leave one held.
    const t1 = await withTimeout(owner.connect(), 5_000, 'owner connect');
    const releaseT1 = registerHeld(t1, 'ROLLBACK', []);
    const t2 = await withTimeout(owner.connect(), 5_000, 'owner connect');
    const releaseT2 = registerHeld(t2, 'ROLLBACK', []);
    try {
      const insert = (c, crewId) =>
        c.query(
          `INSERT INTO "CrewAssignment"(id,"orgId","projectId","crewId","personId",role,"validFrom","createdBy")
          VALUES($1,$2,$3,$4,$5,'MEMBER',now(),$6)`,
          [
            randomUUID(),
            orgA,
            projectA,
            crewId,
            person.unrostered,
            accounts.pm,
          ],
        );
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      await insert(t1, C.C3);
      const second = insert(t2, C.C4).then(
        () => 'inserted',
        (e) => e.code,
      );
      await advisoryWaiters(personKey(person.unrostered), 1);
      await t1.query('COMMIT');
      assert.equal(await second, '23P01');
      await t2.query('ROLLBACK');
      await owner.query(
        `UPDATE "CrewAssignment" SET "validUntil"=now(), "closedBy"=$2 WHERE "personId"=$1 AND "validUntil" IS NULL`,
        [person.unrostered, accounts.pm],
      );
    } finally {
      await releaseT1();
      await releaseT2();
    }
    pass(
      'roster: crews and intervals under the roster version (stale version VERSION_CONFLICT, duplicate crew code); overlapping MEMBER, second FOREMAN of a crew and a foreman of two crews → ASSIGNMENT_OVERLAP; backdated open or close → ROSTER_TIME_INVALID; unknown or other-org person NOT_FOUND; a crew with members cannot end; readers READ_ONLY; two concurrent overlapping opens → one 200, one 409; the trigger itself serializes concurrent raw inserts on the person lock (second → 23P01)',
    );
  }
  const unrosteredRow = await owner.query(
    `SELECT count(*)::int AS n FROM "CrewAssignment" WHERE "personId"=$1`,
    [person.unrostered],
  );
  assert.equal(unrosteredRow.rows[0].n, 2);

  // ================= entry roster read, scheduled end, crew end =================
  step('entry roster read, scheduled end, crew end');
  {
    const read = async () =>
      new Set(
        (
          await expectStatus(
            fpost('/entry', null, { code: entryCode[projectA] }),
            200,
          )
        ).roster.map((r) => r.personId),
      );
    let listed = await read();
    assert.ok(listed.has(person.w1) && listed.has(person.o40));
    assert.ok(!listed.has(person.a2only) && !listed.has(person.wb));
    assert.ok(
      !listed.has(person.unrostered),
      'a closed interval is not current',
    );
    // A scheduled end at E (from the database clock, which judges it): listed before E, not after.
    const E = await dbFuture(4000);
    await expectStatus(change([close(assignment(person.o1), E)]), 200);
    assert.ok((await read()).has(person.o1));
    await untilDb(E);
    listed = await read();
    assert.ok(!listed.has(person.o1));
    // A later interval is a new membership, listed again; the closed one never changes.
    await expectStatus(change([open(C.C5, person.o1)]), 200);
    assert.ok((await read()).has(person.o1));
    // A continuous transfer ends one interval exactly where the next begins.
    await expectStatus(
      change([close(assignment(person.w8)), open(C.C1, person.w8)]),
      200,
    );
    // The last two MEMBER intervals of w8: the one just closed and the one just opened.
    const w8 = lastRoster[projectA].assignments
      .filter((a) => a.personId === person.w8 && a.role === 'MEMBER')
      .slice(-2);
    assert.equal(w8.length, 2);
    assert.equal(w8[0].validUntil, w8[1].validFrom);
    await expectStatus(change([close(w8[0].id)]), 409, 'ASSIGNMENT_CLOSED');
    // An empty crew ends once; nobody joins an ended crew.
    const C6 = await crew(projectA, 'C6');
    await expectStatus(
      rosterWrite('crews/end', pm, projectA, { crewId: C6 }),
      200,
    );
    await expectStatus(change([open(C6, person.w1)]), 409, 'CREW_ENDED');
    await expectStatus(
      rosterWrite('crews/end', pm, projectA, { crewId: C6 }),
      409,
      'CREW_ENDED',
    );
    // Another org's or a nonexistent crew: the same 404; other projects and readers: 403.
    for (const crewId of [randomUUID(), lastRoster[projectB].crews[0].id]) {
      const r = await change([open(crewId, person.w1)]);
      assert.equal(r.status, 404);
      assert.equal(errorShape(r.body), 'NOT_FOUND');
    }
    await expectStatus(
      pget(`/roster?projectId=${projectA}`, exec),
      403,
      'READ_ONLY',
    );
    await expectStatus(
      pget(`/roster?projectId=${projectB}`, pm),
      403,
      'FORBIDDEN',
    );
    // A replayed roster change is applied once.
    const cmd = {
      projectId: projectA,
      clientMutationId: randomUUID(),
      expectedRosterVersion: rosterV[projectA],
      changes: [open(C.C3, person.unrostered)],
    };
    const first = await expectStatus(ppost('/roster/changes', pm, cmd), 200);
    const replay = await expectStatus(ppost('/roster/changes', pm, cmd), 200);
    assert.equal(replay.rosterVersion, first.rosterVersion);
    rosterV[projectA] = first.rosterVersion;
    lastRoster[projectA] = first;
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "CrewAssignment" WHERE "personId"=$1 AND "validUntil" IS NULL`,
        [person.unrostered],
      ),
      1,
    );
    await expectStatus(
      ppost('/roster/changes', pm, {
        ...cmd,
        changes: [open(C.C4, person.unrostered)],
      }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    pass(
      "the entry read lists only current members of the code's project; a scheduled end at E lists the person before E and not after, with no request in between; a later interval is listed again; a continuous transfer closes one interval exactly where the next opens and a closed interval cannot close again; an empty crew ends once and an ended crew takes nobody; another org's or a nonexistent crew gets the identical 404, a reader READ_ONLY and another project FORBIDDEN; a replayed roster change is applied once and a changed body with the same key is refused",
    );
  }

  // ================= roster read is one snapshot =================
  step('roster read is one snapshot');
  {
    // Hold a roster read right after it has read the intervals; commit a roster write; then
    // let the read finish. The version it returns must belong to the intervals it returns.
    let hit, release;
    const reached = new Promise((resolve) => (hit = resolve));
    const opened = new Promise((resolve) => (release = resolve));
    const openGate = async () => {
      held.delete(openGate);
      release();
    };
    held.add(openGate);
    queryGate = {
      match: (text) =>
        text.includes('"CrewAssignment"') &&
        text.includes('"Person"') &&
        !/^\s*(INSERT|UPDATE)/.test(text),
      hit,
      opened,
    };
    const reading = pget(`/roster?projectId=${projectA}`, pm);
    await withTimeout(reached, STEP_MS, 'roster read reaches the gate');
    const written = await expectStatus(
      change([open(C.C4, person.a2only)]),
      200,
    );
    const added = written.assignments.find(
      (a) => a.personId === person.a2only && a.validUntil === null,
    ).id;
    await openGate();
    const read = await expectStatus(reading, 200);
    const hasAdded = read.assignments.some((a) => a.id === added);
    assert.equal(
      hasAdded,
      read.rosterVersion === written.rosterVersion,
      `roster version ${read.rosterVersion} returned ${hasAdded ? 'with' : 'without'} the interval written at version ${written.rosterVersion}`,
    );
    pass(
      'a roster read held between its statements while a roster write commits returns a version that belongs to the crews and intervals it returns (one snapshot), so a stale view can never carry a current expectedRosterVersion',
    );
  }

  // ================= throttling =================
  step('throttling');
  {
    const burst = async (n, fn) => {
      const out = [];
      for (let i = 0; i < n; i += 25)
        out.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(25, n - i) }, (_, j) => fn(i + j)),
          )),
        );
      return out;
    };
    const entry = (code, ip) => fpost('/entry', null, { code }, { ip });
    // Entry: 300 / 10 min per IP; 600 / 10 min per code (a refused request counts too). A
    // fresh code makes the per-code bucket hold only this scenario's requests.
    entryCode[projectA2] = (
      await expectStatus(rotateEntry(projectA2, pm2), 200)
    ).code;
    secret.entry.push(entryCode[projectA2]);
    await freshWindow(600);
    let r = await burst(300, () => entry(entryCode[projectA2], '10.2.0.1'));
    assert.ok(r.every((x) => x.status === 200));
    await expectStatus(
      entry(entryCode[projectA2], '10.2.0.1'),
      429,
      'RATE_LIMITED',
    );
    // The code has counted 301 (the 429 counts too): 299 more reach 600.
    r = await burst(299, () => entry(entryCode[projectA2], '10.2.0.2'));
    assert.ok(r.every((x) => x.status === 200));
    await expectStatus(
      entry(entryCode[projectA2], '10.2.0.3'),
      429,
      'RATE_LIMITED',
    );
    await expectStatus(entry(entryCode[projectA], '10.2.0.3'), 200);
    // Wrong codes count against the IP too; a whole crew behind one NAT is far below the limit.
    r = await burst(40, () => entry(entryCode[projectA], '10.5.0.1'));
    assert.ok(r.every((x) => x.status === 200));
    // Thousands of distinct invalid codes from one IP, far beyond its limit, leave a bounded
    // number of throttle rows: the IP bucket counts every request; a code bucket exists only
    // for a code that exists.
    await freshWindow(600);
    const rowsBefore = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    const guesses = await burst(2000, () =>
      fpost(
        '/entry',
        null,
        { code: randomBytes(16).toString('base64url') },
        { ip: '10.6.0.1' },
      ),
    );
    assert.ok(guesses.every((x) => x.status === 404 || x.status === 429));
    assert.equal(guesses.filter((x) => x.status === 404).length, 300);
    const rowsAfter = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    assert.ok(
      rowsAfter - rowsBefore <= 2,
      `${rowsAfter - rowsBefore} new throttle rows`,
    );
    const buckets = await owner.query(`SELECT bucket FROM "FieldThrottle"`);
    for (const { bucket } of buckets.rows)
      assert.match(bucket, /^[a-z-]+:[0-9a-f]{64}$/);
    pass(
      'throttles: entry 300/10 min per IP and 600/10 min per code (refused requests count) → 429 RATE_LIMITED; 40 people behind one NAT read the roster without a 429; 2000 distinct invalid codes from one IP get 300 × 404 then 429 and add at most 2 throttle rows (no bucket per guessed code); buckets hold only salted hashes',
    );
  }

  // ================= history, grants, RLS, pooled context =================
  step('history, grants, RLS, pooled context');
  {
    const app = await appPool.connect();
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      for (const [sql, pattern] of [
        ['UPDATE "FieldDeviceEvent" SET kind=\'BIND\'', /permission denied/],
        ['DELETE FROM "FieldDeviceEvent"', /permission denied/],
        ['UPDATE "FieldTokenHash" SET "acceptedAt"=now()', /permission denied/],
        ['DELETE FROM "FieldTokenHash"', /permission denied/],
        ['DELETE FROM "CrewAssignment"', /permission denied/],
        ['UPDATE "CrewAssignment" SET role=\'FOREMAN\'', /permission denied/],
        ['DELETE FROM "FieldDevice"', /permission denied/],
        ['UPDATE "FieldDevice" SET "personId"="personId"', /permission denied/],
        [
          'UPDATE "FieldConfirmChallenge" SET "codeHash"="codeHash"',
          /permission denied/,
        ],
      ]) {
        await app.query('SAVEPOINT s');
        await assert.rejects(app.query(sql), pattern, sql);
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      // Closing twice or reopening a closed interval fails.
      await app.query('SAVEPOINT s');
      await assert.rejects(
        app.query(
          `UPDATE "CrewAssignment" SET "validUntil"=now()+interval '1 day' WHERE "validUntil" IS NOT NULL`,
        ),
        /closed, once/,
      );
      await app.query('ROLLBACK TO SAVEPOINT s');
      // Event actors are tenant references: another org's or a nonexistent actor person or
      // device is refused (23503); an actor of the same org and project is accepted.
      const actorEvent = (actor) =>
        app.query(
          `INSERT INTO "FieldDeviceEvent"(id,"orgId","projectId",kind,"actorPersonId","actorDeviceId") VALUES($1,$2,$3,'BIND',$4,$5)`,
          [
            randomUUID(),
            orgA,
            projectA,
            actor.person ?? null,
            actor.device ?? null,
          ],
        );
      for (const actor of [
        { person: person.wb },
        { person: randomUUID() },
        { device: randomUUID() },
      ]) {
        await app.query('SAVEPOINT s');
        await assert.rejects(
          actorEvent(actor),
          (e) => e.code === '23503',
          `actor ${JSON.stringify(actor)} was accepted`,
        );
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      await app.query('SAVEPOINT s');
      await actorEvent({ person: person.w1 });
      await app.query('ROLLBACK TO SAVEPOINT s');
      // RLS: another org's rows are invisible, and cannot be inserted.
      const other = await app.query(
        `SELECT count(*)::int AS n FROM "CrewAssignment" WHERE "orgId"=$1`,
        [orgB],
      );
      assert.equal(other.rows[0].n, 0);
      await app.query('SAVEPOINT s');
      await assert.rejects(
        app.query(
          `INSERT INTO "FieldDeviceEvent"(id,"orgId","projectId",kind) VALUES($1,$2,$3,'BIND')`,
          [randomUUID(), orgB, projectB],
        ),
        (e) => e.code === '42501',
      );
      await app.query('ROLLBACK');
    } finally {
      app.release();
    }
    await assert.rejects(
      owner.query(`DELETE FROM "CrewAssignment"`),
      /append-only/,
    );
    // No pooled connection keeps a device hash, entry code or org after its transaction.
    const pooled = await Promise.all(
      Array.from({ length: 10 }, () => appPool.connect()),
    );
    try {
      for (const c of pooled) {
        const s = await c.query(
          `SELECT COALESCE(current_setting('app.device_token_hash', true), '') AS h, COALESCE(current_setting('app.entry_code', true), '') AS e,
            COALESCE(current_setting('app.org_id', true), '') AS o`,
        );
        assert.deepEqual(s.rows[0], { h: '', e: '', o: '' });
      }
    } finally {
      for (const c of pooled) c.release();
    }
    pass(
      "the app role cannot update or delete events, token hashes or intervals, nor change a device's identity or a challenge's code (column grants on the tables A6a-2 will use); an interval closes once; intervals are append-only for the owner too; device-event actors must be people and devices of the same org (and project), never another tenant's or nonexistent ones; RLS hides and refuses another org; no pooled connection keeps a hash, entry code or org",
    );
  }

  // ================= redaction =================
  step('redaction');
  {
    for (const { path, status, text } of responses) {
      if (status >= 400) {
        const body = JSON.parse(text);
        assert.deepEqual(
          Object.keys(body).sort(),
          ['code', 'correlationId'],
          path,
        );
        for (const s of [...secret.entry, ...names])
          assert.ok(
            !text.includes(s),
            `${path} error carried an entry code or name`,
          );
        continue;
      }
      if (path !== '/api/report/field/entry-code/rotate')
        for (const e of secret.entry)
          assert.ok(!text.includes(e), `${path} carried an entry code`);
    }
    const stored = await owner.query(
      `SELECT string_agg(t, ' ') AS all FROM (
        SELECT concat_ws(' ', before::text, after::text, reason) AS t FROM "AuditLog"
        UNION ALL SELECT concat_ws(' ', "responseBody"::text, route) FROM "IdempotencyRecord") x`,
    );
    for (const s of [...secret.entry, ...names])
      assert.ok(
        !stored.rows[0].all.includes(s),
        'audit or idempotency rows carried an entry code or name',
      );
    for (const line of printed)
      for (const s of [...secret.entry, ...names])
        assert.ok(
          !line.includes(s),
          'process output carried an entry code or name',
        );
    pass(
      `redaction: across ${responses.length} responses every error is exactly {code, correlationId} with no entry code or name; entry codes appear only in the rotation response; audit and idempotency rows (roster replays keep only the version) and all process output carry neither`,
    );
  }

  console.log(
    `Field roster and entry HTTP/DB integration: ${checks} checks passed; synthetic TEST data only. Field devices (A6a-2), check-in, foreman reports and the field web UI are later slices.`,
  );
  step('done');
} catch (error) {
  failure(String(error?.message ?? error).split('\n')[0]);
  console.error(error);
  process.exitCode = 1;
} finally {
  killChildren();
  // Held locks first: a request blocked on one could keep app.close() waiting, and a
  // checked-out client keeps pool.end() waiting forever.
  await releaseHeld();
  // Every step is bounded; an incomplete step is reported and makes the run fail.
  const incomplete = [];
  const bounded = (work, label) =>
    withTimeout(Promise.resolve().then(work), 10_000, label).catch((error) => {
      incomplete.push(label);
      console.error(`cleanup: ${error.message}`);
    });
  if (app) await bounded(() => app.close(), 'app.close');
  if (appPool) await bounded(() => appPool.end(), 'appPool.end');
  if (owner) await bounded(() => owner.end(), 'owner.end');
  // DROP ... WITH (FORCE) also ends any connection a bounded close left behind.
  await bounded(dropTestDatabase, 'drop TEST database');
  await bounded(() => admin.end(), 'admin.end');
  if (incomplete.length) {
    failure(
      `cleanup incomplete (${incomplete.join(', ')}); TEST database and role ${dbCreated || roleCreated ? 'NOT dropped' : 'dropped'}`,
    );
    process.exitCode = 1;
  }
  // The watchdog stays armed until cleanup is over; then a last deadline ends a process that
  // anything still keeps alive (it never keeps the process alive itself).
  clearTimeout(watchdog);
  setTimeout(() => {
    failure('open handles kept the process alive after cleanup; forced exit');
    process.exit(1);
  }, 10_000).unref();
}
