// Field roster, devices and entry (A6a) HTTP + database integration test. Synthetic TEST data
// only (TEST names, generated tokens and codes; no coordinates). Runs against an isolated
// database created for this run; the application connects with a low-privilege role (no
// ownership, no RLS bypass) exactly as deployed. Concurrency cases line requests up on the
// locks they take (pg_locks / pg_stat_activity) instead of sleeping and hoping; deadline cases
// move stored timestamps as the owner with triggers disabled (TEST database only).
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import {
  AlphaStore,
  FieldStore,
  ReportStore,
  clearPreviousHash,
  recordActivity,
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
const sha = (s) => createHash('sha256').update(s).digest('hex');
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
  // TEST seam: queued challenge codes force a collision; otherwise random.
  const codeQueue = [];
  const fieldOptions = {
    challengeCode: () =>
      codeQueue.shift() ?? String(randomInt(0, 1_000_000)).padStart(6, '0'),
    // Switched off where a test must show that no answer depends on deferred housekeeping.
    housekeeping: true,
  };
  const fieldStore = new FieldStore(appPool, fieldOptions);
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
    twin = await jwt(objects.twin),
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
  const fget = (path, token, opts = {}) =>
    http('/api/field' + path, { method: 'GET', bearer: token, ...opts });
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

  // ---------- device helpers ----------
  const secret = { tokens: [], codes: [], entry: [] };
  const newToken = () => {
    const t = 'fd1.' + randomBytes(32).toString('base64url');
    secret.tokens.push(t);
    return t;
  };
  const entryCode = {};
  const bind = (personId, opts = {}) => {
    const token = opts.token ?? newToken();
    return fpost(
      '/bind',
      null,
      { code: opts.code ?? entryCode[projectA], personId, token },
      { ip: opts.ip },
    ).then((r) => ({ ...r, token }));
  };
  const challenge = async (token, opts) => {
    const b = await expectStatus(
      fpost('/device/challenge', token, {}, opts),
      200,
    );
    secret.codes.push(b.code);
    return b.code;
  };
  const pmConfirm = (
    personId,
    code,
    expected = null,
    bearer = pm,
    projectId = projectA,
  ) =>
    ppost('/devices/confirm', bearer, {
      projectId,
      clientMutationId: randomUUID(),
      personId,
      code,
      expectedCurrentDeviceId: expected,
    });
  const fConfirm = (
    token,
    personId,
    code,
    expected = null,
    key = randomUUID(),
  ) =>
    fpost('/devices/confirm', token, {
      clientMutationId: key,
      personId,
      code,
      expectedCurrentDeviceId: expected,
    });
  const pmDevice = (
    action,
    deviceId,
    expectedVersion,
    bearer = pm,
    projectId = projectA,
  ) =>
    ppost(`/devices/${action}`, bearer, {
      projectId,
      clientMutationId: randomUUID(),
      deviceId,
      expectedVersion,
    });
  const rotate = (token, newTok, expectedGeneration) =>
    fpost('/device/rotate', token, { newToken: newTok, expectedGeneration });
  const me = (token, opts) => fget('/me', token, opts);
  async function onboard(personId, opts = {}) {
    const b = await bind(personId, opts);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const c = await challenge(b.token, { ip: opts.ip });
    const r = opts.foreman
      ? await fConfirm(opts.foreman, personId, c)
      : await pmConfirm(
          personId,
          c,
          null,
          opts.bearer ?? pm,
          opts.projectId ?? projectA,
        );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { token: b.token, id: b.body.deviceId };
  }
  const row = async (id) =>
    (
      await owner.query(
        `SELECT state, "endReason", version, generation, "memberUntil", "lastSeenAt", "prevTokenHash", "tokenHash"
        FROM "FieldDevice" WHERE id=$1`,
        [id],
      )
    ).rows[0];
  const count = async (sql, params = []) =>
    (await owner.query(sql, params)).rows[0].n;
  /** Moves stored timestamps as the owner with triggers off (TEST database only). */
  async function travel(sql, params) {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(sql, params);
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
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
  const rowWaiters = (n) =>
    waitFor(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND wait_event IN ('tuple','transactionid')`,
      [username],
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
  async function holdAdvisory(key) {
    const c = await withTimeout(owner.connect(), 5_000, 'owner connect');
    await withTimeout(
      c.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]),
      5_000,
      'hold advisory lock',
    );
    return registerHeld(
      c,
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
      [key],
    );
  }
  async function holdRow(id) {
    const c = await withTimeout(owner.connect(), 5_000, 'owner connect');
    await c.query('BEGIN');
    await withTimeout(
      c.query('SELECT 1 FROM "FieldDevice" WHERE id=$1 FOR UPDATE', [id]),
      5_000,
      'hold row lock',
    );
    return registerHeld(c, 'COMMIT', []);
  }
  const dbNow = async () =>
    (await owner.query('SELECT now()::text AS t')).rows[0].t;
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

  // ================= entry, bind, pending =================
  step('entry, bind, pending');
  {
    const entry = await expectStatus(
      fpost('/entry', null, { code: entryCode[projectA] }),
      200,
    );
    assert.equal(entry.project.id, projectA);
    const listed = new Set(entry.roster.map((r) => r.personId));
    assert.ok(listed.has(person.w1) && listed.has(person.o40));
    assert.ok(!listed.has(person.a2only) && !listed.has(person.wb));
    assert.ok(
      !listed.has(person.unrostered),
      'a closed interval is not current',
    );
    const b = await bind(person.w5);
    assert.equal(b.status, 200);
    assert.equal(b.body.state, 'PENDING');
    const again = await bind(person.w5, { token: b.token });
    assert.equal(again.body.deviceId, b.body.deviceId);
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "FieldDevice" WHERE "personId"=$1`,
        [person.w5],
      ),
      1,
    );
    await expectStatus(
      bind(person.w6, { token: b.token }),
      409,
      'TOKEN_CONFLICT',
    );
    await expectStatus(bind(person.a2only), 404, 'PERSON_NOT_ROSTERED');
    await expectStatus(bind(person.unrostered), 404, 'PERSON_NOT_ROSTERED');
    await expectStatus(bind(person.wb), 404, 'PERSON_NOT_ROSTERED');
    await expectStatus(bind(randomUUID()), 404, 'PERSON_NOT_ROSTERED');
    await expectStatus(
      bind(person.w5, { code: 'B'.repeat(22) }),
      404,
      'ENTRY_CODE_INVALID',
    );
    const b2 = await bind(person.w5);
    const b3 = await bind(person.w5);
    assert.equal(b2.status, 200);
    assert.equal(b3.status, 200);
    await expectStatus(bind(person.w5), 409, 'TOO_MANY_PENDING');
    const mine = await expectStatus(me(b.token), 200);
    assert.equal(mine.device.state, 'PENDING');
    assert.equal(mine.person.id, person.w5);
    assert.equal(mine.foreman, null);
    await expectStatus(
      fConfirm(b.token, person.w6, '123456'),
      403,
      'DEVICE_PENDING',
    );
    await expectStatus(rotate(b.token, newToken(), 1), 403, 'DEVICE_PENDING');
    // Pending 24 h: past pendingUntil the next request persists EXPIRED and is refused.
    await travel(
      `UPDATE "FieldDevice" SET "pendingUntil"=now()-interval '1 second' WHERE id=$1`,
      [b3.body.deviceId],
    );
    await expectStatus(me(b3.token), 401, 'DEVICE_ENDED');
    const expired = await row(b3.body.deviceId);
    assert.equal(expired.state, 'EXPIRED');
    assert.equal(expired.endReason, 'PENDING_TIMEOUT');
    // With one pending slot free again, a bind succeeds.
    assert.equal((await bind(person.w5)).status, 200);
    pass(
      "entry lists only current members of the code's project; bind is idempotent per token (same token + person → same row; another person → TOKEN_CONFLICT); not rostered (other project, closed interval, other org, unknown) → PERSON_NOT_ROSTERED; ≤ 3 pending per person; a pending device reads GET me but gets DEVICE_PENDING on confirm and rotate; past pendingUntil the device is persisted EXPIRED(PENDING_TIMEOUT)",
    );
  }

  // ================= foremen, competing binds, challenge collision =================
  step('foremen, competing binds, challenge collision');
  const dev = {};
  dev.f1 = await onboard(person.f1);
  dev.f2 = await onboard(person.f2);
  {
    // Competing binds for one person: only the browser whose code is typed gets confirmed.
    const a = await bind(person.w1);
    const b = await bind(person.w1);
    const ca = await challenge(a.token);
    const cb = await challenge(b.token);
    assert.notEqual(ca, cb);
    const confirmed = await expectStatus(
      fConfirm(dev.f1.token, person.w1, cb),
      200,
    );
    assert.deepEqual(confirmed, {
      deviceId: b.body.deviceId,
      personId: person.w1,
      state: 'CONFIRMED',
    });
    assert.equal((await row(a.body.deviceId)).endReason, 'SUPERSEDED');
    await expectStatus(me(a.token), 401, 'DEVICE_ENDED');
    await expectStatus(me(b.token), 200);
    await expectStatus(
      fConfirm(dev.f1.token, person.w1, ca, b.body.deviceId),
      409,
      'CHALLENGE_INVALID',
    );
    dev.w1 = { token: b.token, id: b.body.deviceId, rejected: a };
    const list = await expectStatus(
      pget(`/devices?projectId=${projectA}`, pm),
      200,
    );
    const shown = list.find((d) => d.id === dev.w1.id);
    assert.deepEqual(shown.confirmedBy, {
      kind: 'FOREMAN',
      personId: person.f1,
    });
    assert.equal(list.find((d) => d.id === dev.f1.id).confirmedBy.kind, 'PM');
    assert.ok(!JSON.stringify(list).includes('okenHash'));
    await expectStatus(
      pget(`/devices?projectId=${projectA}`, exec),
      403,
      'READ_ONLY',
    );
    // The foreman sees the crew's current devices (for expectedCurrentDeviceId).
    const view = await expectStatus(me(dev.f1.token), 200);
    assert.equal(view.foreman.crewId, C.C1);
    assert.equal(
      view.foreman.members.find((m) => m.personId === person.w1)
        .currentDeviceId,
      dev.w1.id,
    );
    // Code collision for one person: the second draw equals a live code and is redrawn.
    const q1 = await bind(person.w8);
    const q2 = await bind(person.w8);
    codeQueue.push('111111', '111111', '222222');
    assert.equal(await challenge(q1.token), '111111');
    assert.equal(await challenge(q2.token), '222222');
    await expectStatus(fConfirm(dev.f2.token, person.w8, '222222'), 200);
    dev.w8 = { token: q2.token, id: q2.body.deviceId };
    assert.equal((await row(q1.body.deviceId)).state, 'REJECTED');
    pass(
      "competing binds: only the browser whose challenge was typed is confirmed, the other is REJECTED(SUPERSEDED) and its code dies; PM list marks foreman confirmations for spot checks and never shows a hash; readers get READ_ONLY; the foreman's GET me lists the crew's current device; a challenge code equal to a live code of the same person is redrawn",
    );
  }

  // ================= failed matches: per person, committed, replay-safe =================
  step('failed matches: per person, committed, replay-safe');
  {
    const p1 = await bind(person.w7);
    const p2 = await bind(person.w7);
    codeQueue.push('314159', '271828');
    const c1 = await challenge(p1.token);
    const c2 = await challenge(p2.token);
    const failures = () =>
      count(
        `SELECT failures AS n FROM "FieldPersonConfirm" WHERE "personId"=$1`,
        [person.w7],
      );
    const keysUsed = [];
    for (let i = 1; i <= 4; i++) {
      keysUsed.push(randomUUID());
      await expectStatus(
        fConfirm(dev.f2.token, person.w7, `00000${i}`, null, keysUsed.at(-1)),
        409,
        'CHALLENGE_INVALID',
      );
      assert.equal(await failures(), i);
    }
    // A same-key retry replays the stored failure without counting it again.
    await expectStatus(
      fConfirm(dev.f2.token, person.w7, '000002', null, keysUsed[1]),
      409,
      'CHALLENGE_INVALID',
    );
    assert.equal(await failures(), 4);
    await expectStatus(
      fConfirm(dev.f2.token, person.w7, '000009', null, keysUsed[1]),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    // The fifth failure supersedes every live challenge of the person and resets the counter.
    await expectStatus(
      fConfirm(dev.f2.token, person.w7, '000005'),
      409,
      'CHALLENGE_INVALID',
    );
    assert.equal(await failures(), 0);
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "FieldConfirmChallenge" WHERE "personId"=$1 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
        [person.w7],
      ),
      0,
    );
    await expectStatus(
      fConfirm(dev.f2.token, person.w7, c1),
      409,
      'CHALLENGE_INVALID',
    );
    await expectStatus(
      fConfirm(dev.f2.token, person.w7, c2),
      409,
      'CHALLENGE_INVALID',
    );
    const fresh = await challenge(p1.token);
    await expectStatus(fConfirm(dev.f2.token, person.w7, fresh), 200);
    dev.w7 = { token: p1.token, id: p1.body.deviceId };
    assert.equal((await row(p2.body.deviceId)).endReason, 'SUPERSEDED');
    // The confirmer's own failure count: 7 new failures, the replay not counted.
    assert.equal(
      await count(
        `SELECT sum(count)::int AS n FROM "FieldThrottle" WHERE bucket=$1`,
        [`confirm-fail:${dev.f2.id}`],
      ),
      7,
    );
    pass(
      "wrong codes are counted per person across two pending devices, each failure committed with its 409; a same-key retry replays the failure without counting (a changed body → IDEMPOTENCY_KEY_REUSED); the fifth failure supersedes every live challenge and resets the counter; the confirmer's hourly failure count excludes replays",
    );
  }

  // ================= challenge expiry, reuse, wrong version =================
  step('challenge expiry, reuse, wrong version');
  {
    const d = await bind(person.w2);
    const c = await challenge(d.token);
    await travel(
      `UPDATE "FieldConfirmChallenge" SET "expiresAt"=now()-interval '1 second' WHERE "deviceId"=$1 AND "usedAt" IS NULL AND "supersededAt" IS NULL`,
      [d.body.deviceId],
    );
    await expectStatus(
      fConfirm(dev.f1.token, person.w2, c),
      409,
      'CHALLENGE_INVALID',
    );
    const c2 = await challenge(d.token);
    await travel(`UPDATE "FieldDevice" SET version=version+1 WHERE id=$1`, [
      d.body.deviceId,
    ]);
    await expectStatus(
      fConfirm(dev.f1.token, person.w2, c2),
      409,
      'CHALLENGE_INVALID',
    );
    const c3 = await challenge(d.token);
    await expectStatus(fConfirm(dev.f1.token, person.w2, c3), 200);
    await expectStatus(
      fConfirm(dev.f1.token, person.w2, c3, d.body.deviceId),
      409,
      'CHALLENGE_INVALID',
    );
    dev.w2 = { token: d.token, id: d.body.deviceId };
    // A confirmed device cannot ask for a code.
    await expectStatus(
      fpost('/device/challenge', d.token, {}),
      403,
      'FORBIDDEN',
    );
    pass(
      'an expired challenge, a challenge bound to an older device version and a used code are all CHALLENGE_INVALID; a confirmed device cannot request a code',
    );
  }

  // ================= stale confirmation, revoke before confirm =================
  step('stale confirmation, revoke before confirm');
  {
    const d1 = await onboard(person.w3, { foreman: dev.f1.token });
    const view = await expectStatus(me(dev.f1.token), 200);
    const seen = view.foreman.members.find(
      (m) => m.personId === person.w3,
    ).currentDeviceId;
    assert.equal(seen, d1.id);
    const d2 = await bind(person.w3);
    await expectStatus(
      pmConfirm(person.w3, await challenge(d2.token), d1.id),
      200,
    );
    assert.equal((await row(d1.id)).endReason, 'REPLACED');
    // The foreman still believes d1 is current: another phone was confirmed meanwhile.
    const d3 = await bind(person.w3);
    const c3 = await challenge(d3.token);
    await expectStatus(
      fConfirm(dev.f1.token, person.w3, c3, seen),
      409,
      'CONFIRM_STALE',
    );
    await expectStatus(pmConfirm(person.w3, c3, seen), 409, 'CONFIRM_STALE');
    await expectStatus(
      fConfirm(dev.f1.token, person.w3, c3, d2.body.deviceId),
      200,
    );
    assert.equal((await row(d2.body.deviceId)).endReason, 'REPLACED');
    // PM revoke with an old version is refused; with the current one it ends the device.
    await expectStatus(
      pmDevice('revoke', d3.body.deviceId, 1),
      409,
      'VERSION_CONFLICT',
    );
    const revoked = await expectStatus(
      pmDevice('revoke', d3.body.deviceId, 2),
      200,
    );
    assert.equal(revoked.state, 'REVOKED');
    await expectStatus(me(d3.token), 401, 'DEVICE_ENDED');
    // Revoke (of a pending device) before the confirmation: its code dies with it.
    const d4 = await bind(person.w3);
    const c4 = await challenge(d4.token);
    await expectStatus(pmDevice('revoke', d4.body.deviceId, 1), 200);
    assert.equal((await row(d4.body.deviceId)).state, 'REJECTED');
    await expectStatus(
      fConfirm(dev.f1.token, person.w3, c4),
      409,
      'CHALLENGE_INVALID',
    );
    // The current device was revoked meanwhile: a confirmer expecting it is stale.
    const d5 = await bind(person.w3);
    const c5 = await challenge(d5.token);
    await expectStatus(
      fConfirm(dev.f1.token, person.w3, c5, d3.body.deviceId),
      409,
      'CONFIRM_STALE',
    );
    await expectStatus(fConfirm(dev.f1.token, person.w3, c5, null), 200);
    dev.w3 = { token: d5.token, id: d5.body.deviceId };
    // PM reject only applies to a pending device; a terminal one is VERSION_CONFLICT.
    await expectStatus(
      pmDevice('reject', d5.body.deviceId, 2),
      409,
      'VERSION_CONFLICT',
    );
    await expectStatus(
      pmDevice('revoke', d3.body.deviceId, 3),
      409,
      'VERSION_CONFLICT',
    );
    const d6 = await bind(person.w3);
    await expectStatus(pmDevice('reject', d6.body.deviceId, 1), 200);
    pass(
      'CONFIRM_STALE when another phone was confirmed or the current one revoked since the confirmer looked (foreman and PM); a confirmation revokes the previous device (REPLACED) first; PM revoke/reject need the current version and a live (reject: pending) device; revoking a pending device before its confirmation kills its code',
    );
  }

  // ================= self-confirm, authority, not found =================
  step('self-confirm, authority, not found');
  {
    const s = await bind(person.pm);
    const cs = await challenge(s.token);
    await expectStatus(pmConfirm(person.pm, cs, null, pm), 403, 'SELF_CONFIRM');
    await expectStatus(
      pmConfirm(person.pm, cs, null, twin),
      403,
      'SELF_CONFIRM',
    );
    await expectStatus(fConfirm(dev.f2.token, person.pm, cs), 200);
    const second = await bind(person.f1);
    const cf = await challenge(second.token);
    await expectStatus(
      fConfirm(dev.f1.token, person.f1, cf),
      403,
      'SELF_CONFIRM',
    );
    // Foreman of another crew, a plain worker, a foreman of an empty crew.
    await expectStatus(
      fConfirm(dev.f2.token, person.w1, '123456'),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      fConfirm(dev.w1.token, person.w2, '123456'),
      403,
      'NOT_FOREMAN',
    );
    dev.f3 = await onboard(person.f3, { foreman: dev.f2.token });
    await expectStatus(
      fConfirm(dev.f3.token, person.w7, '123456'),
      403,
      'NOT_FOREMAN',
    );
    // Outside the project, another org or nonexistent: the same 404.
    const bodies = [];
    for (const target of [person.a2only, person.wb, randomUUID()]) {
      const r = await fConfirm(dev.f1.token, target, '123456');
      assert.equal(r.status, 404);
      bodies.push(errorShape(r.body));
    }
    assert.deepEqual(bodies, ['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
    await expectStatus(pmConfirm(person.wb, '123456'), 404, 'NOT_FOUND');
    pass(
      "SELF_CONFIRM for the PM through either of the person's accounts and for a foreman's own second phone; another crew's foreman, a worker and the foreman of an empty crew get NOT_FOREMAN; a person outside the project, in another org or nonexistent gets the identical 404",
    );
  }

  // ================= foreman handover at a scheduled instant =================
  step('foreman handover at a scheduled instant');
  {
    dev.f4 = await onboard(person.f4, { foreman: dev.f1.token });
    const E = await dbFuture(4000);
    await expectStatus(
      change([
        close(assignment(person.f1, 'FOREMAN'), E),
        open(C.C1, person.f4, 'FOREMAN', E),
      ]),
      200,
    );
    await expectStatus(
      fConfirm(dev.f4.token, person.w4, '123456'),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      fConfirm(dev.f1.token, person.w4, '123456'),
      409,
      'CHALLENGE_INVALID',
    );
    await untilDb(E);
    await expectStatus(
      fConfirm(dev.f1.token, person.w4, '123456'),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      fConfirm(dev.f4.token, person.w4, '123456'),
      409,
      'CHALLENGE_INVALID',
    );
    // Losing only the FOREMAN role keeps the device.
    await expectStatus(me(dev.f1.token), 200);
    pass(
      "a scheduled foreman handover at E: before E the old foreman has authority and the new one NOT_FOREMAN, after E the reverse, with no request in between; the old foreman's device stays valid",
    );
  }

  // ================= rotation =================
  step('rotation');
  {
    const O = dev.w1.token;
    const N1 = newToken();
    assert.deepEqual(await expectStatus(rotate(O, N1, 1), 200), {
      generation: 2,
    });
    await expectStatus(me(O), 401, 'FIELD_AUTH_REQUIRED');
    // Lost response: the exact replay with the previous token returns the same 200.
    assert.deepEqual(await expectStatus(rotate(O, N1, 1), 200), {
      generation: 2,
    });
    await expectStatus(rotate(O, newToken(), 1), 401, 'FIELD_AUTH_REQUIRED');
    await expectStatus(
      fConfirm(O, person.w2, '123456'),
      401,
      'FIELD_AUTH_REQUIRED',
    );
    assert.notEqual((await row(dev.w1.id)).prevTokenHash, null);
    // The new token's first use clears the recovery hash; the replay then stops working.
    await expectStatus(me(N1), 200);
    assert.equal((await row(dev.w1.id)).prevTokenHash, null);
    await expectStatus(rotate(O, N1, 1), 401, 'FIELD_AUTH_REQUIRED');
    // A stale tab: current token, old generation.
    const N3 = newToken();
    await expectStatus(rotate(N1, N3, 1), 409, 'VERSION_CONFLICT');
    await expectStatus(rotate(N1, N3, 2), 200);
    await expectStatus(rotate(N1, N3, 2), 200);
    // Refused after rotatedAt + 7 days even though it was never cleared.
    await travel(
      `UPDATE "FieldDevice" SET "rotatedAt"="rotatedAt"-interval '7 days 1 second' WHERE id=$1`,
      [dev.w1.id],
    );
    assert.notEqual((await row(dev.w1.id)).prevTokenHash, null);
    await expectStatus(rotate(N1, N3, 2), 401, 'FIELD_AUTH_REQUIRED');
    // A stale clear task for an older generation never clears the newer recovery hash.
    assert.equal(
      await clearPreviousHash(appPool, orgA, dev.w1.id, 2, sha(N1)),
      false,
    );
    assert.equal((await row(dev.w1.id)).prevTokenHash, sha(N1));
    // Every accepted hash is burned: a rejected device's token, a previous token, the same token.
    await expectStatus(
      rotate(N3, dev.w1.rejected.token, 3),
      409,
      'TOKEN_CONFLICT',
    );
    await expectStatus(rotate(N3, N3, 3), 409, 'TOKEN_CONFLICT');
    await expectStatus(bind(person.w6, { token: O }), 409, 'TOKEN_CONFLICT');
    await expectStatus(bind(person.w6, { token: N1 }), 409, 'TOKEN_CONFLICT');
    // Two tabs rotate the same token at once: exactly one wins, the other is refused.
    const release = await holdAdvisory(personKey(person.w1));
    const N4 = newToken(),
      N5 = newToken();
    const tabs = [rotate(N3, N4, 3), rotate(N3, N5, 3)];
    await advisoryWaiters(personKey(person.w1), 2);
    await release();
    const results = await Promise.all(tabs);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    const winner = results[0].status === 200 ? N4 : N5;
    const loser = winner === N4 ? N5 : N4;
    await expectStatus(me(winner), 200);
    await expectStatus(me(loser), 401, 'FIELD_AUTH_REQUIRED');
    dev.w1.token = winner;
    pass(
      "rotation: the previous token only replays its own rotation (lost response → same 200), is refused on every other route and for another new token, is cleared by the new token's first use and refused after rotatedAt + 7 d even if never cleared; a stale clear task leaves a newer recovery hash; a stale tab → VERSION_CONFLICT; a reused, previous or identical hash → TOKEN_CONFLICT (rotate and bind); two concurrent tabs → one 200, one 401",
    );
  }

  // ================= revoke vs rotate; release =================
  step('revoke vs rotate; release');
  {
    dev.w4 = await onboard(person.w4, { foreman: dev.f4.token });
    const release = await holdAdvisory(personKey(person.w4));
    const N = newToken();
    const rot = rotate(dev.w4.token, N, 1);
    const rev = pmDevice('revoke', dev.w4.id, 2);
    await advisoryWaiters(personKey(person.w4), 2);
    await release();
    const [a, b] = await Promise.all([rot, rev]);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.ok(
      a.status === 200 || (a.status === 401 && a.body.code === 'DEVICE_ENDED'),
      JSON.stringify(a),
    );
    await expectStatus(me(dev.w4.token), 401);
    await expectStatus(me(N), 401);
    assert.equal((await row(dev.w4.id)).state, 'REVOKED');
    dev.w6 = await onboard(person.w6, { foreman: dev.f4.token });
    const key = randomUUID();
    const released = await expectStatus(
      fpost('/device/release', dev.w6.token, { clientMutationId: key }),
      200,
    );
    assert.equal(released.state, 'REVOKED');
    assert.equal((await row(dev.w6.id)).endReason, 'RELEASED');
    await expectStatus(
      fpost('/device/release', dev.w6.token, { clientMutationId: key }),
      401,
      'DEVICE_ENDED',
    );
    await expectStatus(
      fpost(
        '/device/release',
        dev.w8.token,
        { clientMutationId: randomUUID() },
        { key: randomUUID() },
      ),
      400,
      'INVALID_INPUT',
    );
    pass(
      `revoke vs rotate lined up on the person lock (this run: rotate ${a.status}): the revoke always lands and neither the old nor the new token works afterwards; release ends the own device (REVOKED/RELEASED) and a replay re-authenticates (DEVICE_ENDED); a key that differs from clientMutationId is INVALID_INPUT`,
    );
  }

  // ================= idle deadline =================
  step('idle deadline');
  {
    // (1) A authenticates just before lastSeenAt + 30 d, B just after; both FOR UPDATE, A first.
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '30 days'+interval '2500 milliseconds' WHERE id=$1`,
      [dev.w2.id],
    );
    let unlock = await holdRow(dev.w2.id);
    const A = me(dev.w2.token);
    await rowWaiters(1);
    await sleep(3000);
    const B = me(dev.w2.token);
    await rowWaiters(2);
    await unlock();
    const [ra, rb] = await Promise.all([A, B]);
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    assert.equal((await row(dev.w2.id)).state, 'CONFIRMED');
    // (2) B (after the deadline) runs first and persists EXPIRED; A (before it) then sees it.
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '30 days'+interval '2500 milliseconds' WHERE id=$1`,
      [dev.w3.id],
    );
    const releasePerson = await holdAdvisory(personKey(person.w3));
    const A2 = rotate(dev.w3.token, newToken(), 1);
    await advisoryWaiters(personKey(person.w3), 1);
    await sleep(3000);
    // B's own transaction must commit EXPIRED before it answers (no deferred housekeeping).
    fieldOptions.housekeeping = false;
    await expectStatus(me(dev.w3.token), 401, 'DEVICE_ENDED');
    fieldOptions.housekeeping = true;
    const ended = await row(dev.w3.id);
    assert.deepEqual([ended.state, ended.endReason], ['EXPIRED', 'IDLE']);
    await releasePerson();
    await expectStatus(A2, 401, 'DEVICE_ENDED');
    await expectStatus(me(dev.w3.token), 401, 'DEVICE_ENDED');
    // (3) Reclassification: a FOR SHARE request delayed across the last margin day.
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '29 days'+interval '2500 milliseconds' WHERE id=$1`,
      [dev.w7.id],
    );
    const L = (
      await owner.query(
        `SELECT "lastSeenAt"::text AS t FROM "FieldDevice" WHERE id=$1`,
        [dev.w7.id],
      )
    ).rows[0].t;
    unlock = await holdRow(dev.w7.id);
    const R = me(dev.w7.token);
    await rowWaiters(1);
    await sleep(3000);
    await unlock();
    await expectStatus(R, 200);
    const advanced = await owner.query(
      `SELECT "lastSeenAt" >= $2::timestamptz + interval '29 days' AS ok FROM "FieldDevice" WHERE id=$1`,
      [dev.w7.id, L],
    );
    assert.equal(
      advanced.rows[0].ok,
      true,
      'the delayed request recorded its activity',
    );
    // (4) The deferred FOR SHARE activity update never moves back, never touches a terminal
    // row and never touches a row within a day of its deadline.
    const now = await dbNow();
    assert.equal(
      await recordActivity(appPool, orgA, dev.f2.id, '2000-01-01 00:00:00+00'),
      false,
    );
    assert.equal(await recordActivity(appPool, orgA, dev.w3.id, now), false);
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '29 days 1 hour' WHERE id=$1`,
      [dev.f2.id],
    );
    assert.equal(await recordActivity(appPool, orgA, dev.f2.id, now), false);
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '2 days' WHERE id=$1`,
      [dev.f2.id],
    );
    assert.equal(await recordActivity(appPool, orgA, dev.f2.id, now), true);
    // An ordinary FOR SHARE request records its activity after the transaction.
    await travel(
      `UPDATE "FieldDevice" SET "lastSeenAt"=now()-interval '2 days' WHERE id=$1`,
      [dev.f2.id],
    );
    await expectStatus(me(dev.f2.token), 200);
    assert.ok(
      Date.now() - (await row(dev.f2.id)).lastSeenAt.getTime() < 60_000,
    );
    pass(
      "idle deadline: A (just before) and B (just after) serialize FOR UPDATE — A first → both 200 with A's activity; B first → EXPIRED(IDLE) committed, then A sees it (never revived); a FOR SHARE request whose wall clock crossed into the last day while it waited reclassifies and records its activity; the deferred update refuses an older authAt, a terminal row and a row within a day of its deadline",
    );
  }

  // ================= transfer, termination, scheduled end =================
  step('transfer, termination, scheduled end');
  {
    // Continuous transfer in one transaction keeps the device.
    await expectStatus(
      change([close(assignment(person.w8)), open(C.C1, person.w8)]),
      200,
    );
    await expectStatus(me(dev.w8.token), 200);
    assert.equal((await row(dev.w8.id)).memberUntil, null);
    // Split over two transactions: the gap ends it, and reassignment does not revive it.
    await expectStatus(change([close(assignment(person.w8))]), 200);
    const gap = await row(dev.w8.id);
    assert.deepEqual([gap.state, gap.endReason], ['REVOKED', 'UNASSIGNED']);
    await expectStatus(change([open(C.C2, person.w8)]), 200);
    await expectStatus(me(dev.w8.token), 401, 'DEVICE_ENDED');
    // Scheduled end at E: works before E, fails after E with no request in between.
    dev.o1 = await onboard(person.o1);
    dev.o2 = await onboard(person.o2);
    dev.o3 = await onboard(person.o3);
    const pending3 = await bind(person.o3);
    const E = await dbFuture(4000);
    await expectStatus(
      change([
        close(assignment(person.o1), E),
        close(assignment(person.o2), E),
      ]),
      200,
    );
    // A scheduled transfer added before E moves memberUntil to the end of the new run.
    await expectStatus(change([open(C.C1, person.o2, 'MEMBER', E)]), 200);
    assert.notEqual((await row(dev.o1.id)).memberUntil, null);
    assert.equal((await row(dev.o2.id)).memberUntil, null);
    await expectStatus(me(dev.o1.token), 200);
    await untilDb(E);
    const listed = await expectStatus(
      pget(`/devices?projectId=${projectA}`, pm),
      200,
    );
    const o1 = listed.find((d) => d.id === dev.o1.id);
    assert.deepEqual([o1.state, o1.effectiveState], ['CONFIRMED', 'EXPIRED']);
    await expectStatus(me(dev.o1.token), 401, 'DEVICE_ENDED');
    await expectStatus(me(dev.o2.token), 200);
    const before = (await row(dev.o1.id)).memberUntil.getTime();
    await expectStatus(change([open(C.C5, person.o1)]), 200);
    await expectStatus(me(dev.o1.token), 401, 'DEVICE_ENDED');
    assert.equal((await row(dev.o1.id)).memberUntil.getTime(), before);
    // The elapsed end never moves, even for the owner.
    await assert.rejects(
      owner.query(`UPDATE "FieldDevice" SET "memberUntil"=NULL WHERE id=$1`, [
        dev.o1.id,
      ]),
      /never changes|never moves/,
    );
    // Immediate termination revokes the confirmed device and rejects a pending one at once.
    await expectStatus(change([close(assignment(person.o3))]), 200);
    const t = await row(dev.o3.id);
    assert.deepEqual([t.state, t.endReason], ['REVOKED', 'UNASSIGNED']);
    assert.equal((await row(pending3.body.deviceId)).state, 'REJECTED');
    await expectStatus(me(dev.o3.token), 401, 'DEVICE_ENDED');
    pass(
      'a transfer in one transaction keeps the device; split over two it ends (REVOKED/UNASSIGNED) and a reassignment never revives it; a scheduled end at E works before E and fails after E with no request in between (PM list shows EXPIRED meanwhile), stays failed after a reassignment, and its elapsed memberUntil never moves; a scheduled transfer added before E keeps the device; immediate termination revokes the confirmed and rejects the pending device',
    );
  }

  // ================= other org, unknown token, identical refusals =================
  step('other org, unknown token, identical refusals');
  {
    dev.wb = await onboard(person.wb, {
      code: entryCode[projectB],
      bearer: pmB,
      projectId: projectB,
    });
    const theirs = await expectStatus(me(dev.wb.token), 200);
    assert.equal(theirs.project.id, projectB);
    const unknown = await me(newToken());
    const entra = await http('/api/field/me', { method: 'GET', bearer: pm });
    const malformed = await http('/api/field/me', {
      method: 'GET',
      bearer: 'fd1.short',
    });
    for (const r of [unknown, entra, malformed]) {
      assert.equal(r.status, 401);
      assert.equal(errorShape(r.body), 'FIELD_AUTH_REQUIRED');
    }
    await expectStatus(
      http('/api/report/field/roster?projectId=' + projectA, {
        method: 'GET',
        bearer: dev.w1.token,
      }),
      401,
      'LOGIN_REQUIRED',
    );
    for (const id of [dev.wb.id, randomUUID()]) {
      const r = await pmDevice('revoke', id, 2);
      assert.equal(r.status, 404);
      assert.equal(errorShape(r.body), 'NOT_FOUND');
    }
    await expectStatus(
      pmDevice('revoke', dev.wb.id, 2, pm, projectB),
      403,
      'FORBIDDEN',
    );
    const roster = await expectStatus(
      pget(`/roster?projectId=${projectA}`, pm),
      200,
    );
    assert.ok(!roster.assignments.some((a) => a.personId === person.wb));
    // The lookup policy is SELECT-only: knowing another org's hash never allows a write.
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        "SELECT set_config('app.device_token_hash', $1, true), set_config('app.org_id', $2, true)",
        [sha(dev.wb.token), orgA],
      );
      const seen = await c.query(
        'SELECT id FROM "FieldDevice" WHERE "tokenHash"=$1',
        [sha(dev.wb.token)],
      );
      assert.equal(seen.rowCount, 1);
      const upd = await c.query(
        `UPDATE "FieldDevice" SET "lastSeenAt"=now() WHERE "tokenHash"=$1`,
        [sha(dev.wb.token)],
      );
      assert.equal(upd.rowCount, 0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    pass(
      "an unknown token, an Entra token and a malformed bearer on a field route get the identical 401; a device token on a PM route is LOGIN_REQUIRED; another org's or a nonexistent device id gets the identical 404; a device of a project the PM does not manage is FORBIDDEN; the SELECT-only lookup policy never lets a known hash write",
    );
  }

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
    // Entry: 300 / 10 min per IP; 600 / 10 min per code (a refused request counts too). A
    // fresh code makes the per-code bucket hold only this scenario's requests.
    entryCode[projectA2] = (
      await expectStatus(rotateEntry(projectA2, pm2), 200)
    ).code;
    secret.entry.push(entryCode[projectA2]);
    await freshWindow(600);
    let r = await burst(300, () =>
      fpost('/entry', null, { code: entryCode[projectA2] }, { ip: '10.2.0.1' }),
    );
    assert.ok(r.every((x) => x.status === 200));
    await expectStatus(
      fpost('/entry', null, { code: entryCode[projectA2] }, { ip: '10.2.0.1' }),
      429,
      'RATE_LIMITED',
    );
    // The code has counted 301 (the 429 counts too): 299 more reach 600.
    r = await burst(299, () =>
      fpost('/entry', null, { code: entryCode[projectA2] }, { ip: '10.2.0.2' }),
    );
    assert.ok(r.every((x) => x.status === 200));
    await expectStatus(
      fpost('/entry', null, { code: entryCode[projectA2] }, { ip: '10.2.0.3' }),
      429,
      'RATE_LIMITED',
    );
    await expectStatus(
      fpost('/entry', null, { code: entryCode[projectA] }, { ip: '10.2.0.3' }),
      200,
    );
    // Bind: 150 / h per IP; 300 / h per code (refused binds count too).
    await freshWindow(3600);
    r = await burst(150, () =>
      bind(person.unrostered, { code: entryCode[projectA2], ip: '10.3.0.1' }),
    );
    assert.ok(
      r.every((x) => x.status === 404),
      JSON.stringify([...new Set(r.map((x) => `${x.status}:${x.body.code}`))]),
    );
    await expectStatus(
      bind(person.unrostered, { code: entryCode[projectA2], ip: '10.3.0.1' }),
      429,
      'RATE_LIMITED',
    );
    r = await burst(149, () =>
      bind(person.unrostered, { code: entryCode[projectA2], ip: '10.3.0.2' }),
    );
    assert.ok(r.every((x) => x.status === 404));
    await expectStatus(
      bind(person.unrostered, { code: entryCode[projectA2], ip: '10.3.0.3' }),
      429,
      'RATE_LIMITED',
    );
    // Challenge: 10 / h per device.
    const p = await bind(person.w5, { ip: '10.3.0.9' });
    if (p.status === 409) {
      // w5 may still hold three pending devices; free one.
      const pend = (
        await owner.query(
          `SELECT id FROM "FieldDevice" WHERE "personId"=$1 AND state='PENDING' LIMIT 1`,
          [person.w5],
        )
      ).rows[0].id;
      await expectStatus(pmDevice('reject', pend, 1), 200);
    }
    const pd = p.status === 200 ? p : await bind(person.w5, { ip: '10.3.0.9' });
    for (let i = 0; i < 10; i++) await challenge(pd.token);
    await expectStatus(
      fpost('/device/challenge', pd.token, {}),
      429,
      'RATE_LIMITED',
    );
    // Unknown tokens: 60 / 10 min per IP, then even a valid token from that IP is refused.
    r = await burst(60, () => me(newToken(), { ip: '10.4.0.1' }));
    assert.ok(r.every((x) => x.status === 401));
    await expectStatus(
      me(dev.f1.token, { ip: '10.4.0.1' }),
      429,
      'RATE_LIMITED',
    );
    await expectStatus(me(dev.f1.token, { ip: '10.4.0.2' }), 200);
    // Failed confirms: 30 / h per confirmer, then even the right code is refused.
    dev.fx = await onboard(person.fx);
    const wxd = await bind(person.wx);
    const cwx = await challenge(wxd.token);
    for (let i = 0; i < 30; i++)
      await expectStatus(
        fConfirm(
          dev.fx.token,
          person.wx,
          cwx === '999999' ? '999998' : '999999',
        ),
        409,
        'CHALLENGE_INVALID',
      );
    await expectStatus(
      fConfirm(dev.fx.token, person.wx, cwx),
      429,
      'RATE_LIMITED',
    );
    // A whole crew behind one NAT onboards without a 429.
    const nat = '10.5.0.1';
    for (let i = 4; i <= 40; i++) {
      await expectStatus(
        fpost('/entry', null, { code: entryCode[projectA] }, { ip: nat }),
        200,
      );
      await onboard(person[`o${i}`], { ip: nat });
      await expectStatus(me(dev.f1.token, { ip: nat }), 200);
    }
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
    // The same for binds: guessed codes never create bind-code buckets.
    const bindRowsBefore = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    const bindGuesses = await burst(200, () =>
      fpost(
        '/bind',
        null,
        {
          code: randomBytes(16).toString('base64url'),
          personId: person.w1,
          token: newToken(),
        },
        { ip: '10.6.0.2' },
      ),
    );
    assert.ok(bindGuesses.every((x) => x.status === 404 || x.status === 429));
    const bindRowsAfter = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    assert.ok(
      bindRowsAfter - bindRowsBefore <= 2,
      `${bindRowsAfter - bindRowsBefore} new throttle rows from guessed bind codes`,
    );
    const buckets = await owner.query(`SELECT bucket FROM "FieldThrottle"`);
    for (const { bucket } of buckets.rows)
      assert.match(bucket, /^[a-z-]+:([0-9a-f]{64}|[0-9a-f-]{36})$/);
    pass(
      'throttles: entry 300/10 min per IP and 600/10 min per code, bind 150/h per IP and 300/h per code (refused requests count), challenge 10/h per device, 60 unknown tokens/10 min per IP (then a valid token from that IP too), 30 failed confirms/h per confirmer (then the right code too) → 429; 37 people behind one NAT onboard without a 429; 2000 distinct invalid entry codes (and 200 invalid bind codes) from one IP add at most 2 throttle rows each, never a bucket per guessed code; buckets hold only salted hashes or ids',
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
      // Closing twice or reopening a closed interval, and reviving an ended device, fail.
      await app.query('SAVEPOINT s');
      await assert.rejects(
        app.query(
          `UPDATE "CrewAssignment" SET "validUntil"=now()+interval '1 day' WHERE "validUntil" IS NOT NULL`,
        ),
        /closed, once/,
      );
      await app.query('ROLLBACK TO SAVEPOINT s');
      await app.query('SAVEPOINT s');
      await assert.rejects(
        app.query(`UPDATE "FieldDevice" SET state='CONFIRMED' WHERE id=$1`, [
          dev.w4.id,
        ]),
        /never changes/,
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
        { device: dev.wb.id },
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
        `SELECT count(*)::int AS n FROM "FieldDevice" WHERE "orgId"=$1`,
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
      owner.query(`UPDATE "FieldDevice" SET state='CONFIRMED' WHERE id=$1`, [
        dev.w4.id,
      ]),
      /never changes/,
    );
    await assert.rejects(
      owner.query(`DELETE FROM "FieldDeviceEvent"`),
      /append-only|not allowed|immutable|deny/i,
    );
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
      "the app role cannot update or delete events, token hashes or intervals, nor change a device's identity or a challenge's code; an interval closes once; an ended device never returns to CONFIRMED (not even for the owner); events and intervals are append-only for the owner too; device-event actors must be people and devices of the same org and project, never another tenant's or nonexistent ones; RLS hides and refuses another org; no pooled connection keeps a hash, entry code or org",
    );
  }

  // ================= redaction =================
  step('redaction');
  {
    const hashes = secret.tokens.map(sha);
    const forbiddenEverywhere = [...secret.tokens, ...hashes];
    for (const { path, status, text } of responses) {
      for (const s of forbiddenEverywhere)
        assert.ok(!text.includes(s), `${path} carried a token or hash`);
      if (status >= 400) {
        const body = JSON.parse(text);
        assert.deepEqual(
          Object.keys(body).sort(),
          ['code', 'correlationId'],
          path,
        );
        for (const s of [...secret.entry, ...secret.codes, ...names])
          assert.ok(
            !text.includes(s),
            `${path} error carried a secret or name`,
          );
        continue;
      }
      const mayCarryCode = path === '/api/field/device/challenge';
      const mayCarryEntry = path === '/api/report/field/entry-code/rotate';
      if (!mayCarryCode)
        for (const c of secret.codes)
          assert.ok(
            !text.includes(`"${c}"`),
            `${path} carried a challenge code`,
          );
      if (!mayCarryEntry)
        for (const e of secret.entry)
          assert.ok(!text.includes(e), `${path} carried an entry code`);
    }
    const stored = await owner.query(
      `SELECT string_agg(t, ' ') AS all FROM (
        SELECT concat_ws(' ', before::text, after::text, reason) AS t FROM "AuditLog"
        UNION ALL SELECT to_jsonb(e)::text FROM "FieldDeviceEvent" e
        UNION ALL SELECT concat_ws(' ', "responseBody"::text, route) FROM "IdempotencyRecord") x`,
    );
    for (const s of [
      ...forbiddenEverywhere,
      ...secret.entry,
      ...secret.codes.map((c) => `"${c}"`),
      ...names,
    ])
      assert.ok(
        !stored.rows[0].all.includes(s),
        'audit, event or idempotency rows carried a secret or name',
      );
    for (const line of printed)
      for (const s of [...forbiddenEverywhere, ...secret.entry, ...names])
        assert.ok(!line.includes(s), 'process output carried a secret or name');
    pass(
      `redaction: across ${responses.length} responses no token or hash ever appears; every error is exactly {code, correlationId} with no code, entry code or name; challenge codes only in the challenge response and entry codes only in the rotation response; audit, event and idempotency rows and all process output carry none of them`,
    );
  }

  console.log(
    `Field roster/devices/entry HTTP/DB integration: ${checks} checks passed; synthetic TEST data only. Check-in, foreman reports and the field web UI are later slices.`,
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
