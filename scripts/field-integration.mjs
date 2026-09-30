// Field roster, devices and entry (A6a), worker check-in and staged selfie (A6b), foreman
// quantity reports and PM adoption (A6c) HTTP + database integration test. Synthetic TEST data
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
  advanceClock,
  ReportStore,
  clearPreviousHash,
  recordActivity,
  CheckInStore,
  ForemanStore,
  readFileClaims,
} from '../packages/domain/dist/index.js';
import { exifTiff, testJpeg } from '../packages/testing/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { AzurePhotoBlobStore } from '../apps/api/dist/photo-blobs.js';
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
const WATCHDOG_MS = Number(process.env.FIELD_TEST_WATCHDOG_MS ?? 600_000);
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
  workersA.push('a2only', 'unrostered', 'r1', 'r2', 'p1', 'c1', 'c2', 'c3');
  // A6b check-in and selfie people.
  workersA.push(
    'kf',
    'kf2',
    'kx',
    'kt',
    'kl',
    'km',
    'kd',
    'kr',
    'kc1',
    'kc2',
    'kp',
  );
  for (let i = 1; i <= 8; i++) workersA.push(`k${i}`);
  for (let i = 1; i <= 5; i++) workersA.push(`s${i}`);
  for (const k of workersA) await addPerson(k, orgA);
  for (const k of ['pmB', 'wb', 'wb2']) await addPerson(k, orgB);
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
  // TEST seam: when armed, the COMMIT of a transaction that inserted a selfie row runs, and then
  // the client reports an error, as if the acknowledgement was lost on the way back.
  let commitFault = false;
  const realConnect = appPool.connect.bind(appPool);
  appPool.connect = async (...args) => {
    if (typeof args[0] === 'function') return realConnect(...args);
    const client = await realConnect();
    if (!client.gated) {
      client.gated = true;
      const query = client.query.bind(client);
      client.query = async (...q) => {
        const text = typeof q[0] === 'string' ? q[0] : (q[0]?.text ?? '');
        if (text.includes('INSERT INTO "FieldSelfie"'))
          client.selfieInsert = true;
        const result = await query(...q);
        if (text === 'COMMIT' || text === 'ROLLBACK') {
          const lose = commitFault && text === 'COMMIT' && client.selfieInsert;
          client.selfieInsert = false;
          if (lose) {
            commitFault = false;
            throw new Error('TEST lost COMMIT acknowledgement');
          }
        }
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
  // TEST selfie blob store in memory; deletes can be made to fail. The Azure implementation's
  // delete is checked against Azurite at the end of the A6b steps when it is configured.
  const selfieBlobs = {
    map: new Map(),
    failDeletes: false,
    async put(key, bytes, contentType) {
      const prior = this.map.get(key);
      if (prior && !prior.bytes.equals(Buffer.from(bytes)))
        throw new Error('TEST blob key holds other bytes');
      this.map.set(key, { bytes: Buffer.from(bytes), contentType });
    },
    async get(key) {
      return this.map.get(key) ?? null;
    },
    async delete(key) {
      if (this.failDeletes) throw new Error('TEST blob delete failure');
      this.map.delete(key);
    },
  };
  const checkInStore = new CheckInStore(appPool, selfieBlobs, fieldOptions);
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    fieldStore,
    checkInStore,
    foremanStore: new ForemanStore(appPool, fieldOptions),
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
  /**
   * The client contract for 503 RETRY (design §5, §6): repeat the same request, with the same
   * key. The TEST VM's database clock can step back between two requests; the fail-closed
   * clock policy answers RETRY until it catches up. Bounded, counted and reported at the end;
   * switched off where a test expects the 503.
   */
  const retry = { on: true, force: false, repeated: 0 };
  // Ordering and deadline tests assert their first attempt: no automatic repetition there.
  const FIRST_ATTEMPT = new Set([
    'roster',
    'foreman handover at a scheduled instant',
    'rotation',
    'revoke vs rotate; release',
    'idle deadline',
    'transfer, termination, scheduled end',
    'clock regression fails closed',
    'decision time after the locks',
    'roster read is one snapshot',
    'challenge expiry, reuse, wrong version',
    'stale confirmation, revoke before confirm',
    'selfie: attach vs cleanup',
    'check-in: submission boundary under concurrency',
    'foreman: adopt vs roster change',
    'foreman: adopt, revision and roster vs submit',
  ]);
  async function http(path, options) {
    const until = Date.now() + 10_000;
    for (;;) {
      const r = await httpOnce(path, options);
      const repeat =
        retry.force || (retry.on && !FIRST_ATTEMPT.has(currentStep));
      if (!repeat || r.status !== 503 || r.body?.code !== 'RETRY') return r;
      if (Date.now() > until) return r;
      retry.repeated++;
      await sleep(200);
    }
  }
  async function httpOnce(
    path,
    { method, bearer, body, key, ip = DEFAULT_IP },
  ) {
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
  /** Every device of the project as the PM list returns it, following the cursor. */
  async function allDevices(bearer = pm, projectId = projectA) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const body = await expectStatus(
        pget(
          `/devices?projectId=${projectId}${cursor ? `&cursor=${cursor}` : ''}`,
          bearer,
        ),
        200,
      );
      if (Array.isArray(body)) return body; // an unpaged list
      out.push(...body.devices);
      if (!body.nextCursor) return out;
      cursor = body.nextCursor;
    }
    throw new Error('device list did not end');
  }
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
    change([
      ...Array.from({ length: 40 }, (_, i) => open(C.C5, person[`o${i + 1}`])),
      ...['r1', 'r2', 'p1', 'c1', 'c2', 'c3'].map((k) => open(C.C5, person[k])),
    ]),
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
    // waits on the person lock, then sees the first and fails (23P01). The raw intervals start a
    // second ahead: the database clock is not monotonic across transactions (the TEST VM's clock
    // can step back), and "now" right after the close above must not reach back into it.
    // Both clients go through the lock registry, so a failure here can never leave one held.
    const t1 = await withTimeout(owner.connect(), 5_000, 'owner connect');
    const releaseT1 = registerHeld(t1, 'ROLLBACK', []);
    const t2 = await withTimeout(owner.connect(), 5_000, 'owner connect');
    const releaseT2 = registerHeld(t2, 'ROLLBACK', []);
    try {
      const insert = (c, crewId) =>
        c.query(
          `INSERT INTO "CrewAssignment"(id,"orgId","projectId","crewId","personId",role,"validFrom","createdBy")
          VALUES($1,$2,$3,$4,$5,'MEMBER',now() + interval '1 second',$6)`,
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
        `UPDATE "CrewAssignment" SET "validUntil"="validFrom", "closedBy"=$2 WHERE "personId"=$1 AND "validUntil" IS NULL`,
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
    const list = await allDevices();
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
    // A confirmation by the old foreman that starts before E and waits on the subject's person
    // lock until after E is authorized at its decision time: no longer foreman.
    const releaseW4 = await holdAdvisory(personKey(person.w4));
    const acrossE = fConfirm(dev.f1.token, person.w4, '123456');
    await advisoryWaiters(personKey(person.w4), 1);
    await untilDb(E);
    await sleep(200);
    await releaseW4();
    await expectStatus(acrossE, 403, 'NOT_FOREMAN');
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
      "a scheduled foreman handover at E: before E the old foreman has authority and the new one NOT_FOREMAN, after E the reverse, with no request in between; a confirmation that started before E and waited on a lock past E is refused NOT_FOREMAN (authorized at its decision time); the old foreman's device stays valid",
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
    // Both orders forced: the requests queue on the person lock in the order they arrive, and
    // Postgres grants a lock's waiters in queue order.
    const lineUp = async (personId, first, second) => {
      const release = await holdAdvisory(personKey(personId));
      const a = first();
      await advisoryWaiters(personKey(personId), 1);
      const b = second();
      await advisoryWaiters(personKey(personId), 2);
      await release();
      return Promise.all([a, b]);
    };
    // Rotate first: the rotation lands, then the revoke ends the rotated device.
    dev.w4 = await onboard(person.w4, { foreman: dev.f4.token });
    const N = newToken();
    const [rotated, revoked] = await lineUp(
      person.w4,
      () => rotate(dev.w4.token, N, 1),
      () => pmDevice('revoke', dev.w4.id, 2),
    );
    assert.deepEqual([rotated.status, rotated.body], [200, { generation: 2 }]);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    await expectStatus(me(dev.w4.token), 401, 'FIELD_AUTH_REQUIRED');
    await expectStatus(me(N), 401, 'DEVICE_ENDED');
    await expectStatus(rotate(dev.w4.token, N, 1), 401, 'DEVICE_ENDED');
    assert.deepEqual(
      [(await row(dev.w4.id)).state, (await row(dev.w4.id)).generation],
      ['REVOKED', 2],
    );
    // Revoke first: the rotation then sees REVOKED; its new token was never accepted.
    dev.r1 = await onboard(person.r1);
    const N2 = newToken();
    const [revokedFirst, rotatedAfter] = await lineUp(
      person.r1,
      () => pmDevice('revoke', dev.r1.id, 2),
      () => rotate(dev.r1.token, N2, 1),
    );
    assert.equal(revokedFirst.status, 200, JSON.stringify(revokedFirst.body));
    assert.deepEqual(
      [rotatedAfter.status, rotatedAfter.body.code],
      [401, 'DEVICE_ENDED'],
    );
    await expectStatus(me(dev.r1.token), 401, 'DEVICE_ENDED');
    await expectStatus(me(N2), 401, 'FIELD_AUTH_REQUIRED');
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "FieldTokenHash" WHERE hash=$1`,
        [sha(N2)],
      ),
      0,
    );
    assert.deepEqual(
      [(await row(dev.r1.id)).state, (await row(dev.r1.id)).generation],
      ['REVOKED', 1],
    );
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
      `revoke vs rotate in both forced orders on the person lock: rotate first → 200 (generation 2), then the revoke ends it (old token FIELD_AUTH_REQUIRED, new one DEVICE_ENDED); revoke first → the rotation gets DEVICE_ENDED and its new token was never accepted (not registered, FIELD_AUTH_REQUIRED); release ends the own device (REVOKED/RELEASED) and a replay re-authenticates (DEVICE_ENDED); a key that differs from clientMutationId is INVALID_INPUT`,
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
    // Both queue FOR UPDATE on the row and are released before the deadline, so both decide
    // before it (the decision time is taken after the lock); the first records its activity.
    let unlock = await holdRow(dev.w2.id);
    const A = me(dev.w2.token);
    await rowWaiters(1);
    const B = me(dev.w2.token);
    await rowWaiters(2);
    await unlock();
    const [ra, rb] = await Promise.all([A, B]);
    assert.deepEqual([ra.status, rb.status], [200, 200]);
    // After the original deadline the device is still live: A's activity moved it.
    await sleep(3000);
    await expectStatus(me(dev.w2.token), 200);
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
      'idle deadline: requests that decide just before the deadline serialize FOR UPDATE and the first records activity, so a request after the original deadline is still served; B first → EXPIRED(IDLE) committed, then A sees it (never revived); a FOR SHARE request whose wall clock crossed into the last day while it waited reclassifies and records its activity; the deferred update refuses an older authAt, a terminal row and a row within a day of its deadline',
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
    const listed = await allDevices();
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
    // Pending devices whose membership ended do not hold bind slots: three pending binds, a
    // scheduled end at E, a reassignment after E, and a new bind, with no request by the old
    // devices in between (they are still stored PENDING).
    const olds = [];
    for (let k = 0; k < 3; k++) olds.push(await bind(person.p1));
    assert.ok(olds.every((b) => b.status === 200));
    await expectStatus(bind(person.p1), 409, 'TOO_MANY_PENDING');
    const Ep = await dbFuture(4000);
    await expectStatus(change([close(assignment(person.p1), Ep)]), 200);
    await untilDb(Ep);
    await expectStatus(change([open(C.C5, person.p1)]), 200);
    // The reassignment is a roster write touching p1: it persists the elapsed ends it sees.
    for (const b of olds) {
      const old = await row(b.body.deviceId);
      assert.deepEqual([old.state, old.endReason], ['EXPIRED', 'UNASSIGNED']);
    }
    dev.p1 = await onboard(person.p1);
    await expectStatus(me(dev.p1.token), 200);
    pass(
      'pending devices whose membership ended are persisted EXPIRED(UNASSIGNED) by the reassigning roster write (no request by them) and do not block a new bind; a transfer in one transaction keeps the device; split over two it ends (REVOKED/UNASSIGNED) and a reassignment never revives it; a scheduled end at E works before E and fails after E with no request in between (PM list shows EXPIRED meanwhile), stays failed after a reassignment, and its elapsed memberUntil never moves; a scheduled transfer added before E keeps the device; immediate termination revokes the confirmed and rejects the pending device',
    );
  }

  // ================= clock regression fails closed =================
  step('clock regression fails closed');
  {
    // A confirmed device whose membership ends at E, 30 minutes ahead. Then the database clock
    // steps back an hour behind time already observed in the project (simulated: the project's
    // high-water mark is set an hour ahead). In that world E has passed.
    dev.c1 = await onboard(person.c1);
    const E = await dbFuture(30 * 60_000);
    await expectStatus(change([close(assignment(person.c1), E)]), 200);
    assert.equal((await row(dev.c1.id)).memberUntil.toISOString(), E);
    const mark = async () =>
      (
        await owner.query(
          `SELECT "clockHighWater" AS m FROM "ProjectRoster" WHERE "projectId"=$1`,
          [projectA],
        )
      ).rows[0].m;
    // Field requests advance the mark (at most once a second), never past the clock.
    await expectStatus(me(dev.c1.token), 200);
    const observed = await mark();
    assert.ok(observed && Date.now() - observed.getTime() < 60_000);
    await travel(
      `UPDATE "ProjectRoster" SET "clockHighWater" = now() + interval '1 hour' WHERE "projectId"=$1`,
      [projectA],
    );
    let reset;
    try {
      // Authentication does not treat the device as live again: fail closed.
      await expectStatus(me(dev.c1.token), 503, 'RETRY');
      // A roster change cannot extend the membership end judged by the stepped-back clock.
      await expectStatus(
        change([open(C.C5, person.c1, 'MEMBER', E)]),
        503,
        'RETRY',
      );
      const after = await row(dev.c1.id);
      assert.deepEqual(
        [after.state, after.memberUntil.toISOString()],
        ['CONFIRMED', E],
      );
      // Bind and PM confirm judge deadlines too.
      await expectStatus(bind(person.w5), 503, 'RETRY');
      await expectStatus(pmConfirm(person.w5, '123456'), 503, 'RETRY');
    } finally {
      // Recovery (design §5 runbook): the migration identity resets the mark to the clock.
      // Devices whose deadline is at or before the old mark are persisted EXPIRED first.
      reset = await owner.query(
        'SELECT * FROM field_reset_clock_mark($1, $2)',
        [projectA, 'TEST forward clock spike recovery'],
      );
    }
    assert.ok(reset.rows[0].expiredDevices >= 1);
    assert.ok(reset.rows[0].newMark < reset.rows[0].oldMark);
    // The device whose membership end the old mark had passed stays ended; others proceed.
    await expectStatus(me(dev.c1.token), 401, 'DEVICE_ENDED');
    const c1 = await row(dev.c1.id);
    assert.deepEqual([c1.state, c1.endReason], ['EXPIRED', 'UNASSIGNED']);
    await expectStatus(me(dev.f1.token), 200);
    const audit = await owner.query(
      `SELECT reason, before->>'clockHighWater' AS old, after->>'actor' AS actor, "actorKind"
      FROM "AuditLog" WHERE action='FIELD_CLOCK_RESET'`,
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].reason, 'TEST forward clock spike recovery');
    assert.ok(audit.rows[0].old && audit.rows[0].actor);
    // Only the migration identity may reset, with a reason, and only a mark ahead of the clock.
    await assert.rejects(
      appPool.query('SELECT * FROM field_reset_clock_mark($1, $2)', [
        projectA,
        'TEST not allowed for the app role',
      ]),
      (e) => e.code === '42501',
    );
    await assert.rejects(
      owner.query('SELECT * FROM field_reset_clock_mark($1, $2)', [
        projectA,
        'x',
      ]),
      /reason/,
    );
    await assert.rejects(
      owner.query('SELECT * FROM field_reset_clock_mark($1, $2)', [
        projectA,
        'TEST nothing to reset now',
      ]),
      /not ahead of the clock/,
    );
    // Deferred housekeeping never publishes a time ahead of the clock.
    const before = await mark();
    await advanceClock(appPool, orgA, projectA, await dbFuture(3_600_000));
    assert.equal((await mark()).getTime(), before.getTime());
    // The one explicit retry test: a short spike answers RETRY, and repeating the same
    // request succeeds once the clock passes the mark.
    await owner.query(
      `UPDATE "ProjectRoster" SET "clockHighWater" = clock_timestamp() + interval '1500 milliseconds' WHERE "projectId"=$1`,
      [projectA],
    );
    const repeatedBefore = retry.repeated;
    retry.force = true;
    try {
      await expectStatus(me(dev.f1.token), 200);
    } finally {
      retry.force = false;
    }
    assert.ok(retry.repeated > repeatedBefore, 'the first attempt was RETRY');
    // The mark never moves back, even for the owner.
    await assert.rejects(
      owner.query(
        `UPDATE "ProjectRoster" SET "clockHighWater" = "clockHighWater" - interval '1 second' WHERE "projectId"=$1`,
        [projectA],
      ),
      /never moves back/,
    );
    pass(
      'clock regression fails closed: with the database clock an hour behind time already observed in the project, a device whose membership ended in between is not authenticated (503 RETRY), a roster change cannot extend that elapsed membership end (503, nothing written), bind and PM confirm refuse too; the audited owner-only reset lowers the mark to the clock after persisting EXPIRED for devices whose deadline the old mark had passed (that device stays ended, others proceed; the app role cannot reset; a reason is required); deferred housekeeping never publishes a future time; a short spike answers RETRY and the repeated request succeeds; field requests advance the mark, which never moves back',
    );
  }

  // ================= decision time after the locks =================
  step('decision time after the locks');
  {
    // Membership ends at D (3 s ahead). A request starts before D, waits on a lock until the
    // clock is past D, and meanwhile the project's mark records time past D (as a committed
    // request would). It must decide at its decision time, taken after the lock, not at its
    // start time (design §5).
    dev.c2 = await onboard(person.c2);
    dev.c3 = await onboard(person.c3);
    const D = await dbFuture(3000);
    await expectStatus(change([close(assignment(person.c2), D)]), 200);
    const markPast = (deadline) =>
      owner.query(
        `UPDATE "ProjectRoster" SET "clockHighWater" = GREATEST("clockHighWater", $2::timestamptz + interval '100 milliseconds') WHERE "projectId"=$1`,
        [projectA, deadline],
      );
    // Authentication: waits on the device row.
    let unlock = await holdRow(dev.c2.id);
    const waiting = me(dev.c2.token);
    await rowWaiters(1);
    await untilDb(D);
    await sleep(300);
    await markPast(D);
    await unlock();
    await expectStatus(waiting, 401, 'DEVICE_ENDED');
    const c2 = await row(dev.c2.id);
    assert.deepEqual([c2.state, c2.endReason], ['EXPIRED', 'UNASSIGNED']);
    // Roster: a continuation at D2, started before D2, that waits on the person lock past D2
    // cannot extend the elapsed end.
    const D2 = await dbFuture(3000);
    await expectStatus(change([close(assignment(person.c3), D2)]), 200);
    unlock = await holdAdvisory(personKey(person.c3));
    const continuing = change([open(C.C1, person.c3, 'MEMBER', D2)]);
    await advisoryWaiters(personKey(person.c3), 1);
    await untilDb(D2);
    await sleep(300);
    await markPast(D2);
    await unlock();
    await expectStatus(continuing, 200);
    const c3 = await row(dev.c3.id);
    assert.deepEqual(
      [c3.state, c3.endReason, c3.memberUntil.toISOString()],
      ['EXPIRED', 'UNASSIGNED', D2],
    );
    pass(
      'decision time after the locks: a request that started before a membership end D and waited on a lock past D (with the mark past D) is refused and the device persisted EXPIRED; a roster continuation at a later end D2 that waited on the person lock past D2 is applied but cannot extend the elapsed end (the device is persisted EXPIRED, memberUntil stays D)',
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
    // A real device of the same org in another project (for the event-actor FK checks).
    dev.a2 = await onboard(person.a2only, {
      code: entryCode[projectA2],
      bearer: pm2,
      projectId: projectA2,
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
    // Bogus device tokens on the challenge route, far beyond the unknown-token limit of their
    // IP: the IP gate refuses them first and no challenge bucket is made for a non-device.
    const tokenRowsBefore = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    const bogus = await burst(600, () =>
      fpost('/device/challenge', newToken(), {}, { ip: '10.6.0.3' }),
    );
    assert.ok(bogus.every((x) => x.status === 401 || x.status === 429));
    assert.ok(bogus.filter((x) => x.status === 429).length >= 500);
    const tokenRowsAfter = await count(
      `SELECT count(*)::int AS n FROM "FieldThrottle"`,
    );
    assert.ok(
      tokenRowsAfter - tokenRowsBefore <= 2,
      `${tokenRowsAfter - tokenRowsBefore} new throttle rows from bogus challenge tokens`,
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
      'throttles: entry 300/10 min per IP and 600/10 min per code, bind 150/h per IP and 300/h per code (refused requests count), challenge 10/h per device, 60 unknown tokens/10 min per IP (then a valid token from that IP too), 30 failed confirms/h per confirmer (then the right code too) → 429; 37 people behind one NAT onboard without a 429; 2000 distinct invalid entry codes, 200 invalid bind codes and 600 bogus challenge tokens from one IP add at most 2 throttle rows each, never a bucket per guess; buckets hold only salted hashes or ids',
    );
  }

  // ================= PM device list reaches every device =================
  step('PM device list reaches every device');
  {
    // 501 newer historical rows (synthetic TEST rows, ended) put an older confirmed device
    // beyond the first 500 rows of the list.
    await owner.query(
      `INSERT INTO "FieldDevice"(id,"orgId","projectId","personId",state,"tokenHash","pendingUntil","expiresAt","lastSeenAt","endedAt","endReason")
      SELECT gen_random_uuid(), $1, $2, $3, 'REJECTED', encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'),
        now(), now() + interval '1 day', now(), now(), 'REJECTED'
      FROM generate_series(1, 501)`,
      [orgA, projectA, person.w5],
    );
    const firstPage = await expectStatus(
      pget(`/devices?projectId=${projectA}&limit=500`, pm),
      200,
    );
    const firstRows = Array.isArray(firstPage) ? firstPage : firstPage.devices;
    assert.ok(firstRows.length <= 500);
    assert.ok(
      !firstRows.some((d) => d.id === dev.f3.id),
      'expected behind 500 rows',
    );
    const everything = await allDevices();
    const target = everything.find((d) => d.id === dev.f3.id);
    assert.ok(
      target,
      'an older confirmed device is reachable through the list',
    );
    assert.equal(target.state, 'CONFIRMED');
    assert.equal(new Set(everything.map((d) => d.id)).size, everything.length);
    assert.equal(
      everything.length,
      await count(
        `SELECT count(*)::int AS n FROM "FieldDevice" WHERE "projectId"=$1`,
        [projectA],
      ),
    );
    await expectStatus(pmDevice('revoke', target.id, target.version), 200);
    await expectStatus(me(dev.f3.token), 401, 'DEVICE_ENDED');
    await expectStatus(
      pget(`/devices?projectId=${projectA}&cursor=not-a-cursor`, pm),
      400,
      'INVALID_INPUT',
    );
    // A well-formed cursor with an impossible date is a 400 too, never a database error.
    const impossible = Buffer.from(
      `2026-02-30T01:02:03.123456Z|${target.id}`,
    ).toString('base64url');
    await expectStatus(
      pget(`/devices?projectId=${projectA}&cursor=${impossible}`, pm),
      400,
      'INVALID_INPUT',
    );
    pass(
      `the PM device list pages with a cursor (at most 500 per page, newest first): an older confirmed device behind 501 newer rows is not on the first page, is found by following the cursor (${everything.length} devices, each exactly once, all of the project) and is revoked; a malformed cursor, or one with an impossible date, is INVALID_INPUT`,
    );
  }

  // ================= history, grants, RLS, pooled context =================
  step('history, grants, RLS, pooled context');
  {
    // A device whose membership end has passed but which is still stored CONFIRMED.
    dev.r2 = await onboard(person.r2);
    await travel(
      `UPDATE "FieldDevice" SET "memberUntil" = now() - interval '1 minute' WHERE id=$1`,
      [dev.r2.id],
    );
    // Name resolution: temporary tables cannot shadow the catalogs the mark's trigger reads.
    const marks = async () =>
      (
        await owner.query(
          `SELECT "clockHighWater" AS m, (SELECT count(*)::int FROM "AuditLog" WHERE action='FIELD_CLOCK_RESET') AS n
          FROM "ProjectRoster" WHERE "projectId"=$1`,
          [projectA],
        )
      ).rows[0];
    const beforeShadow = await marks();
    const shadow = await appPool.connect();
    try {
      await shadow.query('CREATE TEMP TABLE pg_roles (oid oid, rolname name)');
      await shadow.query(
        'CREATE TEMP TABLE pg_auth_members (roleid oid, member oid)',
      );
      await shadow.query('BEGIN');
      await shadow.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.clock_reset', 'on', true)",
        [orgA],
      );
      await shadow.query('SAVEPOINT s');
      await assert.rejects(
        shadow.query(
          `UPDATE public."ProjectRoster" SET "clockHighWater" = "clockHighWater" - interval '1 second' WHERE "projectId"=$1`,
          [projectA],
        ),
        /never moves back/,
      );
      await shadow.query('ROLLBACK TO SAVEPOINT s');
      await shadow.query('ROLLBACK');
    } finally {
      shadow.release(true); // discard the session and its temporary tables
    }
    const afterShadow = await marks();
    assert.equal(afterShadow.m.getTime(), beforeShadow.m.getTime());
    assert.equal(afterShadow.n, beforeShadow.n);
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
      // A forged app.decision_time cannot clear an elapsed membership end.
      await app.query('SAVEPOINT s');
      await app.query(
        "SELECT set_config('app.decision_time', '-infinity', true)",
      );
      await assert.rejects(
        app.query(`UPDATE "FieldDevice" SET "memberUntil"=NULL WHERE id=$1`, [
          dev.r2.id,
        ]),
        (e) => e.code === 'MJE01',
      );
      await app.query('ROLLBACK TO SAVEPOINT s');
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
        { case: 'same-org device of another project', device: dev.a2.id },
        { case: "another org's real device", device: dev.wb.id },
        { case: "another org's person", person: person.wb },
        { case: 'nonexistent person', person: randomUUID() },
        { case: 'nonexistent device', device: randomUUID() },
      ]) {
        await app.query('SAVEPOINT s');
        await assert.rejects(
          actorEvent(actor),
          (e) => e.code === '23503',
          `event actor accepted: ${actor.case}`,
        );
        await app.query('ROLLBACK TO SAVEPOINT s');
      }
      // Accepted: a person of the org, and a device of the same project.
      await app.query('SAVEPOINT s');
      await actorEvent({ person: person.w1 });
      await actorEvent({ person: person.f1, device: dev.f1.id });
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
      "the app role cannot update or delete events, token hashes or intervals, nor change a device's identity or a challenge's code; an interval closes once; an ended device never returns to CONFIRMED (not even for the owner); events and intervals are append-only for the owner too; a forged app.decision_time cannot clear an elapsed membership end (MJE01); temporary tables named pg_roles and pg_auth_members cannot make the mark move back (mark and audit unchanged); device-event actors must be people of the org and devices of the same project (another org's real device, a same-org device of another project and nonexistent ones are refused; a same-project device is accepted); RLS hides and refuses another org; no pooled connection keeps a hash, entry code or org",
    );
  }

  // ================= A6b: worker check-in and staged selfie =================
  // Synthetic TEST coordinates around an invented site at -33.900000, -18.400000; every
  // coordinate string sent is collected for the redaction scan at the end.
  const KIP = '10.6.6.6';
  const kpost = (path, token, body) => fpost(path, token, body, { ip: KIP });
  const LON = '-18.400000';
  const coords = ['-33.900000', LON];
  const northOf = (m) => {
    const s = (-33.9 + (m / 6_371_000) * (180 / Math.PI)).toFixed(6);
    coords.push(s);
    return s;
  };
  const clockNow = async () =>
    new Date(
      (await owner.query('SELECT clock_timestamp() AS t')).rows[0].t.getTime(),
    );
  const siteDay = async (d) =>
    (
      await owner.query(
        `SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Belgrade')::date, 'YYYY-MM-DD') AS d`,
        [d.toISOString()],
      )
    ).rows[0].d;
  const shiftDay = (date, n) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const MIN = 60_000,
    HOUR = 60 * MIN;
  /** A check-in body from the database clock: occurredAt = now + at, deviceSentAt = now + sent. */
  async function tapBody(o = {}) {
    const t = o.now ?? (await clockNow());
    const occurredAt = new Date(t.getTime() + (o.at ?? -5_000));
    const body = {
      clientMutationId: o.key ?? randomUUID(),
      businessDate: o.date ?? (await siteDay(occurredAt)),
      occurredAt: occurredAt.toISOString(),
      fix: {
        lat: northOf(o.m ?? 200),
        lon: LON,
        accuracyM: o.acc ?? '10',
        fixAt: new Date(
          occurredAt.getTime() - (o.fixLag ?? 10_000),
        ).toISOString(),
      },
      deviceSentAt: new Date(t.getTime() + (o.sent ?? 0)).toISOString(),
    };
    if (o.personId) body.personId = o.personId;
    else body.stagedSelfieId = o.selfie ?? null;
    return body;
  }
  const tap = async (token, o = {}) => {
    const body = await tapBody(o);
    const r = await kpost(
      o.personId ? '/checkin/proxy' : '/checkin',
      token,
      body,
    );
    return { body, r };
  };
  const checkInRow = async (id) =>
    (
      await owner.query(
        `SELECT c.*, c."businessDate"::text AS day, c.lat::text AS lat_t, c."actorLat"::text AS "actorLat_t" FROM "WorkerCheckIn" c WHERE id=$1`,
        [id],
      )
    ).rows[0];
  const refusals = async (deviceId) =>
    (
      await owner.query(
        `SELECT "reasonCode", "distanceBucketM", "personId", to_jsonb(e)::text AS j FROM "FieldDeviceEvent" e
        WHERE "deviceId"=$1 AND kind='CHECKIN_REFUSED' ORDER BY seq`,
        [deviceId],
      )
    ).rows;
  const K = {};
  const kPeople = [
    'kf',
    'k1',
    'k2',
    'k3',
    'k4',
    'k5',
    'k6',
    'k7',
    'k8',
    'kt',
    'kl',
    'km',
    'kc1',
    'kc2',
    'kp',
    'kd',
    'kr',
    's1',
    's2',
    's3',
    's4',
    's5',
  ];

  step('check-in: site reference, geofence, accuracy, duplicates');
  {
    K.K1 = await crew(projectA, 'K1');
    K.K2 = await crew(projectA, 'K2');
    await expectStatus(
      change([
        open(K.K1, person.kf, 'FOREMAN'),
        open(K.K2, person.kf2, 'FOREMAN'),
        ...kPeople.map((k) => open(K.K1, person[k])),
        open(K.K2, person.kf2),
        open(K.K2, person.kx),
      ]),
      200,
    );
    // Membership cannot be backdated through the API; the TEST database moves these intervals
    // back (10 days; kx only 2) so that past taps and day proxies have history to be judged by.
    await travel(
      `UPDATE "CrewAssignment" SET "validFrom" = "validFrom" - interval '10 days' WHERE "personId" = ANY($1::uuid[])`,
      [[...kPeople, 'kf2'].map((k) => person[k])],
    );
    await travel(
      `UPDATE "CrewAssignment" SET "validFrom" = "validFrom" - interval '2 days' WHERE "personId" = $1`,
      [person.kx],
    );
    for (const k of [...kPeople.filter((k) => k !== 'kp'), 'kf2', 'kx'])
      dev[k] = await onboard(person[k], { ip: KIP });
    const pending = await bind(person.kp, { ip: KIP });
    assert.equal(pending.status, 200);
    dev.kp = { token: pending.token, id: pending.body.deviceId };

    // No reference yet: refused and logged, never treated as distance 0.
    let x = await tap(dev.k1.token);
    await expectStatus(Promise.resolve(x.r), 409, 'SITE_NOT_CONFIGURED');
    const ref = (over = {}) => ({
      projectId: projectA,
      clientMutationId: randomUUID(),
      expectedN: 0,
      lat: '-33.900000',
      lon: LON,
      radiusM: 500,
      ...over,
    });
    assert.deepEqual(
      await expectStatus(ppost('/site-reference', pm, ref()), 200),
      { n: 1 },
    );
    await expectStatus(
      ppost('/site-reference', pm, ref()),
      409,
      'VERSION_CONFLICT',
    );
    await expectStatus(
      ppost('/site-reference', exec, ref({ expectedN: 1 })),
      403,
      'READ_ONLY',
    );
    await expectStatus(
      ppost('/site-reference', pmB, ref({ expectedN: 1 })),
      403,
      'FORBIDDEN',
    );
    const settings = await expectStatus(
      pget(`/settings?projectId=${projectA}`, pm),
      200,
    );
    assert.deepEqual(settings.settings, {
      n: 0,
      selfieEnabled: false,
      pmProxyDays: 7,
    });
    assert.equal(settings.siteReference.radiusM, 500);
    await expectStatus(
      pget(`/settings?projectId=${projectA}`, exec),
      403,
      'READ_ONLY',
    );
    // Outside by 1 m, then coarse accuracy inside: both refused and logged in 100 m buckets.
    x = await tap(dev.k1.token, { m: 501 });
    await expectStatus(Promise.resolve(x.r), 409, 'GEOFENCE_OUTSIDE');
    x = await tap(dev.k1.token, { m: 250, acc: '100.01' });
    await expectStatus(Promise.resolve(x.r), 409, 'LOCATION_TOO_COARSE');
    const ev = await refusals(dev.k1.id);
    assert.deepEqual(
      ev.map((e) => [e.reasonCode, e.distanceBucketM, e.personId]),
      [
        ['SITE_NOT_CONFIGURED', null, person.k1],
        ['GEOFENCE_OUTSIDE', 500, person.k1],
        ['LOCATION_TOO_COARSE', 200, person.k1],
      ],
    );
    for (const e of ev)
      for (const c of coords)
        assert.ok(!e.j.includes(c), 'event carried a coordinate');
    // At the edge, inside by 1 m with 5 m accuracy: accepted and flagged NEAR_EDGE.
    const edge = await tap(dev.k1.token, { m: 499, acc: '5' });
    const ok = await expectStatus(Promise.resolve(edge.r), 200);
    K.k1CheckIn = ok.checkInId;
    assert.deepEqual(
      [ok.kind, ok.flags, ok.timePrecision, ok.hasSelfie, ok.afterSubmission],
      ['SELF', ['NEAR_EDGE'], 'EXACT', false, false],
    );
    const stored = await checkInRow(ok.checkInId);
    assert.equal(stored.siteTimezone, 'Europe/Belgrade');
    assert.equal(stored.day, edge.body.businessDate);
    assert.equal(stored.occurredAt.toISOString(), edge.body.occurredAt);
    assert.equal(stored.fixAt.toISOString(), edge.body.fix.fixAt);
    assert.equal(stored.deviceSentAt.toISOString(), edge.body.deviceSentAt);
    assert.ok(stored.recordedAt >= stored.receivedAt);
    assert.equal(
      stored.clockSkewMs,
      stored.receivedAt.getTime() - stored.deviceSentAt.getTime(),
    );
    assert.equal(stored.lat_t, edge.body.fix.lat);
    assert.deepEqual(
      [stored.distanceM, stored.siteRefN, stored.actorLat, stored.crewId],
      [499, 1, null, K.K1],
    );
    // A new key the same day: ALREADY_CHECKED_IN with only the existing time and kind.
    x = await tap(dev.k1.token);
    assert.equal(x.r.status, 409);
    assert.deepEqual(x.r.body.existing, {
      occurredAt: edge.body.occurredAt,
      kind: 'SELF',
    });
    // The same key with a refreshed deviceSentAt (6 minutes of skew) replays; a changed event
    // under the same key is refused.
    const again = await expectStatus(
      kpost('/checkin', dev.k1.token, {
        ...edge.body,
        deviceSentAt: new Date(
          Date.parse(edge.body.deviceSentAt) + 6 * MIN,
        ).toISOString(),
      }),
      200,
    );
    assert.deepEqual(again, ok);
    await expectStatus(
      kpost('/checkin', dev.k1.token, {
        ...edge.body,
        occurredAt: new Date(
          Date.parse(edge.body.occurredAt) + 1,
        ).toISOString(),
      }),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "WorkerCheckIn" WHERE "personId"=$1`,
        [person.k1],
      ),
      1,
    );
    x = await tap(dev.kp.token);
    await expectStatus(Promise.resolve(x.r), 403, 'DEVICE_PENDING');
    pass(
      'check-in: without a site reference the tap is refused (SITE_NOT_CONFIGURED), never distance 0; the PM sets the reference (stale number VERSION_CONFLICT, reader READ_ONLY, other org FORBIDDEN); 501 m is GEOFENCE_OUTSIDE and accuracy 100.01 m LOCATION_TOO_COARSE, each logged with a 100 m bucket and no coordinates; 499 m ±5 m is accepted and flagged NEAR_EDGE; occurred, fix, device-sent, received and recorded times, site timezone and business day are stored apart; a new key is ALREADY_CHECKED_IN with only {occurredAt, kind}; the same key replays even with 6 min of skew; a changed event under the key is refused; a pending device is DEVICE_PENDING',
    );
  }

  step('check-in: time admission');
  {
    const cases = [
      [{ fixLag: -1_000 }, 'FIX_TIME_INVALID'], // a fix from after the tap
      [{ fixLag: 2 * MIN + 10_000 }, 'FIX_TIME_INVALID'], // staler than 2 minutes
      [{ at: 2_000 }, 'TIME_ORDER_INVALID'], // occurredAt after deviceSentAt
      [{ at: 6 * MIN, sent: 6 * MIN + 1_000 }, 'DEVICE_CLOCK_SKEW'],
      [{ at: -6 * MIN - 5_000, sent: -6 * MIN - 1_000 }, 'DEVICE_CLOCK_SKEW'],
      [{ at: -25 * HOUR }, 'TOO_LATE'], // a first attempt 25 h after the tap
    ];
    for (const [o, code] of cases) {
      const x = await tap(dev.k2.token, o);
      await expectStatus(Promise.resolve(x.r), 409, code);
    }
    const today = await siteDay(await clockNow());
    const mismatch = await tap(dev.k2.token, { date: shiftDay(today, -1) });
    await expectStatus(
      Promise.resolve(mismatch.r),
      409,
      'BUSINESS_DAY_MISMATCH',
    );
    const late = await tap(dev.k2.token, { at: -20 * MIN });
    const body = await expectStatus(Promise.resolve(late.r), 200);
    assert.deepEqual(body.flags, ['LATE']);
    assert.deepEqual(
      (await refusals(dev.k2.id)).map((e) => [e.reasonCode, e.distanceBucketM]),
      [
        ...cases.map(([, code]) => [code, null]),
        ['BUSINESS_DAY_MISMATCH', null],
      ],
    );
    pass(
      'check-in time admission (first attempt): a future fix, a fix staler than 2 min, occurredAt after deviceSentAt, device clock skew of +6 and -6 min, a first attempt 25 h after the tap and a client business day that differs from the site-zone day are refused and logged; 20 min after the tap is accepted and flagged LATE',
    );
  }

  step('check-in: retries beyond 5 min and 24 h');
  {
    // Accepted 2 s before the 24 h limit, then retried with the same key and event when a
    // first attempt would be refused: after 24 h (TOO_LATE) and with 6 min of skew.
    const now = await clockNow();
    const first = await tapBody({ now, at: -(24 * HOUR - 2_000) });
    const ok = await expectStatus(kpost('/checkin', dev.k3.token, first), 200);
    assert.deepEqual(ok.flags, ['LATE']);
    const after24h = new Date(Date.parse(first.occurredAt) + 24 * HOUR + MIN);
    for (const deviceSentAt of [
      after24h.toISOString(),
      new Date(now.getTime() + 6 * MIN + 5_000).toISOString(),
    ])
      assert.deepEqual(
        await expectStatus(
          kpost('/checkin', dev.k3.token, { ...first, deviceSentAt }),
          200,
        ),
        ok,
      );
    // The same event under a new key is a first attempt: refused at that age.
    await expectStatus(
      kpost('/checkin', dev.k3.token, {
        ...first,
        clientMutationId: randomUUID(),
        deviceSentAt: after24h.toISOString(),
      }),
      409,
      'TOO_LATE',
    );
    const row = await checkInRow(ok.checkInId);
    assert.equal(row.deviceSentAt.toISOString(), first.deviceSentAt);
    pass(
      'retries: a check-in accepted just inside 24 h replays its stored result for the same key and event when retried beyond 24 h and with 6 min of skew (no time rule re-run; the committing attempt keeps its deviceSentAt); the same event under a new key is a first attempt and TOO_LATE',
    );
  }

  step('check-in: local midnight');
  {
    const midnight = async () =>
      (
        await owner.query(
          `SELECT (date_trunc('day', clock_timestamp() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade') AS m, clock_timestamp() AS now`,
        )
      ).rows[0];
    let { m, now } = await midnight();
    // The tap after midnight must be in the past and the one before it inside 24 h: wait out
    // the first 3 minutes after a midnight, or the last 2 before one (rare; at most ~5 min).
    if (now - m < 3 * MIN)
      await untilDb(new Date(m.getTime() + 3 * MIN).toISOString(), 4 * MIN);
    else if (now - m > 23 * HOUR + 58 * MIN)
      await untilDb(
        new Date(m.getTime() + 24 * HOUR + 3 * MIN).toISOString(),
        6 * MIN,
      );
    ({ m, now } = await midnight());
    const D = await siteDay(now);
    const before = await tapBody({ now, at: m - now - 30_000 });
    const after = await tapBody({ now, at: m - now + 30_000 });
    assert.equal(before.businessDate, shiftDay(D, -1));
    assert.equal(after.businessDate, D);
    const a = await expectStatus(kpost('/checkin', dev.k4.token, before), 200);
    const b = await expectStatus(kpost('/checkin', dev.k4.token, after), 200);
    assert.deepEqual(
      [
        (await checkInRow(a.checkInId)).day,
        (await checkInRow(b.checkInId)).day,
      ],
      [shiftDay(D, -1), D],
    );
    await expectStatus(
      kpost('/checkin', dev.k5.token, {
        ...(await tapBody({ now, at: m - now + 30_000 })),
        businessDate: shiftDay(D, -1),
      }),
      409,
      'BUSINESS_DAY_MISMATCH',
    );
    pass(
      'local midnight: taps 30 s before and after Belgrade midnight get the previous and the current business day (one each for the same person); a client date of the previous day for a tap after midnight is BUSINESS_DAY_MISMATCH (DST transitions: unit-tested, checkin-rules.test.ts)',
    );
  }

  step('check-in: foreman proxy');
  {
    const x = await tap(dev.kf.token, { personId: person.k6, m: 120 });
    const ok = await expectStatus(Promise.resolve(x.r), 200);
    assert.equal(ok.kind, 'FOREMAN_PROXY');
    const row = await checkInRow(ok.checkInId);
    // The foreman's fix is the actor's location, never the worker's.
    assert.deepEqual(
      [
        row.lat,
        row.lon,
        row.accuracyM,
        row.distanceM,
        row.actorLat_t,
        row.actorDistanceM,
      ],
      [null, null, null, null, x.body.fix.lat, 120],
    );
    assert.deepEqual(
      [row.deviceId, row.actorPersonId, row.personId, row.crewId],
      [dev.kf.id, person.kf, person.k6, K.K1],
    );
    for (const [token, subject, status, code] of [
      [dev.kf.token, person.kx, 403, 'PROXY_NOT_ALLOWED'], // another crew
      [dev.k7.token, person.k8, 403, 'PROXY_NOT_ALLOWED'], // a worker device
      [dev.kf.token, person.kf, 403, 'PROXY_NOT_ALLOWED'], // oneself
      [dev.kf.token, person.wb, 404, 'NOT_FOUND'], // another org
      [dev.kf.token, randomUUID(), 404, 'NOT_FOUND'], // nobody
    ]) {
      const r = await tap(token, { personId: subject });
      await expectStatus(Promise.resolve(r.r), status, code);
    }
    // Off site: refused and logged under the foreman's device for the subject.
    const off = await tap(dev.kf.token, { personId: person.k8, m: 640 });
    await expectStatus(Promise.resolve(off.r), 409, 'GEOFENCE_OUTSIDE');
    assert.deepEqual(
      (await refusals(dev.kf.id)).map((e) => [
        e.reasonCode,
        e.distanceBucketM,
        e.personId,
      ]),
      [['GEOFENCE_OUTSIDE', 600, person.k8]],
    );
    await expectStatus(
      Promise.resolve((await tap(dev.kf2.token, { personId: person.kx })).r),
      200,
    );
    pass(
      "foreman proxy: the crew's foreman on site checks in a member (FOREMAN_PROXY; the foreman's fix kept as the actor's location, the worker's location empty); another crew's member, a proxy from a worker device and a self-proxy are PROXY_NOT_ALLOWED; another org's person and a nonexistent one the same NOT_FOUND; a foreman off site (640 m) is GEOFENCE_OUTSIDE, logged for the subject",
    );
  }

  step('check-in: PM proxy');
  {
    const now = await clockNow();
    const D = await siteDay(now);
    const { rows } = await owner.query(
      `SELECT (date_trunc('day', clock_timestamp() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade') AS m`,
    );
    const m = rows[0].m;
    const fixNow = (metres, acc = '10') => ({
      lat: northOf(metres),
      lon: LON,
      accuracyM: acc,
      fixAt: now.toISOString(),
    });
    const body = (over) => ({
      projectId: projectA,
      clientMutationId: randomUUID(),
      personId: person.k8,
      businessDate: D,
      source: 'OBSERVED_ON_SITE',
      reason: '',
      ...over,
    });
    const proxy = (b, bearer = pm) => ppost('/checkins/proxy', bearer, b);
    await expectStatus(proxy(body()), 409, 'REASON_REQUIRED');
    const dayBody = body({ reason: 'TEST seen at the gate' });
    const day = await expectStatus(proxy(dayBody), 200);
    assert.deepEqual(
      [day.kind, day.timePrecision, day.occurredAt, day.flags],
      ['PM_PROXY', 'DAY', null, ['PROXY_LOCATION_UNAVAILABLE']],
    );
    assert.deepEqual(await expectStatus(proxy(dayBody), 200), day);
    let row = await checkInRow(day.checkInId);
    assert.deepEqual(
      [
        row.occurredAt,
        row.crewAttribution,
        row.crewId,
        row.source,
        row.actorAccountId,
      ],
      [null, 'ONLY_CREW_OF_DAY', K.K1, 'OBSERVED_ON_SITE', accounts.pm],
    );
    // Yesterday, exact time, from 5 km away: REMOTE_PROXY; the PM's fix is the actor's only.
    const remote = await expectStatus(
      proxy(
        body({
          personId: person.k7,
          businessDate: shiftDay(D, -1),
          occurredAt: new Date(m.getTime() - 2 * HOUR).toISOString(),
          source: 'FOREMAN_REPORTED',
          reason: 'TEST phoned in',
          actorFix: fixNow(5000, '50'),
        }),
      ),
      200,
    );
    assert.deepEqual(
      [remote.timePrecision, remote.flags],
      ['EXACT', ['REMOTE_PROXY']],
    );
    row = await checkInRow(remote.checkInId);
    assert.deepEqual(
      [row.lat, row.lon, row.actorDistanceM > 4900],
      [null, null, true],
    );
    // The 7-day window (configurable), a coarse fix, an inside fix without reason today.
    await expectStatus(
      proxy(
        body({
          personId: person.k7,
          businessDate: shiftDay(D, -8),
          reason: 'TEST',
        }),
      ),
      409,
      'TOO_LATE',
    );
    await expectStatus(
      proxy(
        body({
          personId: person.k7,
          businessDate: shiftDay(D, -7),
          reason: 'TEST',
        }),
      ),
      200,
    );
    const coarse = await expectStatus(
      proxy(
        body({
          personId: person.k7,
          businessDate: shiftDay(D, -2),
          reason: 'TEST',
          actorFix: fixNow(100, '150'),
        }),
      ),
      200,
    );
    assert.deepEqual(coarse.flags, ['PROXY_LOCATION_COARSE']);
    const inside = await expectStatus(
      proxy(body({ personId: person.k5, actorFix: fixNow(100) })),
      200,
    );
    assert.deepEqual(inside.flags, []);
    // No interval that day; transferred today (ambiguous crew); left the project today.
    await expectStatus(
      proxy(
        body({
          personId: person.kx,
          businessDate: shiftDay(D, -5),
          reason: 'TEST',
        }),
      ),
      404,
      'PERSON_NOT_ROSTERED',
    );
    await expectStatus(
      change([close(assignment(person.kt)), open(K.K2, person.kt)]),
      200,
    );
    const moved = await expectStatus(
      proxy(body({ personId: person.kt, reason: 'TEST' })),
      200,
    );
    row = await checkInRow(moved.checkInId);
    assert.deepEqual([row.crewAttribution, row.crewId], ['UNKNOWN', null]);
    await expectStatus(change([close(assignment(person.kl))]), 200);
    const left = await expectStatus(
      proxy(body({ personId: person.kl, reason: 'TEST' })),
      200,
    );
    assert.equal(
      (await checkInRow(left.checkInId)).crewAttribution,
      'ONLY_CREW_OF_DAY',
    );
    for (const [b, status, code, bearer] of [
      [
        body({
          personId: person.k6,
          occurredAt: new Date(now.getTime() + MIN).toISOString(),
          reason: 'T',
        }),
        409,
        'TIME_ORDER_INVALID',
      ],
      [
        body({
          personId: person.k6,
          businessDate: shiftDay(D, 1),
          reason: 'T',
        }),
        409,
        'TIME_ORDER_INVALID',
      ],
      [
        body({
          personId: person.k6,
          actorFix: {
            ...fixNow(10),
            fixAt: new Date(now.getTime() - 3 * MIN).toISOString(),
          },
        }),
        409,
        'FIX_TIME_INVALID',
      ],
      [body({ personId: person.k6, reason: 'T' }), 403, 'READ_ONLY', exec],
      [body({ personId: person.k6, reason: 'T' }), 403, 'FORBIDDEN', pm2],
      [body({ personId: randomUUID(), reason: 'T' }), 404, 'NOT_FOUND'],
      [body({ personId: person.wb, reason: 'T' }), 404, 'NOT_FOUND'],
    ])
      await expectStatus(proxy(b, bearer), status, code);
    // The window is a project setting.
    const set = (over) =>
      ppost('/settings', pm, {
        projectId: projectA,
        clientMutationId: randomUUID(),
        expectedN: 0,
        selfieEnabled: false,
        pmProxyDays: 3,
        ...over,
      });
    await expectStatus(set(), 200);
    await expectStatus(
      proxy(
        body({
          personId: person.k6,
          businessDate: shiftDay(D, -4),
          reason: 'TEST',
        }),
      ),
      409,
      'TOO_LATE',
    );
    await expectStatus(set({ expectedN: 1, pmProxyDays: 7 }), 200);
    const audits = await owner.query(
      `SELECT concat_ws(' ', before::text, after::text, reason) AS t FROM "AuditLog" WHERE action='FIELD_PM_PROXY'`,
    );
    assert.equal(audits.rows.length, 7);
    pass(
      "PM proxy: without a time it is DAY precision (occurredAt null, never invented) and needs a reason when no in-fence fix exists; the replay returns the same result; a 5 km fix yesterday with an exact time is REMOTE_PROXY and stays the actor's location only; 8 days back is TOO_LATE, 7 days is allowed, and a 3-day project window refuses 4 days; a 150 m-accuracy fix is PROXY_LOCATION_COARSE; an inside fix today needs no reason; a day without a member interval is PERSON_NOT_ROSTERED, a person transferred today gets crewAttribution UNKNOWN, one who left today is still accepted; a future time or date, a stale PM fix, a reader, another project's PM, a nonexistent and another org's person are refused; every proxy is audited",
    );
  }

  step('check-in: other project, other org, revoked device');
  {
    K.KM = await crew(projectA2, 'KM', pm2);
    await expectStatus(
      change([open(K.KM, person.km), open(K.KM, person.kd)], projectA2, pm2),
      200,
    );
    await travel(
      `UPDATE "CrewAssignment" SET "validFrom" = "validFrom" - interval '1 day' WHERE "personId" = ANY($1::uuid[]) AND "projectId" = $2`,
      [[person.km, person.kd], projectA2],
    );
    await expectStatus(
      ppost('/site-reference', pm2, {
        projectId: projectA2,
        clientMutationId: randomUUID(),
        expectedN: 0,
        lat: '-33.900000',
        lon: LON,
        radiusM: 800,
      }),
      200,
    );
    // Fresh entry codes: the throttling steps may have filled the old codes' bind buckets.
    for (const [projectId, bearer] of [
      [projectA2, pm2],
      [projectB, pmB],
    ]) {
      entryCode[projectId] = (
        await expectStatus(rotateEntry(projectId, bearer), 200)
      ).code;
      secret.entry.push(entryCode[projectId]);
    }
    dev.kmA2 = await onboard(person.km, {
      ip: KIP,
      code: entryCode[projectA2],
      bearer: pm2,
      projectId: projectA2,
    });
    const inA2 = await expectStatus(
      Promise.resolve((await tap(dev.kmA2.token)).r),
      200,
    );
    assert.deepEqual(inA2.flags, []);
    const inA = await expectStatus(
      Promise.resolve((await tap(dev.km.token)).r),
      200,
    );
    assert.deepEqual(inA.flags, ['MULTI_PROJECT_DAY']);
    // Concurrent: kd's project A check-in is held right after its cross-project read (before
    // its insert) while kd checks in on project A2. The A2 check-in must wait on the org-wide
    // person/day lock and then see A's row; without that lock both miss each other.
    dev.kdA2 = await onboard(person.kd, {
      ip: KIP,
      code: entryCode[projectA2],
      bearer: pm2,
      projectId: projectA2,
    });
    {
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
          text.includes('"WorkerCheckIn"') &&
          text.includes('"projectId" <> $2'),
        hit,
        opened,
      };
      const inProjectA = tap(dev.kd.token);
      await withTimeout(reached, STEP_MS, 'A check-in reads other projects');
      const D = await siteDay(await clockNow());
      const slotKey = `${orgA}:field-slot:${person.kd}:${D}`;
      const inProjectA2 = tap(dev.kdA2.token);
      const seen = await Promise.race([
        inProjectA2.then(() => 'finished'),
        advisoryWaiters(slotKey, 1).then(
          () => 'waiting',
          () => 'not waiting',
        ),
      ]);
      await openGate();
      const a = await expectStatus(Promise.resolve((await inProjectA).r), 200);
      const a2 = await expectStatus(
        Promise.resolve((await inProjectA2).r),
        200,
      );
      assert.deepEqual(
        [a.flags, a2.flags, seen],
        [[], ['MULTI_PROJECT_DAY'], 'waiting'],
      );
    }
    // A device of another project or org names a person of project A: the same 404 as nobody.
    K.KB = await crew(projectB, 'KB', pmB);
    await expectStatus(
      change(
        [open(K.KB, person.wb2, 'FOREMAN'), open(K.KB, person.wb2)],
        projectB,
        pmB,
      ),
      200,
    );
    dev.wb2 = await onboard(person.wb2, {
      ip: KIP,
      code: entryCode[projectB],
      bearer: pmB,
      projectId: projectB,
    });
    for (const token of [dev.kmA2.token, dev.wb2.token])
      await expectStatus(
        Promise.resolve((await tap(token, { personId: person.k2 })).r),
        404,
        'NOT_FOUND',
      );
    // Revoked: the next tap is DEVICE_ENDED; an unknown token FIELD_AUTH_REQUIRED.
    await expectStatus(
      pmDevice('revoke', dev.k8.id, (await row(dev.k8.id)).version),
      200,
    );
    await expectStatus(
      Promise.resolve((await tap(dev.k8.token)).r),
      401,
      'DEVICE_ENDED',
    );
    await expectStatus(
      Promise.resolve(
        (await tap('fd1.' + randomBytes(32).toString('base64url'))).r,
      ),
      401,
      'FIELD_AUTH_REQUIRED',
    );
    pass(
      "check-in scope: the project is always the device's; the same person checked in on another project the same day is accepted and flagged MULTI_PROJECT_DAY; a device of another project or another org naming a person of project A gets the same NOT_FOUND as a nonexistent person; a revoked device is DEVICE_ENDED and an unknown token FIELD_AUTH_REQUIRED",
    );
  }

  // ---------- staged selfie ----------
  const selfieUpload = async (
    token,
    bytes,
    type = 'image/jpeg',
    key = randomUUID(),
  ) => {
    const form = new FormData();
    form.set('clientMutationId', key);
    form.set('selfie', new Blob([bytes], { type }), 'selfie');
    const r = await withTimeout(
      fetch(`${base}/api/field/selfie`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': key,
          'X-Forwarded-For': KIP,
        },
        body: form,
        signal: AbortSignal.timeout(STEP_MS),
      }),
      STEP_MS,
      'selfie upload',
    );
    const text = await r.text();
    responses.push({ path: '/api/field/selfie', status: r.status, text });
    return { status: r.status, body: text ? JSON.parse(text) : null, key };
  };
  const selfieRow = async (id) =>
    (await owner.query(`SELECT * FROM "FieldSelfie" WHERE id=$1`, [id]))
      .rows[0];
  const pmSelfie = async (checkInId) => {
    const r = await fetch(
      `${base}/api/report/field/checkins/selfie?projectId=${projectA}&checkInId=${checkInId}`,
      {
        headers: { Authorization: `Bearer ${pm}` },
        signal: AbortSignal.timeout(STEP_MS),
      },
    );
    const bytes = Buffer.from(await r.arrayBuffer());
    responses.push({
      path: '/api/report/field/checkins/selfie',
      status: r.status,
      text: r.status === 200 ? '' : bytes.toString(),
    });
    return { status: r.status, bytes };
  };
  const enableSelfie = (on, expectedN) =>
    expectStatus(
      ppost('/settings', pm, {
        projectId: projectA,
        clientMutationId: randomUUID(),
        expectedN,
        selfieEnabled: on,
        pmProxyDays: 7,
      }),
      200,
    );
  const S = {};

  step('selfie: staged, attached, feature off, ownership');
  {
    const jpeg = (tag) => testJpeg({ tag });
    // U1: off by default.
    await expectStatus(
      selfieUpload(dev.s1.token, jpeg('s1')),
      403,
      'FEATURE_OFF',
    );
    await enableSelfie(true, 2);
    // A file carrying GPS: its location metadata never reaches storage.
    const gpsJpeg = testJpeg({
      tag: 's1',
      exif: exifTiff({
        gps: {
          latRef: 'S',
          lat: [
            [33, 1],
            [54, 1],
            [0, 1],
          ],
          lonRef: 'W',
          lon: [
            [18, 1],
            [24, 1],
            [0, 1],
          ],
        },
      }),
    });
    const up = await expectStatus(selfieUpload(dev.s1.token, gpsJpeg), 200);
    S.s1 = up.selfieId;
    // Idempotent on key + sha256: the same file replays, another file under the key is refused.
    const key = randomUUID();
    const a1 = await expectStatus(
      selfieUpload(dev.s2.token, jpeg('s2'), 'image/jpeg', key),
      200,
    );
    assert.deepEqual(
      await expectStatus(
        selfieUpload(dev.s2.token, jpeg('s2'), 'image/jpeg', key),
        200,
      ),
      a1,
    );
    await expectStatus(
      selfieUpload(dev.s2.token, jpeg('s2-other'), 'image/jpeg', key),
      409,
      'IDEMPOTENCY_KEY_REUSED',
    );
    S.s2 = a1.selfieId;
    await expectStatus(
      selfieUpload(dev.s1.token, Buffer.from('TEST not an image')),
      415,
      'UNSUPPORTED_MEDIA',
    );
    const big = Buffer.alloc(3 * 1024 * 1024 + 1);
    jpeg('big').copy(big);
    await expectStatus(
      selfieUpload(dev.s1.token, big),
      413,
      'SELFIE_TOO_LARGE',
    );
    await expectStatus(
      selfieUpload(dev.kp.token, jpeg('kp')),
      403,
      'DEVICE_PENDING',
    );
    // Someone else's staged selfie, another project's device: the same NOT_FOUND.
    await expectStatus(
      Promise.resolve((await tap(dev.s2.token, { selfie: S.s1 })).r),
      404,
      'NOT_FOUND',
    );
    await expectStatus(
      Promise.resolve(
        (await tap(dev.kmA2.token, { selfie: S.s1, key: randomUUID() })).r,
      ),
      404,
      'NOT_FOUND',
    );
    // Own selfie: attached inside the check-in.
    const ok = await expectStatus(
      Promise.resolve((await tap(dev.s1.token, { selfie: S.s1 })).r),
      200,
    );
    assert.equal(ok.hasSelfie, true);
    S.s1CheckIn = ok.checkInId;
    const s = await selfieRow(S.s1);
    assert.deepEqual(
      [s.state, s.blobKey],
      ['ATTACHED', `selfie/${orgA}/${S.s1}`],
    );
    const read = await pmSelfie(ok.checkInId);
    assert.equal(read.status, 200);
    assert.notDeepEqual(read.bytes, gpsJpeg);
    assert.equal(readFileClaims(read.bytes).gps, null);
    assert.equal(readFileClaims(gpsJpeg).gps !== null, true);
    // A reader never gets it; a check-in without a selfie has none to read.
    const denied = await fetch(
      `${base}/api/report/field/checkins/selfie?projectId=${projectA}&checkInId=${ok.checkInId}`,
      { headers: { Authorization: `Bearer ${exec}` } },
    );
    assert.equal(denied.status, 403);
    assert.equal((await pmSelfie(K.k1CheckIn)).status, 404);
    assert.equal((await pmSelfie(randomUUID())).status, 404);
    // Selfie switched off again: a staged selfie cannot be attached.
    await enableSelfie(false, 3);
    await expectStatus(
      Promise.resolve((await tap(dev.s2.token, { selfie: S.s2 })).r),
      403,
      'FEATURE_OFF',
    );
    assert.equal((await selfieRow(S.s2)).state, 'STAGED');
    await enableSelfie(true, 4);
    pass(
      "selfie: off by default (FEATURE_OFF); once enabled a confirmed device stages one (location metadata removed before storage), idempotent on key + sha256 (another file under the key is refused); a non-image is 415, over 3 MB 413, a pending device DEVICE_PENDING; another person's staged selfie and another project's device get NOT_FOUND; the own selfie is attached inside the check-in and readable by the PM only (reader 403); with the switch off again a staged selfie cannot be attached",
    );
  }

  step('selfie: expiry grace and cleanup');
  {
    // E ≤ t < E + 5 min: attach refused, cleanup does not claim; t ≥ E + 5 min: claimed, deleted.
    const up = await expectStatus(
      selfieUpload(dev.s3.token, testJpeg({ tag: 's3' })),
      200,
    );
    await travel(
      `UPDATE "FieldSelfie" SET "createdAt" = clock_timestamp() - interval '61 minutes', "expiresAt" = clock_timestamp() - interval '1 minute' WHERE id=$1`,
      [up.selfieId],
    );
    await expectStatus(
      Promise.resolve((await tap(dev.s3.token, { selfie: up.selfieId })).r),
      409,
      'SELFIE_EXPIRED',
    );
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "WorkerCheckIn" WHERE "personId"=$1`,
        [person.s3],
      ),
      0,
    );
    await checkInStore.cleanupSelfies(orgA);
    assert.equal((await selfieRow(up.selfieId)).state, 'STAGED');
    await travel(
      `UPDATE "FieldSelfie" SET "createdAt" = clock_timestamp() - interval '67 minutes', "expiresAt" = clock_timestamp() - interval '6 minutes' WHERE id=$1`,
      [up.selfieId],
    );
    const swept = await checkInStore.cleanupSelfies(orgA);
    assert.ok(swept.claimed >= 1 && swept.failed === 0);
    const s = await selfieRow(up.selfieId);
    assert.deepEqual(
      [s.state, s.claimedAt !== null, s.deletedAt !== null],
      ['DELETED', true, true],
    );
    assert.equal(selfieBlobs.map.has(s.blobKey), false);
    await expectStatus(
      Promise.resolve((await tap(dev.s3.token, { selfie: up.selfieId })).r),
      409,
      'SELFIE_EXPIRED',
    );
    pass(
      'selfie grace: one minute after expiry the attach is refused (SELFIE_EXPIRED, nothing written) and cleanup does not claim it; six minutes after, cleanup claims it (DELETING, committed), deletes the blob and marks it DELETED; it is never attachable again',
    );
  }

  step('selfie: attach vs cleanup');
  {
    // (a) The attach holds the row lock before E: a cleanup pass whose cutoff makes the row
    // eligible skips it at once (SKIP LOCKED); after the attach commits, a pass ignores it.
    const up = await expectStatus(
      selfieUpload(dev.s4.token, testJpeg({ tag: 's4' })),
      200,
    );
    const future = new Date(Date.parse(up.expiresAt) + 6 * MIN).toISOString();
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
        text.includes('FROM "FieldSelfie"') && text.includes('FOR UPDATE'),
      hit,
      opened,
    };
    const attaching = tap(dev.s4.token, { selfie: up.selfieId });
    await withTimeout(reached, STEP_MS, 'attach reaches the selfie row lock');
    const started = Date.now();
    const pass1 = await withTimeout(
      checkInStore.cleanupSelfies(orgA, { cutoff: future }),
      5_000,
      'cleanup must not wait for the attach',
    );
    assert.ok(Date.now() - started < 5_000);
    assert.equal((await selfieRow(up.selfieId)).state, 'STAGED');
    await openGate();
    const ok = await expectStatus(Promise.resolve((await attaching).r), 200);
    assert.equal(ok.hasSelfie, true);
    await checkInStore.cleanupSelfies(orgA, { cutoff: future });
    assert.equal((await selfieRow(up.selfieId)).state, 'ATTACHED');
    // It may claim other eligible rows (an older staged selfie), never the locked one.
    assert.ok(pass1.failed === 0);
    // (b) A committed claim first: the later attach sees DELETING and is refused. A failed blob
    // delete leaves the row DELETING (not attachable), and the next sweep finishes it.
    const up5 = await expectStatus(
      selfieUpload(dev.s5.token, testJpeg({ tag: 's5' })),
      200,
    );
    selfieBlobs.failDeletes = true;
    try {
      const r = await checkInStore.cleanupSelfies(orgA, {
        cutoff: new Date(Date.parse(up5.expiresAt) + 6 * MIN).toISOString(),
      });
      assert.ok(r.claimed >= 1 && r.failed >= 1);
    } finally {
      selfieBlobs.failDeletes = false;
    }
    const claimed = await selfieRow(up5.selfieId);
    assert.equal(claimed.state, 'DELETING');
    assert.equal(selfieBlobs.map.has(claimed.blobKey), true);
    await expectStatus(
      Promise.resolve((await tap(dev.s5.token, { selfie: up5.selfieId })).r),
      409,
      'SELFIE_EXPIRED',
    );
    await checkInStore.cleanupSelfies(orgA);
    assert.equal((await selfieRow(up5.selfieId)).state, 'DELETED');
    assert.equal(selfieBlobs.map.has(claimed.blobKey), false);
    pass(
      'selfie attach vs cleanup, controlled lock timing: an attach holding the selfie row lock before expiry makes a cleanup pass with an eligible cutoff skip the row at once (no wait), the attach then commits ATTACHED and a later pass ignores it; a claim committed first makes the later attach SELFIE_EXPIRED; a failed blob delete leaves the row DELETING and the next sweep deletes it',
    );
  }

  step('selfie: lost COMMIT acknowledgement, cleanup without a blob store');
  {
    // The upload's COMMIT succeeds but its acknowledgement is lost: the image of the committed
    // row must stay, and the request settles to the stored result under the key lock.
    const key = randomUUID();
    const bytes = testJpeg({ tag: 's3-lost-ack' });
    commitFault = true;
    let up;
    try {
      up = await expectStatus(
        selfieUpload(dev.s3.token, bytes, 'image/jpeg', key),
        200,
      );
    } finally {
      commitFault = false;
    }
    const committed = await selfieRow(up.selfieId);
    assert.equal(committed.state, 'STAGED');
    assert.equal(selfieBlobs.map.has(committed.blobKey), true);
    assert.deepEqual(
      await expectStatus(
        selfieUpload(dev.s3.token, bytes, 'image/jpeg', key),
        200,
      ),
      up,
    );
    // Without a blob store nothing is claimed, deleted or audited; the row stays retryable.
    await travel(
      `UPDATE "FieldSelfie" SET "createdAt" = clock_timestamp() - interval '70 minutes', "expiresAt" = clock_timestamp() - interval '10 minutes' WHERE id=$1`,
      [up.selfieId],
    );
    const audited = () =>
      count(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE action='FIELD_SELFIE_DELETED' AND "entityId"=$1`,
        [up.selfieId],
      );
    await assert.rejects(
      new CheckInStore(appPool, null, fieldOptions).cleanupSelfies(orgA),
    );
    assert.equal((await selfieRow(up.selfieId)).state, 'STAGED');
    assert.equal(selfieBlobs.map.has(committed.blobKey), true);
    assert.equal(await audited(), 0);
    await checkInStore.cleanupSelfies(orgA);
    assert.equal((await selfieRow(up.selfieId)).state, 'DELETED');
    assert.equal(selfieBlobs.map.has(committed.blobKey), false);
    assert.equal(await audited(), 1);
    pass(
      'selfie upload whose COMMIT acknowledgement is lost: the committed row keeps its image and the request settles to the stored result (a same-key retry returns it); a cleanup without a blob store refuses before claiming, so the row stays retryable, the image stays and nothing is audited, and a later sweep with the store deletes it',
    );
  }

  step('check-in: submission boundary under concurrency');
  const R = {};
  {
    const now = await clockNow();
    R.D = await siteDay(now);
    const dayKey = `${orgA}:day:${projectA}:${R.D}`;
    const submit = () =>
      http('/api/report/submit', {
        method: 'POST',
        bearer: pm,
        body: {
          projectId: projectA,
          businessDate: R.D,
          expectedVersion: 0,
          clientMutationId: randomUUID(),
        },
      });
    // c1 waits on the day lock first, the submission second; c1 commits before the snapshot.
    // The submission is then held right after reading the day's sequence (holding the day
    // lock) while c2 queues behind it; c2 must land after the boundary.
    const unlock = await holdAdvisory(dayKey);
    const c1 = tap(dev.kc1.token);
    await advisoryWaiters(dayKey, 1);
    let hit, release;
    const reached = new Promise((resolve) => (hit = resolve));
    const opened = new Promise((resolve) => (release = resolve));
    const openGate = async () => {
      held.delete(openGate);
      release();
    };
    held.add(openGate);
    queryGate = {
      match: (text) => text.includes('SELECT "lastSeq" FROM "FieldDay"'),
      hit,
      opened,
    };
    const submitting = submit();
    await advisoryWaiters(dayKey, 2);
    await unlock();
    const first = await expectStatus(Promise.resolve((await c1).r), 200);
    assert.equal(first.afterSubmission, false);
    await withTimeout(reached, STEP_MS, 'submission reads the field sequence');
    const c2 = tap(dev.kc2.token);
    await advisoryWaiters(dayKey, 1);
    await openGate();
    const submitted = await expectStatus(submitting, 200);
    const second = await expectStatus(Promise.resolve((await c2).r), 200);
    assert.equal(second.afterSubmission, true);
    const rev = await expectStatus(
      http(
        `/api/report/revision?projectId=${projectA}&businessDate=${R.D}&n=${submitted.revisionNumber}`,
        {
          method: 'GET',
          bearer: pm,
        },
      ),
      200,
    );
    R.snapshot = rev.snapshot;
    const field = R.snapshot.field;
    assert.ok(field, 'the revision froze the field part');
    const frozen = field.checkIns.map((c) => c.checkInId);
    assert.ok(frozen.includes(first.checkInId));
    assert.ok(!frozen.includes(second.checkInId));
    assert.ok(frozen.includes(S.s1CheckIn));
    assert.equal(
      field.checkIns.find((c) => c.checkInId === S.s1CheckIn).hasSelfie,
      true,
    );
    const list = await expectStatus(
      pget(`/checkins?projectId=${projectA}&businessDate=${R.D}`, pm),
      200,
    );
    assert.equal(list.seqBoundary, field.seqBoundary);
    const byId = Object.fromEntries(list.checkIns.map((c) => [c.checkInId, c]));
    assert.equal(byId[first.checkInId].afterSubmission, false);
    assert.equal(byId[second.checkInId].afterSubmission, true);
    assert.equal(byId[second.checkInId].daySeq > field.seqBoundary, true);
    // Headcount is never filled from check-ins; the frozen summary only counts claims.
    assert.equal(field.summary.present, field.checkIns.length);
    assert.equal(JSON.stringify(R.snapshot.facts.people ?? {}), '{}');
    R.revisionNumber = submitted.revisionNumber;
    R.rev = rev;
    pass(
      "submission boundary: a check-in queued on the day lock before the submission is frozen in the revision; one queued while the submission holds the day lock (after it read the sequence) gets a higher sequence and is afterSubmission, not in the revision; the list shows the boundary and each row's side; the attached selfie is frozen as hasSelfie; report facts (people) are untouched",
    );
  }

  step('check-in: after submission, void, snapshot, reader, retention');
  {
    const reread = async () =>
      expectStatus(
        http(
          `/api/report/revision?projectId=${projectA}&businessDate=${R.D}&n=${R.revisionNumber}`,
          {
            method: 'GET',
            bearer: pm,
          },
        ),
        200,
      );
    // Void: PM only, reason required, once; takes the next sequence (after the boundary).
    const voidBody = (checkInId, over = {}) => ({
      projectId: projectA,
      clientMutationId: randomUUID(),
      checkInId,
      reason: 'TEST wrong person',
      ...over,
    });
    await expectStatus(
      ppost('/checkins/void', pm, voidBody(S.s1CheckIn, { reason: '' })),
      400,
      'INVALID_INPUT',
    );
    await expectStatus(
      ppost('/checkins/void', exec, voidBody(S.s1CheckIn)),
      403,
      'READ_ONLY',
    );
    await expectStatus(
      ppost('/checkins/void', pm2, voidBody(S.s1CheckIn)),
      403,
      'FORBIDDEN',
    );
    await expectStatus(
      ppost('/checkins/void', pm, voidBody(randomUUID())),
      404,
      'NOT_FOUND',
    );
    const v = voidBody(S.s1CheckIn);
    const voided = await expectStatus(ppost('/checkins/void', pm, v), 200);
    assert.equal(voided.afterSubmission, true);
    assert.deepEqual(
      await expectStatus(ppost('/checkins/void', pm, v), 200),
      voided,
    );
    await expectStatus(
      ppost('/checkins/void', pm, voidBody(S.s1CheckIn)),
      409,
      'VERSION_CONFLICT',
    );
    // The voided check-in's selfie is spent: no reattachment.
    await expectStatus(
      Promise.resolve((await tap(dev.s1.token, { selfie: S.s1 })).r),
      409,
      'SELFIE_EXPIRED',
    );
    // Retention: 30 days after attachment the image is deleted; hasSelfie stays frozen.
    await travel(
      `UPDATE "FieldSelfie" SET "attachedAt" = clock_timestamp() - interval '31 days' WHERE id=$1`,
      [S.s1],
    );
    selfieBlobs.failDeletes = true;
    try {
      await checkInStore.cleanupSelfies(orgA);
    } finally {
      selfieBlobs.failDeletes = false;
    }
    assert.equal((await selfieRow(S.s1)).state, 'DELETING');
    assert.equal((await pmSelfie(S.s1CheckIn)).status, 404);
    await checkInStore.cleanupSelfies(orgA);
    const gone = await selfieRow(S.s1);
    assert.equal(gone.state, 'DELETED');
    assert.equal(selfieBlobs.map.has(gone.blobKey), false);
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE action='FIELD_SELFIE_DELETED' AND "entityId"=$1 AND reason='RETENTION'`,
        [S.s1],
      ),
      1,
    );
    const list = await expectStatus(
      pget(`/checkins?projectId=${projectA}&businessDate=${R.D}`, pm),
      200,
    );
    const s1 = list.checkIns.find((c) => c.checkInId === S.s1CheckIn);
    assert.deepEqual(
      [s1.selfie, s1.voided.reason],
      ['DELETED', 'TEST wrong person'],
    );
    // Later check-ins, voids, roster and site-reference changes never touch the revision.
    await expectStatus(
      ppost('/site-reference', pm, {
        projectId: projectA,
        clientMutationId: randomUUID(),
        expectedN: 1,
        lat: '-33.900000',
        lon: LON,
        radiusM: 700,
      }),
      200,
    );
    await expectStatus(change([close(assignment(person.k6))]), 200);
    assert.deepEqual(await reread(), R.rev);
    // A reader never gets the frozen check-ins, nor the list.
    const readerRev = await expectStatus(
      http(
        `/api/report/revision?projectId=${projectA}&businessDate=${R.D}&n=${R.revisionNumber}`,
        {
          method: 'GET',
          bearer: exec,
        },
      ),
      200,
    );
    assert.equal(JSON.stringify(readerRev).includes('"field"'), false);
    assert.equal(JSON.stringify(readerRev).includes(S.s1CheckIn), false);
    await expectStatus(
      pget(`/checkins?projectId=${projectA}&businessDate=${R.D}`, exec),
      403,
      'READ_ONLY',
    );
    pass(
      'after submission: void needs a reason and the PM of the project (reader READ_ONLY, other PM FORBIDDEN, unknown NOT_FOUND), replays, happens once (VERSION_CONFLICT) and lands after the boundary; a voided check-in\'s selfie is never reattached; after 30 days the image is claimed, a failed delete leaves it DELETING and unreadable, the next sweep deletes it (audited RETENTION) and the list shows "deleted"; the submitted revision is byte-for-byte unchanged by the void, retention, a site-reference change and a roster change, and still says hasSelfie; a reader gets neither the frozen check-ins nor the list',
    );
  }

  step('check-in: history is append-only');
  {
    const ci = S.s1CheckIn;
    const app = await appPool.connect();
    const refused = async (sql, params) => {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      try {
        await app.query(sql, params);
        assert.fail(`the app role could run: ${sql}`);
      } catch (error) {
        assert.ok(
          ['P0001', '42501'].includes(error.code),
          `${error.code} ${error.message}`,
        );
      } finally {
        await app.query('ROLLBACK');
      }
    };
    try {
      for (const [sql, params] of [
        [
          `UPDATE "WorkerCheckIn" SET "voidReason"='TEST again' WHERE id=$1`,
          [ci],
        ],
        [`UPDATE "WorkerCheckIn" SET "occurredAt"=now() WHERE id=$1`, [ci]],
        [`DELETE FROM "WorkerCheckIn" WHERE id=$1`, [ci]],
        [`UPDATE "FieldSelfie" SET state='STAGED' WHERE id=$1`, [S.s1]],
        [
          `UPDATE "FieldSelfie" SET "expiresAt"=now() + interval '1 day' WHERE id=$1`,
          [S.s2],
        ],
        [`DELETE FROM "FieldSelfie" WHERE id=$1`, [S.s2]],
        [
          `UPDATE "FieldSelfie" SET state='ATTACHED', "attachedAt"=now() WHERE state='DELETED'`,
          [],
        ],
        [`DELETE FROM "CheckInSelfie" WHERE "checkInId"=$1`, [ci]],
        [`UPDATE "ProjectSiteReference" SET "radiusM"=2000`, []],
        [`DELETE FROM "ProjectFieldSetting"`, []],
        [`UPDATE "FieldDay" SET "lastSeq"=1`, []],
        [`DELETE FROM "FieldDay"`, []],
        [`UPDATE "FieldDeviceEvent" SET "distanceBucketM"=0`, []],
      ])
        await refused(sql, params);
      // RLS: another org sees none of it.
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
      const seen = await app.query(
        `SELECT (SELECT count(*) FROM "WorkerCheckIn")::int + (SELECT count(*) FROM "FieldSelfie")::int
          + (SELECT count(*) FROM "ProjectSiteReference" WHERE "projectId"<>$1)::int AS n`,
        [projectB],
      );
      await app.query('ROLLBACK');
      assert.equal(seen.rows[0].n, 0);
    } finally {
      app.release();
    }
    // Append-only for the owner too (triggers, not only grants).
    for (const sql of [
      `DELETE FROM "WorkerCheckIn" WHERE id=$1`,
      `UPDATE "CheckInSelfie" SET "createdAt"=now() WHERE "checkInId"=$1`,
      `UPDATE "WorkerCheckIn" SET "businessDate"='2000-01-01' WHERE id=$1`,
    ])
      await assert.rejects(owner.query(sql, [ci]), (e) => e.code === 'P0001');
    pass(
      'history: the app role cannot change or delete a check-in (a voided one cannot be voided again), move a selfie backwards or change its deadline, delete selfie rows or links, change site references, settings or refusal events, or move a day sequence back; another org sees no check-ins, selfies or site references',
    );
  }

  if (process.env.BLOB_CONNECTION_STRING) {
    step('selfie blob delete (Azurite)');
    const container = `field-test-${suffix}`;
    const azure = AzurePhotoBlobStore.fromConnectionString(
      process.env.BLOB_CONNECTION_STRING,
      container,
    );
    await azure.ensureContainer();
    try {
      const k = `selfie/${orgA}/${randomUUID()}`;
      await azure.put(k, testJpeg({ tag: 'azure' }), 'image/jpeg');
      assert.ok(await azure.get(k));
      await azure.delete(k);
      await azure.delete(k); // already gone = deleted
      assert.equal(await azure.get(k), null);
      await assert.rejects(azure.delete(`${orgA}/${'0'.repeat(64)}`));
    } finally {
      await azure.deleteContainer();
    }
    pass(
      'Azure selfie blob delete (Azurite): deletes, a missing blob counts as deleted, and only selfie/ keys can ever be deleted',
    );
  }

  // ================= A6c: foreman quantity reports and PM adoption =================
  // A project of its own (TEST-F), so its days, roster and items start empty. Its crews are
  // moved three days back (owner, triggers off; TEST only), so yesterday and the day before are
  // staffed days too and the date rule, not the roster, decides what a foreman may write.
  step('foreman: reports, authority, dates');
  const F = { dev: {} };
  const projectF = randomUUID();
  const rget = (path, bearer) =>
    http('/api/report' + path, { method: 'GET', bearer });
  const rpost = (path, bearer, body) =>
    http('/api/report' + path, { method: 'POST', bearer, body });
  const dayOf = (date, bearer = pm) =>
    expectStatus(
      rget(`/day?projectId=${projectF}&businessDate=${date}`, bearer),
      200,
    );
  const revisionOf = (date, n, bearer = pm) =>
    expectStatus(
      rget(
        `/revision?projectId=${projectF}&businessDate=${date}&n=${n}`,
        bearer,
      ),
      200,
    );
  const reportBody = (o) => ({
    clientMutationId: o.key ?? randomUUID(),
    businessDate: o.date ?? F.T,
    crewId: o.crew,
    expectedRevision: o.n ?? 0,
    rows: Array.isArray(o.rows)
      ? o.rows
      : Object.entries(o.rows ?? {}).map(([itemKey, qty]) => ({
          itemKey,
          qty,
        })),
    note: o.note ?? '',
    occurredAt: new Date().toISOString(),
  });
  const freport = (token, o) => fpost('/report', token, reportBody(o));
  const adopt = (item, day, o = {}) =>
    rpost('/foreman/adopt', o.bearer ?? pm, {
      projectId: projectF,
      businessDate: o.date ?? F.T,
      clientMutationId: o.key ?? randomUUID(),
      item,
      expectedVersion: o.version ?? day.version,
      basis: o.basis ?? day.foreman.basis,
    });
  const adoptions = () =>
    count(
      `SELECT count(*)::int AS n FROM "ForemanAdoption" WHERE "projectId"=$1`,
      [projectF],
    );
  const rosterKeyF = `${orgA}:field-roster:${projectF}`;
  /** Holds the next app statement matching `match` (after it ran) until `open()`. */
  function gateAfter(match) {
    let hit, release;
    const reached = new Promise((resolve) => (hit = resolve));
    const opened = new Promise((resolve) => (release = resolve));
    const open = async () => {
      held.delete(open);
      release();
    };
    held.add(open);
    queryGate = { match: (text) => text.includes(match), hit, opened };
    return {
      reached: () => withTimeout(reached, STEP_MS, `gate after ${match}`),
      open,
    };
  }
  const openAssignment = (personId, role = 'MEMBER') =>
    lastRoster[projectF].assignments
      .filter(
        (a) =>
          a.personId === personId && a.role === role && a.validUntil === null,
      )
      .at(-1).id;
  {
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,\'TEST-F\',\'TEST-F\',\'Europe/Belgrade\',\'ACTIVE\')',
      [projectF, orgA, seedActor],
    );
    await membership(orgA, accounts.pm, 'PROJECT_MANAGER', projectF);
    rosterV[projectF] = 0;
    entryCode[projectF] = (
      await expectStatus(rotateEntry(projectF, pm), 200)
    ).code;
    secret.entry.push(entryCode[projectF]);
    const item = (key, sortOrder, active = true) => ({
      kind: 'work',
      key,
      label: `TEST ${key}`,
      unit: 'set',
      designQty: '',
      openingCumulative: '',
      sortOrder,
      active,
    });
    await expectStatus(
      rpost('/items', pm, {
        projectId: projectF,
        clientMutationId: randomUUID(),
        items: [
          ...['support', 'rail', 'modules', 'cable', 'fence', 'big'].map(
            (k, i) => item(k, i),
          ),
          item('retired', 9, false),
        ],
      }),
      200,
    );
    for (const k of [
      'Ffa',
      'Ffb',
      'Ffc',
      'Ffd',
      'Fwa',
      'Fwb',
      'Fwc',
      'Fwd',
      'Fw1',
      'Fw2',
      'Fw3',
      'Fw4',
    ])
      await addPerson(k, orgA);
    for (const c of ['FA', 'FB', 'FC', 'FD']) F[c] = await crew(projectF, c);
    await expectStatus(
      change(
        [
          open(F.FA, person.Ffa),
          open(F.FA, person.Ffa, 'FOREMAN'),
          open(F.FA, person.Fwa),
          open(F.FB, person.Ffb),
          open(F.FB, person.Ffb, 'FOREMAN'),
          open(F.FB, person.Fwb),
          open(F.FC, person.Ffc),
          open(F.FC, person.Ffc, 'FOREMAN'),
          open(F.FC, person.Fwc),
          // Crew FD is staffed all day but has no foreman (Ffd becomes its foreman later).
          open(F.FD, person.Fwd),
          open(F.FD, person.Ffd),
        ],
        projectF,
      ),
      200,
    );
    await travel(
      `UPDATE "CrewAssignment" SET "validFrom" = "validFrom" - interval '3 days' WHERE "projectId"=$1`,
      [projectF],
    );
    await travel(
      `UPDATE "Crew" SET "activeFrom" = "activeFrom" - interval '3 days' WHERE "projectId"=$1`,
      [projectF],
    );
    for (const k of ['Ffa', 'Ffb', 'Ffc', 'Ffd', 'Fwa'])
      F.dev[k] = await onboard(person[k], {
        code: entryCode[projectF],
        projectId: projectF,
      });
    F.T = await siteDay(await clockNow());
    F.Y = shiftDay(F.T, -1);
    F.Y2 = shiftDay(F.T, -2);
    const fa = F.dev.Ffa.token;

    // The foreman's own crew, nothing reported yet; the active work items only.
    const empty = await expectStatus(
      fget(`/report?businessDate=${F.T}`, fa),
      200,
    );
    assert.deepEqual(
      [empty.crewId, empty.n, empty.rows, empty.items.map((i) => i.key)],
      [F.FA, 0, [], ['support', 'rail', 'modules', 'cable', 'fence', 'big']],
    );
    // First revision; blank, unknown, n/a, zero and a comma decimal are all kept as given.
    const first = reportBody({
      crew: F.FA,
      rows: {
        support: '10',
        rail: '',
        modules: 'unknown',
        cable: '0',
        fence: 'na',
        big: '99999999999999',
      },
      note: 'TEST first',
    });
    F.firstA = first;
    const r1 = await expectStatus(fpost('/report', fa, first), 200);
    assert.deepEqual([r1.crewId, r1.n, r1.afterSubmission], [F.FA, 1, false]);
    assert.deepEqual(await expectStatus(fpost('/report', fa, first), 200), r1);
    const stored = (
      await owner.query(
        `SELECT v.rows, v."daySeq"::int AS seq, v."siteTimezone", v."receivedAt", v."occurredAt"
        FROM "ForemanReportRevision" v WHERE v.id=$1`,
        [r1.revisionId],
      )
    ).rows[0];
    assert.deepEqual(
      stored.rows.find((x) => x.itemKey === 'rail'),
      { itemKey: 'rail', qty: '' },
    );
    assert.equal(stored.seq, r1.daySeq);
    assert.equal(stored.siteTimezone, 'Europe/Belgrade');
    // Stale: the foreman submits on n−1 (a second tab still at 0).
    await expectStatus(
      freport(fa, { crew: F.FA, n: 0, rows: { support: '11' } }),
      409,
      'REVISION_CONFLICT',
    );
    // Items, numbers and duplicate keys.
    for (const [rows, status, code] of [
      [{ nope: '1' }, 404, 'ITEM_NOT_FOUND'],
      [{ retired: '1' }, 404, 'ITEM_NOT_FOUND'],
      [{ support: 'abc' }, 409, 'NUMBER_INVALID'],
      [{ support: '1e3' }, 409, 'NUMBER_INVALID'],
      [{ support: '-1' }, 409, 'NUMBER_INVALID'],
      [{ support: '123456789012345' }, 409, 'NUMBER_INVALID'],
      [{ support: '1.1234567' }, 409, 'NUMBER_INVALID'],
      [
        [
          { itemKey: 'support', qty: '1' },
          { itemKey: 'support', qty: '2' },
        ],
        400,
        'INVALID_INPUT',
      ],
    ])
      await expectStatus(freport(fa, { crew: F.FA, n: 1, rows }), status, code);
    // Authority: another crew, a worker, another project's foreman; dates by the site calendar.
    await expectStatus(
      freport(fa, { crew: F.FB, rows: { support: '1' } }),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      freport(F.dev.Fwa.token, { crew: F.FA, n: 1, rows: { support: '1' } }),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      fget(`/report?businessDate=${F.T}`, F.dev.Fwa.token),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      freport(dev.kf.token, { crew: F.FA, n: 1, rows: { support: '1' } }),
      403,
      'NOT_FOREMAN',
    );
    await expectStatus(
      freport(fa, { crew: F.FA, date: F.Y2, rows: { support: '1' } }),
      409,
      'TOO_LATE',
    );
    await expectStatus(
      fget(`/report?businessDate=${F.Y2}`, fa),
      409,
      'TOO_LATE',
    );
    await expectStatus(
      freport(fa, {
        crew: F.FA,
        date: shiftDay(F.T, 1),
        rows: { support: '1' },
      }),
      409,
      'TIME_ORDER_INVALID',
    );
    const y = await expectStatus(
      freport(fa, { crew: F.FA, date: F.Y, rows: { support: '4' } }),
      200,
    );
    assert.equal(y.n, 1);
    assert.equal(
      await count(
        `SELECT count(*)::int AS n FROM "ForemanReportRevision" v JOIN "ForemanReport" h ON h.id=v."reportId"
        WHERE h."crewId"=$1 AND h."businessDate"=$2::date`,
        [F.FA, F.T],
      ),
      1,
    );
    // The other crews report; FD (no foreman) cannot.
    await expectStatus(
      freport(F.dev.Ffb.token, {
        crew: F.FB,
        rows: {
          support: '0',
          rail: 'na',
          modules: '5',
          cable: '0',
          fence: 'na',
          big: '99999999999999',
        },
      }),
      200,
    );
    const c1 = await expectStatus(
      freport(F.dev.Ffc.token, {
        crew: F.FC,
        rows: {
          support: 'na',
          rail: 'na',
          modules: '5,5',
          cable: '0.000',
          fence: 'na',
          big: '1',
        },
      }),
      200,
    );
    const cRows = (
      await owner.query(
        `SELECT rows FROM "ForemanReportRevision" WHERE id=$1`,
        [c1.revisionId],
      )
    ).rows[0].rows;
    assert.equal(cRows.find((x) => x.itemKey === 'modules').qty, '5.5');
    await expectStatus(
      freport(F.dev.Ffd.token, { crew: F.FD, rows: { support: '0' } }),
      403,
      'NOT_FOREMAN',
    );
    pass(
      "foreman reports: the foreman's own current crew only (another crew, a worker, another project's foreman → NOT_FOREMAN), the site's today or yesterday only (two days ago → TOO_LATE, tomorrow → TIME_ORDER_INVALID); append-only revisions with expectedRevision (a stale n−1 → REVISION_CONFLICT) and an exact replay; unknown or inactive items → ITEM_NOT_FOUND (404); non-numbers, negatives, exponents and values outside Decimal(20,6) → NUMBER_INVALID; duplicate item keys → INVALID_INPUT; blanks stored as blank, a comma decimal normalized, the site timezone and day sequence stored; a refused write stores nothing",
    );
  }

  step('foreman: completeness and explicit adoption');
  {
    const day0 = await dayOf(F.T);
    const f0 = day0.foreman;
    assert.deepEqual(
      f0.expectedCrews.map((c) => [c.crewId, c.hasForeman]),
      [
        [F.FA, true],
        [F.FB, true],
        [F.FC, true],
        [F.FD, false],
      ],
    );
    // A staffed crew without a foreman is expected and MISSING_REPORT: nothing is COMPLETE.
    assert.deepEqual(
      [
        f0.items.support.status,
        f0.items.support.value,
        f0.items.support.atLeast,
      ],
      ['PARTIAL', null, '10'],
    );
    assert.equal(f0.items.support.crews[F.FD].status, 'MISSING_REPORT');
    assert.equal(f0.items.cable.status, 'PARTIAL');
    assert.deepEqual(
      f0.basis.revisions.find((r) => r.crewId === F.FD),
      { crewId: F.FD, n: null },
    );
    // Before anything is submitted a reader gets nothing of the day, and never foreman data.
    const readerDraft = await dayOf(F.T, exec);
    assert.equal(JSON.stringify(readerDraft).includes('foreman'), false);
    await expectStatus(adopt('support', day0), 409, 'ADOPT_NOT_COMPLETE');
    await expectStatus(
      adopt('support', day0, { bearer: exec }),
      403,
      'READ_ONLY',
    );
    await expectStatus(
      adopt('support', day0, { bearer: pm2 }),
      403,
      'FORBIDDEN',
    );
    await expectStatus(adopt('nope', day0), 404, 'ITEM_NOT_FOUND');
    await expectStatus(adopt('retired', day0), 404, 'ITEM_NOT_FOUND');
    // A roster change (Ffd becomes FD's foreman) → the old basis is stale by roster version.
    await expectStatus(
      change([open(F.FD, person.Ffd, 'FOREMAN')], projectF),
      200,
    );
    await expectStatus(adopt('support', day0), 409, 'FOREMAN_TOTAL_CHANGED');
    await expectStatus(
      freport(F.dev.Ffd.token, {
        crew: F.FD,
        rows: {
          support: '0',
          rail: 'na',
          modules: 'na',
          cable: '0',
          fence: 'na',
          big: '0',
        },
      }),
      200,
    );
    const day1 = await dayOf(F.T);
    const it = day1.foreman.items;
    const st = (k) => [it[k].status, it[k].value, it[k].atLeast];
    assert.deepEqual(st('support'), ['COMPLETE', '10', null]);
    assert.deepEqual(st('rail'), ['PARTIAL', null, null]);
    assert.equal(it.rail.crews[F.FA].status, 'OMITTED');
    assert.deepEqual(st('modules'), ['PARTIAL', null, '10.5']);
    assert.equal(it.modules.crews[F.FA].status, 'UNKNOWN');
    assert.deepEqual(st('cable'), ['COMPLETE', '0', null]);
    assert.deepEqual(
      Object.values(it.cable.crews).map((c) => c.status),
      ['ZERO', 'ZERO', 'ZERO', 'ZERO'],
    );
    assert.deepEqual(st('fence'), ['ALL_NA', null, null]);
    assert.deepEqual(st('big'), ['OVERFLOW', null, null]);
    for (const k of ['rail', 'modules', 'fence', 'big'])
      await expectStatus(adopt(k, day1), 409, 'ADOPT_NOT_COMPLETE');
    assert.equal(await adoptions(), 0);
    // A foreman revision after the PM read → the old basis is stale by revision.
    await expectStatus(
      freport(F.dev.Ffa.token, {
        crew: F.FA,
        n: 1,
        rows: {
          support: '12',
          rail: '3',
          modules: 'unknown',
          cable: '0',
          fence: 'na',
          big: '99999999999999',
        },
      }),
      200,
    );
    await expectStatus(adopt('support', day1), 409, 'FOREMAN_TOTAL_CHANGED');
    const day2 = await dayOf(F.T);
    assert.equal(day2.foreman.items.support.value, '12');
    // A changed expected crew set (one left out, one added) is a change too.
    for (const expectedCrews of [
      day2.foreman.basis.expectedCrews.slice(1),
      [...day2.foreman.basis.expectedCrews, randomUUID()],
    ])
      await expectStatus(
        adopt('support', day2, {
          basis: { ...day2.foreman.basis, expectedCrews },
        }),
        409,
        'FOREMAN_TOTAL_CHANGED',
      );
    assert.equal(await adoptions(), 0);
    assert.equal(day2.facts.qty.support ?? '', '');
    // Explicit adoption against the current basis; an exact replay; an explicit zero.
    const key = randomUUID();
    const a1 = await expectStatus(adopt('support', day2, { key }), 200);
    assert.deepEqual([a1.item, a1.value], ['support', '12']);
    assert.deepEqual(
      await expectStatus(adopt('support', day2, { key }), 200),
      a1,
    );
    const day3 = await dayOf(F.T);
    assert.equal(day3.facts.qty.support, '12');
    const a2 = await expectStatus(adopt('cable', day3), 200);
    assert.equal(a2.value, '0');
    const day4 = await dayOf(F.T);
    assert.equal(day4.facts.qty.cable, '0');
    assert.deepEqual(
      day4.foreman.adoptions.map((a) => [a.itemKey, a.value]),
      [
        ['support', '12'],
        ['cable', '0'],
      ],
    );
    assert.deepEqual(day4.foreman.adoptions[0].basis, day2.foreman.basis);
    assert.equal(await adoptions(), 2);
    // The PM may always type another value; a stale adoption then never overwrites it.
    const typed = await expectStatus(
      rpost('/facts', pm, {
        projectId: projectF,
        businessDate: F.T,
        expectedVersion: day4.version,
        clientMutationId: randomUUID(),
        facts: {
          ...day4.facts,
          qty: { ...day4.facts.qty, support: '25' },
        },
      }),
      200,
    );
    await expectStatus(adopt('support', day4), 409, 'VERSION_CONFLICT');
    const day5 = await dayOf(F.T);
    assert.deepEqual(
      [day5.version, day5.facts.qty.support, day5.foreman.items.support.value],
      [typed.version, '25', '12'],
    );
    F.day5 = day5;
    pass(
      'completeness: a staffed crew without a foreman is expected and MISSING_REPORT (support PARTIAL ≥10, not adoptable); per crew OMITTED (blank), UNKNOWN, NA, ZERO and VALUE; an explicit zero from every crew is COMPLETE 0 and adoptable; all n/a is ALL_NA (no number); a sum outside Decimal(20,6) is OVERFLOW (no number); only COMPLETE is adopted (ADOPT_NOT_COMPLETE otherwise); a stale basis after a roster change, a new revision or a changed crew set → FOREMAN_TOTAL_CHANGED and nothing is written; adoption writes facts.qty with an append-only row and its basis, replays exactly, is PM-only (reader READ_ONLY, other PM FORBIDDEN, unknown item 404); the PM can type another value and a stale adoption then gets VERSION_CONFLICT',
    );
  }

  step('foreman: adopt vs roster change');
  {
    // Roster first: the write holds the exclusive roster lock (waiting on a person lock); the
    // adoption waits on the shared lock and then sees the new roster version.
    let day = await dayOf(F.T);
    const vBefore = day.foreman.rosterVersion;
    const unlock = await holdAdvisory(personKey(person.Fw1, orgA, projectF));
    const rosterFirst = change([open(F.FA, person.Fw1)], projectF);
    await advisoryWaiters(personKey(person.Fw1, orgA, projectF), 1);
    const waiting = adopt('support', day);
    await advisoryWaiters(rosterKeyF, 1);
    await unlock();
    await expectStatus(rosterFirst, 200);
    await expectStatus(waiting, 409, 'FOREMAN_TOTAL_CHANGED');
    assert.equal(await adoptions(), 2);
    // Adoption first: held after its insert (holding the shared roster lock); the roster write
    // waits for the exclusive lock and commits after it.
    day = await dayOf(F.T);
    const vMid = day.foreman.rosterVersion;
    assert.equal(vMid, vBefore + 1);
    const gate = gateAfter('INSERT INTO "ForemanAdoption"');
    const adopting = adopt('cable', day);
    await gate.reached();
    const rosterAfter = change([open(F.FB, person.Fw2)], projectF);
    await advisoryWaiters(rosterKeyF, 1);
    await gate.open();
    const a = await expectStatus(adopting, 200);
    await expectStatus(rosterAfter, 200);
    const after = await dayOf(F.T);
    assert.equal(after.foreman.rosterVersion, vMid + 1);
    const row = after.foreman.adoptions.find((x) => x.id === a.adoptionId);
    assert.equal(row.basis.rosterVersion, vMid);
    pass(
      'adopt vs roster change under controlled lock timing: a roster write holding the exclusive roster lock commits first → the waiting adoption gets FOREMAN_TOTAL_CHANGED and writes nothing; an adoption holding the shared roster lock commits first with the old roster version in its basis, and the roster write waits until after it',
    );
  }

  step('foreman: adopt, revision and roster vs submit');
  {
    const submit = (date, version) =>
      rpost('/submit', pm, {
        projectId: projectF,
        businessDate: date,
        expectedVersion: version,
        clientMutationId: randomUUID(),
      });
    // (a) Adoption first: the submission waits on the day row and then finds a newer version.
    let day = await dayOf(F.T);
    let gate = gateAfter('INSERT INTO "ForemanAdoption"');
    const adopting = adopt('cable', day);
    await gate.reached();
    const late = submit(F.T, day.version);
    await rowWaiters(1);
    await gate.open();
    await expectStatus(adopting, 200);
    await expectStatus(late, 409, 'VERSION_CONFLICT');
    // (b) Submission first, held after reading the day's sequence (holding the roster share,
    // the day row and the day lock): an adoption queues on the day row, a foreman revision on
    // the day lock. The adoption finds a newer version; the revision lands after the boundary.
    day = await dayOf(F.T);
    const dayKey = `${orgA}:day:${projectF}:${F.T}`;
    const nA = day.foreman.revisions.find((r) => r.crewId === F.FA).n;
    gate = gateAfter('SELECT "lastSeq" FROM "FieldDay"');
    const submitting = submit(F.T, day.version);
    await gate.reached();
    const queuedAdopt = adopt('support', day);
    await rowWaiters(1);
    const queuedReport = freport(F.dev.Ffa.token, {
      crew: F.FA,
      n: nA,
      rows: { support: '99', cable: '0' },
    });
    await advisoryWaiters(dayKey, 1);
    await gate.open();
    const submitted = await expectStatus(submitting, 200);
    await expectStatus(queuedAdopt, 409, 'VERSION_CONFLICT');
    const afterRev = await expectStatus(queuedReport, 200);
    assert.equal(afterRev.afterSubmission, true);
    const rev = await revisionOf(F.T, submitted.revisionNumber);
    const snap = rev.snapshot;
    // Both figures are frozen: the PM's typed value and the foreman's complete total.
    assert.equal(snap.facts.qty.support, '25');
    assert.deepEqual(
      [snap.foreman.items.support.status, snap.foreman.items.support.value],
      ['COMPLETE', '12'],
    );
    assert.deepEqual(
      snap.foreman.adoptions.map((x) => [x.itemKey, x.value]),
      [
        ['support', '12'],
        ['cable', '0'],
        ['cable', '0'],
        ['cable', '0'],
      ],
    );
    assert.equal(snap.foreman.revisions.find((r) => r.crewId === F.FA).n, nA);
    assert.ok(afterRev.daySeq > snap.field.seqBoundary);
    assert.ok(
      snap.foreman.revisions.every((r) => r.daySeq <= snap.field.seqBoundary),
    );
    assert.equal(snap.foreman.rosterVersion, rosterV[projectF]);
    // The writer view marks the late revision; the day is locked for adoption.
    const live = await dayOf(F.T);
    const lateRow = live.foreman.revisions.find((r) => r.crewId === F.FA);
    assert.deepEqual([lateRow.n, lateRow.afterSubmission], [nA + 1, true]);
    assert.equal(live.foreman.expectedCrewsChanged, false);
    assert.equal(live.foreman.items.support.value, '99');
    await expectStatus(adopt('support', live), 409, 'LOCKED');
    // A later roster change never alters the frozen revision.
    await expectStatus(change([open(F.FC, person.Fw3)], projectF), 200);
    assert.deepEqual(await revisionOf(F.T, submitted.revisionNumber), rev);
    F.rev = { date: F.T, n: submitted.revisionNumber, body: rev };

    // (c) A roster write that waits until after a submission (yesterday): frozen unchanged.
    const y = await dayOf(F.Y);
    const vY = y.foreman.rosterVersion;
    gate = gateAfter('SELECT "lastSeq" FROM "FieldDay"');
    const submittingY = submit(F.Y, y.version);
    await gate.reached();
    const rosterLate = change([open(F.FD, person.Fw4)], projectF);
    await advisoryWaiters(rosterKeyF, 1);
    await gate.open();
    const sY = await expectStatus(submittingY, 200);
    await expectStatus(rosterLate, 200);
    const revY = await revisionOf(F.Y, sY.revisionNumber);
    assert.equal(revY.snapshot.foreman.rosterVersion, vY);
    assert.equal(
      revY.snapshot.foreman.revisions.find((r) => r.crewId === F.FA).n,
      1,
    );
    assert.equal(revY.snapshot.foreman.items.support.status, 'PARTIAL');
    assert.equal((await dayOf(F.Y)).foreman.rosterVersion, vY + 1);
    // (d) A roster write that commits before a submission (two days ago): the new version.
    const unlock = await holdAdvisory(personKey(person.Fw4, orgA, projectF));
    const rosterFirst = change(
      [close(openAssignment(person.Fw4), null)],
      projectF,
    );
    await advisoryWaiters(personKey(person.Fw4, orgA, projectF), 1);
    const submittingY2 = submit(F.Y2, 0);
    await advisoryWaiters(rosterKeyF, 1);
    await unlock();
    await expectStatus(rosterFirst, 200);
    const sY2 = await expectStatus(submittingY2, 200);
    const revY2 = await revisionOf(F.Y2, sY2.revisionNumber);
    assert.equal(revY2.snapshot.foreman.rosterVersion, rosterV[projectF]);
    assert.equal(revY2.snapshot.foreman.rosterVersion, vY + 2);
    pass(
      'ordering with submit under controlled lock timing: an adoption holding the day row commits first and the queued submission gets VERSION_CONFLICT; a submission holding the day row and lock commits first → the queued adoption gets VERSION_CONFLICT, the queued foreman revision gets a sequence above the boundary (afterSubmission, not frozen) and a later adoption is LOCKED; the snapshot keeps the PM figure (25) beside the foreman total (COMPLETE 12), the adoptions and the revision numbers; a roster write waiting until after a submission leaves the frozen roster version, one committing before it is frozen with the new version; a later roster change never alters a revision',
    );
  }

  step('foreman: readers, replays and history');
  {
    // A reader never sees foreman data: not in the day, not in the revision.
    const readerDay = await dayOf(F.rev.date, exec);
    const readerRev = await revisionOf(F.rev.date, F.rev.n, exec);
    for (const body of [readerDay, readerRev]) {
      const text = JSON.stringify(body);
      assert.equal(text.includes('"foreman"'), false);
      for (const r of F.rev.body.snapshot.foreman.revisions)
        assert.equal(text.includes(r.revisionId), false);
    }
    assert.equal(readerRev.snapshot.facts.qty.support, '25');
    // A replay re-runs authorization: once Ffa is no longer a foreman, the first key is refused.
    await expectStatus(
      change([close(openAssignment(person.Ffa, 'FOREMAN'), null)], projectF),
      200,
    );
    await expectStatus(
      fpost('/report', F.dev.Ffa.token, F.firstA),
      403,
      'NOT_FOREMAN',
    );
    // History: the app role cannot rewrite reports, revisions or adoptions.
    const ids = (
      await owner.query(
        `SELECT (SELECT id FROM "ForemanReport" WHERE "projectId"=$1 LIMIT 1) AS report,
          (SELECT id FROM "ForemanReportRevision" WHERE "projectId"=$1 LIMIT 1) AS revision,
          (SELECT id FROM "ForemanAdoption" WHERE "projectId"=$1 LIMIT 1) AS adoption`,
        [projectF],
      )
    ).rows[0];
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      for (const [sql, params, codes] of [
        [
          `UPDATE "ForemanReportRevision" SET note='x' WHERE id=$1`,
          [ids.revision],
          ['42501'],
        ],
        [
          `DELETE FROM "ForemanReportRevision" WHERE id=$1`,
          [ids.revision],
          ['42501'],
        ],
        [
          `UPDATE "ForemanAdoption" SET value=1 WHERE id=$1`,
          [ids.adoption],
          ['42501'],
        ],
        [
          `DELETE FROM "ForemanAdoption" WHERE id=$1`,
          [ids.adoption],
          ['42501'],
        ],
        [`DELETE FROM "ForemanReport" WHERE id=$1`, [ids.report], ['42501']],
        [
          `UPDATE "ForemanReport" SET "crewId"="crewId" WHERE id=$1`,
          [ids.report],
          ['42501'],
        ],
        [
          `UPDATE "ForemanReport" SET "currentN"="currentN"+2 WHERE id=$1`,
          [ids.report],
          ['P0001'],
        ],
        [
          `UPDATE "ForemanReport" SET "currentN"="currentN"-1 WHERE id=$1`,
          [ids.report],
          ['P0001', '23514'],
        ],
        // Same-project references: another project's device, a missing work item, a
        // non-work item kind.
        [
          `INSERT INTO "ForemanReportRevision"(id,"orgId","projectId","reportId",n,rows,note,"byPersonId","byDeviceId","occurredAt","receivedAt","siteTimezone","daySeq")
          VALUES($1,$2,$3,$4,99,'[]','',$5,$6,now(),now(),'UTC',1)`,
          [randomUUID(), orgA, projectF, ids.report, person.kf, dev.kf.id],
          ['23503'],
        ],
        [
          `INSERT INTO "ForemanAdoption"(id,"orgId","projectId","businessDate","itemKey",value,basis,"daySeq","byAccountId")
          VALUES($1,$2,$3,now()::date,'nope',1,'{}',1,$4)`,
          [randomUUID(), orgA, projectF, accounts.pm],
          ['23503'],
        ],
        [
          `INSERT INTO "ForemanAdoption"(id,"orgId","projectId","businessDate","itemKind","itemKey",value,basis,"daySeq","byAccountId")
          VALUES($1,$2,$3,now()::date,'material','support',1,'{}',1,$4)`,
          [randomUUID(), orgA, projectF, accounts.pm],
          ['23514', '23503'],
        ],
      ]) {
        await client.query('SAVEPOINT s');
        await assert.rejects(
          client.query(sql, params),
          (e) => codes.includes(e.code),
          sql,
        );
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
      // RLS: another org sees none of it.
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
      const seen = await client.query(
        `SELECT (SELECT count(*) FROM "ForemanReport") + (SELECT count(*) FROM "ForemanReportRevision")
          + (SELECT count(*) FROM "ForemanAdoption") AS n`,
      );
      assert.equal(Number(seen.rows[0].n), 0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // Append-only for the owner too (triggers, not only grants).
    for (const [sql, id] of [
      [`DELETE FROM "ForemanReportRevision" WHERE id=$1`, ids.revision],
      [`UPDATE "ForemanAdoption" SET value=value WHERE id=$1`, ids.adoption],
      [`DELETE FROM "ForemanReport" WHERE id=$1`, ids.report],
    ])
      await assert.rejects(owner.query(sql, [id]), (e) => e.code === 'P0001');
    pass(
      "a reader never gets foreman data (day or revision; the PM's submitted figure still shows); a replay re-runs authorization (NOT_FOREMAN once the role ended); the app role cannot update or delete revisions, adoptions or report headers (only currentN, forward by one); references stay in the same project (another project's device, a missing item, a non-work item refused); another org sees nothing; revisions, adoptions and headers are append-only for the owner too",
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
        for (const c of coords)
          assert.ok(!text.includes(c), `${path} error carried a coordinate`);
        // Only ALREADY_CHECKED_IN adds the existing check-in's time and kind (design §3).
        if (body.code === 'ALREADY_CHECKED_IN') {
          assert.deepEqual(Object.keys(body.existing).sort(), [
            'kind',
            'occurredAt',
          ]);
          delete body.existing;
        }
        assert.deepEqual(
          Object.keys(body).sort(),
          ['code', 'correlationId'],
          path,
        );
        // Check each field for what it may hold. A 6-digit challenge code can occur by chance
        // inside the random correlation id (about one run in five at this suite's volume), so the
        // id is checked for its shape and the code for being a plain error code.
        assert.match(
          String(body.correlationId),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          `${path} correlationId is not a server UUID`,
        );
        assert.match(
          String(body.code),
          /^[A-Z][A-Z0-9_]{1,63}$/,
          `${path} error code is not a plain code`,
        );
        for (const s of [...secret.entry, ...secret.codes, ...names])
          assert.ok(
            !String(body.code).includes(s),
            `${path} error code carried a secret or name`,
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
      ...coords,
    ])
      assert.ok(
        !stored.rows[0].all.includes(s),
        'audit, event or idempotency rows carried a secret, name or coordinate',
      );
    for (const line of printed)
      for (const s of [
        ...forbiddenEverywhere,
        ...secret.entry,
        ...names,
        ...coords,
      ])
        assert.ok(
          !line.includes(s),
          'process output carried a secret, name or coordinate',
        );
    pass(
      `redaction: across ${responses.length} responses no token or hash ever appears; every error is exactly {code, correlationId} (ALREADY_CHECKED_IN adds only the existing time and kind) with no code, entry code, name or coordinate; challenge codes only in the challenge response and entry codes only in the rotation response; audit, event (including refused check-ins) and idempotency rows and all process output carry none of them, nor any coordinate`,
    );
  }

  console.log(
    `Field roster/devices/entry, check-in/selfie and foreman reports/adoption HTTP/DB integration: ${checks} checks passed (${retry.repeated} RETRY answers repeated); synthetic TEST data only. The field web UI is a later slice.`,
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
