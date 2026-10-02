/** A7-1b: signed HTTP + non-bypass application role, isolated synthetic TEST DB. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import {
  AlphaStore,
  ProjectStatusCommands,
  ProjectStatusReader,
  ReportStore,
} from '../packages/domain/dist/index.js';
import { observeProjectStatusProjections } from '../packages/domain/dist/project-status/reader.js';
import type {
  PrimaryWorkItemResultDto,
  ReportingExpectationResultDto,
  ReportItemDto,
} from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import { assertLocalDatabase } from './local-db.mjs';

const raw = process.env['DATABASE_URL'];
assert.ok(raw);
const source = assertLocalDatabase(raw),
  suffix = randomBytes(6).toString('hex');
const database = `mje_master_test_${suffix}`,
  username = `mje_master_${suffix}`;
const password = randomBytes(24).toString('hex');
const url = new URL(source);
url.pathname = `/${database}`;
const closing = new WeakSet<Pool>();
const protect = (pool: Pool) =>
  pool.on('error', (e: Error & { code?: string }) => {
    if (closing.has(pool) && e.code === '57P01') return;
    throw e;
  });
const admin = protect(new Pool({ connectionString: source.toString() }));
let owner: Pool | undefined,
  appPool: Pool | undefined,
  app: Awaited<ReturnType<typeof createApp>> | undefined;
let dbCreated = false,
  roleCreated = false,
  failed = false,
  failure: unknown;
const cleanupErrors: unknown[] = [];
let holder: PoolClient | undefined;
const pending: Promise<unknown>[] = [];
let checks = 0,
  retries = 0;
const pass = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};
const seed = randomUUID(),
  org = randomUUID(),
  otherOrg = randomUUID(),
  person = randomUUID(),
  readerPerson = randomUUID(),
  otherPerson = randomUUID();
const project = randomUUID(),
  hiddenProject = randomUUID(),
  otherProject = randomUUID(),
  emptyProject = randomUUID();
const manager = randomUUID(),
  twin = randomUUID(),
  executive = randomUUID(),
  other = randomUUID();
const tenant = randomUUID(),
  object = randomUUID(),
  twinObject = randomUUID(),
  execObject = randomUUID(),
  otherObject = randomUUID();
const managerMembership = randomUUID(),
  executiveMembership = randomUUID();
type Wire = Partial<
  PrimaryWorkItemResultDto & ReportingExpectationResultDto
> & {
  code?: string;
  correlationId?: string;
  fields?: string[];
};
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  dbCreated = true;
  execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
    timeout: 180000,
  });
  owner = protect(new Pool({ connectionString: url.toString() }));
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(url);
  appUrl.username = username;
  appUrl.password = password;
  appPool = protect(new Pool({ connectionString: appUrl.toString(), max: 6 }));
  if (process.env['PROJECT_MASTER_TEST_MODE'] === 'transaction-time') {
    // TEST-only counterexample: keep all production SQL except registration clock semantics.
    appPool.on('connect', (client) => {
      const original = client.query.bind(client);
      client.query = ((sql: unknown, ...args: unknown[]) => {
        if (
          typeof sql === 'string' &&
          sql.startsWith('INSERT INTO "ReportingExpectationVersion"')
        )
          sql = sql.replace('clock_timestamp()', 'now()');
        return (original as (...values: unknown[]) => unknown)(sql, ...args);
      }) as typeof client.query;
    });
  }
  console.log(
    `TEST isolated database=${database}; mode=${process.env['PROJECT_MASTER_TEST_MODE'] ?? 'current'}`,
  );
  for (const id of [org, otherOrg])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST status organization\',now(),$2)',
      [id, seed],
    );
  for (const [id, orgId] of [
    [person, org],
    [readerPerson, org],
    [otherPerson, otherOrg],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,\'TEST status person\',now(),$3)',
      [id, orgId, seed],
    );
  for (const [id, orgId] of [
    [project, org],
    [hiddenProject, org],
    [emptyProject, org],
    [otherProject, otherOrg],
  ])
    await owner.query(
      'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1::uuid,$2,$1::uuid::text,\'TEST status project\',\'Pacific/Kiritimati\',\'ACTIVE\',now(),$3)',
      [id, orgId, seed],
    );
  for (const [id, orgId, personId, oid] of [
    [manager, org, person, object],
    [twin, org, person, twinObject],
    [executive, org, readerPerson, execObject],
    [other, otherOrg, otherPerson, otherObject],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$6)',
      [id, orgId, personId, tenant, oid, seed],
    );
  for (const [id, orgId, accountId, projectId, role] of [
    [managerMembership, org, manager, project, 'PROJECT_MANAGER'],
    [randomUUID(), org, twin, project, 'PROJECT_MANAGER'],
    [executiveMembership, org, executive, project, 'EXECUTIVE_READER'],
    [randomUUID(), otherOrg, other, otherProject, 'PROJECT_MANAGER'],
    [randomUUID(), org, manager, emptyProject, 'PROJECT_MANAGER'],
    [randomUUID(), org, executive, emptyProject, 'EXECUTIVE_READER'],
  ])
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","accountId","projectId",role,"activeFrom","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now()-interval \'1 day\',now(),$6)',
      [id, orgId, accountId, projectId, role, seed],
    );
  const requireApi = createRequire(
    new URL('../apps/api/package.json', import.meta.url),
  );
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } =
    await import(requireApi.resolve('jose'));
  const keys = await generateKeyPair('RS256'),
    audience = randomUUID(),
    clientId = randomUUID();
  const auth = {
    tenantId: tenant,
    audience,
    clientId,
    scope: 'access_as_user',
  };
  const verifier = new TokenVerifier(
    auth,
    createLocalJWKSet({
      keys: [
        {
          ...(await exportJWK(keys.publicKey)),
          alg: 'RS256',
          kid: 'TEST-status',
        },
      ],
    }),
  );
  app = await createApp({
    auth,
    verifier,
    store: new AlphaStore(appPool),
    reportStore: new ReportStore(appPool),
    projectStatusCommands: new ProjectStatusCommands(appPool),
    projectStatusReader: new ProjectStatusReader(appPool),
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function token(
    oid: string,
    issuer = `https://login.microsoftonline.com/${tenant}/v2.0`,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      tid: tenant,
      oid,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-status',
      iat: now,
      nbf: now - 1,
      exp: now + 600,
      iss: issuer,
      aud: audience,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST-status' })
      .sign(keys.privateKey);
  }
  const pm = await token(object),
    pmTwin = await token(twinObject),
    reader = await token(execObject),
    foreign = await token(otherObject);
  async function call(
    path: string,
    bearer: string | undefined,
    body?: object,
    retry = true,
  ): Promise<{ status: number; data: Wire }> {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const key =
      body && 'clientMutationId' in body ? String(body.clientMutationId) : '';
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(base + path, {
        method: bytes === undefined ? 'GET' : 'POST',
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(bytes === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Idempotency-Key': key }),
        },
        ...(bytes === undefined ? {} : { body: bytes }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await response.json()) as Wire;
      if (
        retry &&
        response.status === 503 &&
        data.code === 'RETRY' &&
        attempt < 12
      ) {
        retries++;
        await delay(100);
        continue;
      }
      return { status: response.status, data };
    }
  }

  const primary = (p = project) => `/api/projects/${p}/primary-work-item`;
  const expectation = (p = project) =>
    `/api/projects/${p}/reporting-expectation`;
  const choose = (expectedVersion = 1, key = 'work-1') => ({
    expectedVersion,
    key,
    clientMutationId: randomUUID(),
  });
  const calendar = () => ({
    fromDate: '2030-01-01',
    toDate: null,
    workdays: [1, 2, 3, 4, 5],
    clientMutationId: randomUUID(),
  });
  function code(
    r: { status: number; data: Wire },
    status: number,
    expected: string,
  ) {
    assert.equal(r.status, status);
    assert.equal(r.data.code, expected);
    assert.deepEqual(Object.keys(r.data).sort(), ['code', 'correlationId']);
    assert.match(r.data.correlationId ?? '', /^[0-9a-f-]{36}$/);
  }
  async function counts() {
    return (
      await owner!.query(
        'SELECT (SELECT count(*)::int FROM "ReportingExpectationVersion") AS calendars,(SELECT count(*)::int FROM "AuditLog") AS audits,(SELECT count(*)::int FROM "IdempotencyRecord") AS keys',
      )
    ).rows[0];
  }
  const events: string[] = [];
  const oldEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'test';
  observeProjectStatusProjections((name) => events.push(name));
  if (oldEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = oldEnv;
  code(await call(primary(), undefined, {}), 401, 'LOGIN_REQUIRED');
  code(
    await call(
      expectation(),
      await token(object, 'https://example.invalid'),
      calendar(),
    ),
    401,
    'LOGIN_REQUIRED',
  );
  for (const p of [hiddenProject, otherProject, randomUUID()]) {
    code(await call(primary(p), pm, choose()), 404, 'NOT_FOUND');
    code(await call(expectation(p), pm, calendar()), 404, 'NOT_FOUND');
  }
  code(await call(primary(), foreign, choose()), 404, 'NOT_FOUND');
  code(await call(expectation(), foreign, calendar()), 404, 'NOT_FOUND');
  const untouched = await counts();
  code(await call(primary(), reader, choose()), 403, 'READ_ONLY');
  code(await call(expectation(), reader, calendar()), 403, 'READ_ONLY');
  code(
    await call('/api/report/items', reader, {
      projectId: project,
      items: [{ kind: 'work', key: 'denied', label: 'TEST denied' }],
      clientMutationId: randomUUID(),
    }),
    403,
    'READ_ONLY',
  );
  for (const extra of [
    { orgId: otherOrg },
    { registeredAt: '1900-01-01T00:00:00Z' },
    { projectId: hiddenProject },
    { role: 'PROJECT_MANAGER' },
    { registeredBy: executive },
    { workdays: [] },
    { workdays: [1, 1] },
    { workdays: [0] },
    { workdays: [8] },
    { workdays: ['1'] },
    { fromDate: '2030-02-30' },
    { toDate: '2029-12-31' },
  ])
    code(
      await call(expectation(), pm, { ...calendar(), ...extra }),
      400,
      'INVALID_INPUT',
    );
  for (const extra of [
    { actor: executive },
    { orgId: otherOrg },
    { key: '' },
    { expectedVersion: '1' },
  ])
    code(
      await call(primary(), pm, { ...choose(), ...extra }),
      400,
      'INVALID_INPUT',
    );
  assert.deepEqual(await counts(), untouched);
  pass(
    '1b signed identity, reader write refusal, tenant/project isolation, invalid master/calendar inputs leave no audit/key/fact',
  );
  const item = (
    key: string,
    kind: ReportItemDto['kind'] = 'work',
    active = true,
  ): ReportItemDto => ({
    key,
    kind,
    label: `TEST ${key}`,
    unit: kind === 'milestone' ? '' : 'm',
    designQty: kind === 'milestone' ? '' : '100',
    openingCumulative: '',
    sortOrder: 0,
    active,
  });
  const save = async (
    items: ReportItemDto[],
    p = project,
    key = randomUUID(),
  ) =>
    call('/api/report/items', pm, {
      projectId: p,
      items,
      clientMutationId: key,
    });
  const initialItems = [
    item('work-1'),
    { ...item('work-2'), plannedDate: '2030-06-01' },
    item('inactive', 'work', false),
    item('machine', 'machinery'),
    { ...item('node', 'milestone'), plannedDate: '2030-02-01' },
  ];
  const saved = await save(initialItems);
  assert.equal(saved.status, 200);
  const items = () => call(`/api/report/items?projectId=${project}`, reader);
  const all = () =>
    items().then((r) => {
      assert.equal(r.status, 200);
      return r.data as unknown as ReportItemDto[];
    });
  assert.deepEqual(
    (await all()).find((i) => i.key === 'node'),
    initialItems[4],
  );
  assert.equal(
    (await all()).find((i) => i.key === 'work-2')!.plannedDate,
    '2030-06-01',
  );
  assert.ok(!(await all()).find((i) => i.key === 'work-1')!.plannedDate);
  assert.equal((await save([item('work-2')])).status, 200);
  assert.equal(
    (await all()).find((i) => i.key === 'work-2')!.plannedDate,
    '2030-06-01',
  );
  assert.equal(
    (await save([{ ...item('work-2'), plannedDate: null }])).status,
    200,
  );
  assert.equal(
    (await all()).find((i) => i.key === 'work-2')!.plannedDate,
    undefined,
  );
  for (const patch of [
    { unit: 'm' },
    { designQty: '0' },
    { plannedDate: '2030-02-30' },
  ])
    code(
      await save([{ ...item('bad-node', 'milestone'), ...patch }]),
      400,
      'INVALID_INPUT',
    );
  pass(
    'milestone unit/design quantity gate; date roundtrip, legacy omission preserves, explicit null clears',
  );
  const beforeInvalid = await counts();
  for (const key of ['absent', 'inactive', 'machine', 'node'])
    code(await call(primary(), pm, choose(1, key)), 404, 'ITEM_NOT_FOUND');
  assert.equal((await save([item('other-only')], emptyProject)).status, 200);
  const beforeForeignItem = await counts();
  code(
    await call(primary(), pm, choose(1, 'other-only')),
    404,
    'ITEM_NOT_FOUND',
  );
  assert.deepEqual(await counts(), beforeForeignItem);
  assert.equal(beforeInvalid.calendars, 0);
  const first = choose(),
    firstResponse = await call(primary(), pm, first);
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(firstResponse.data, {
    projectId: project,
    key: 'work-1',
    version: 2,
  });
  const afterFirst = await counts();
  assert.deepEqual((await call(primary(), pm, first)).data, firstResponse.data);
  assert.deepEqual(await counts(), afterFirst);
  code(
    await call(primary(), pm, { ...first, key: 'work-2' }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  code(
    await call(primary(emptyProject), pm, first),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  code(await call(primary(), pm, choose(1)), 409, 'VERSION_CONFLICT');
  pass(
    'primary item must be own active work; version CAS and same-key original acknowledgement replay',
  );
  async function holdProject() {
    holder = await owner!.connect();
    await holder.query('BEGIN');
    await holder.query(
      'SELECT id FROM "Project" WHERE id=$1 FOR NO KEY UPDATE',
      [project],
    );
  }
  async function blocked(expected: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await owner!.query<{ pid: number; xact_start: Date }>(
        "SELECT pid,xact_start FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%FROM \"Project\"%FOR NO KEY UPDATE%'",
        [username],
      );
      if (r.rows.length >= expected) return r.rows;
      await delay(20);
    }
    throw new Error(
      'TEST gate: actual HTTP backend did not wait at Project FOR NO KEY UPDATE',
    );
  }
  async function blockedProjectLock(
    mode: 'SHARE' | 'NO KEY UPDATE' | 'UPDATE',
    expected: number,
  ) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const r = await owner!.query<{ pid: number; query: string }>(
        `SELECT pid,query FROM pg_stat_activity
         WHERE usename=$1 AND wait_event_type='Lock'
           AND cardinality(pg_blocking_pids(pid))>0
           AND query LIKE $2`,
        [username, `%FROM "Project"%FOR ${mode}%`],
      );
      if (r.rows.length >= expected) return r.rows;
      await delay(20);
    }
    throw new Error(
      `TEST gate: actual HTTP backend did not wait at Project FOR ${mode}`,
    );
  }
  async function releaseProject() {
    assert.ok(holder);
    await holder.query('COMMIT');
    holder.release();
    holder = undefined;
  }
  await holdProject();
  const fkClient = await appPool!.connect();
  try {
    await fkClient.query('BEGIN');
    await fkClient.query("SELECT set_config('app.org_id',$1,true)", [org]);
    await fkClient.query("SET LOCAL lock_timeout='250ms'");
    await fkClient.query(
      'INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,"updatedBy") VALUES($1,$2,$3,\'work\',$4,\'TEST FK compatibility\',$5)',
      [randomUUID(), org, project, `fk-${randomUUID().slice(0, 8)}`, manager],
    );
    await fkClient.query('COMMIT');
  } catch (error) {
    await fkClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    fkClient.release();
    await releaseProject();
  }
  pass(
    'Project FOR NO KEY UPDATE remains compatible with child FK KEY SHARE inserts',
  );
  await holdProject();
  const races = [
    call(primary(), pm, choose(2, 'work-1')),
    call(primary(), pmTwin, choose(2, 'work-2')),
  ];
  pending.push(...races);
  await blocked(2);
  await releaseProject();
  const outcomes = await Promise.all(races);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
  code(
    outcomes.find((r) => r.status === 409)!,
    409,
    'VERSION_CONFLICT',
  );
  assert.equal(
    (await owner.query('SELECT version FROM "Project" WHERE id=$1', [project]))
      .rows[0].version,
    3,
  );
  const actorAudit = await owner.query(
    'SELECT "actorPersonId","actorAccountId","correlationId","after" FROM "AuditLog" WHERE "entityType"=\'PROJECT_MASTER\' ORDER BY "occurredAt"',
  );
  assert.equal(actorAudit.rows.length, 2);
  assert.ok(
    actorAudit.rows.every(
      (r) =>
        r.actorPersonId === person &&
        [manager, twin].includes(r.actorAccountId) &&
        r.correlationId === r.after.clientMutationId,
    ),
  );
  pass(
    'two real HTTP backends wait at Project lock; same-natural-person accounts produce one CAS success and one conflict with exact audit identity',
  );
  const c1 = calendar(),
    cal1 = await call(expectation(), pm, c1);
  assert.equal(cal1.status, 200);
  assert.equal(cal1.data.n, 1);
  const afterCalendar = await counts();
  assert.deepEqual((await call(expectation(), pm, c1)).data, cal1.data);
  assert.deepEqual(await counts(), afterCalendar);
  code(
    await call(expectation(), pm, { ...c1, workdays: [6, 7] }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  code(
    await call(expectation(emptyProject), pm, c1),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  await holdProject();
  const calendars = [
    call(expectation(), pm, calendar()),
    call(expectation(), pmTwin, {
      ...calendar(),
      fromDate: '2030-01-02',
      toDate: '2030-02-02',
      workdays: [7, 1],
    }),
  ];
  pending.push(...calendars);
  await blocked(2);
  await releaseProject();
  const cs = await Promise.all(calendars);
  assert.ok(cs.every((r) => r.status === 200));
  assert.deepEqual(cs.map((r) => r.data.n).sort(), [2, 3]);
  const calendarRows = await owner.query(
    'SELECT n,"fromDate"::text,"toDate"::text,workdays,"registeredAt" FROM "ReportingExpectationVersion" WHERE "projectId"=$1 ORDER BY n',
    [project],
  );
  assert.equal(calendarRows.rows.length, 3);
  assert.deepEqual(calendarRows.rows[0].workdays, c1.workdays);
  assert.equal(
    calendarRows.rows[0].registeredAt.toISOString(),
    cal1.data.registeredAt,
  );
  assert.deepEqual(
    calendarRows.rows.find((r) => r.fromDate === '2030-01-02')!.workdays,
    [7, 1],
  );
  pass(
    'append-only calendar serial numbers under actual competing HTTP transactions; original timestamp and weekday order replay exactly',
  );
  // D11: controlled real SQL lock wait. Offset maps the captured transaction start to a
  // synthetic site-midnight boundary; it does not alter any host/database clock or site fact.
  await holdProject();
  const clockCall = call(expectation(), pm, calendar());
  pending.push(clockCall);
  const waiting = await blocked(1);
  await delay(750);
  const releaseAt = (
    await owner.query<{ at: Date }>('SELECT clock_timestamp() AS at')
  ).rows[0]!.at;
  await releaseProject();
  const clockResponse = await clockCall;
  assert.equal(clockResponse.status, 200);
  const insertedAt = new Date(clockResponse.data.registeredAt!).getTime(),
    started = waiting[0]!.xact_start.getTime();
  assert.ok(
    insertedAt >= releaseAt.getTime(),
    'registration clock must be read after Project lock release',
  );
  assert.ok(
    insertedAt - started >= 700,
    'registration must not use transaction-start now()',
  );
  const offset = Date.parse('2030-01-01T23:59:59.800Z') - started;
  assert.equal(
    new Date(started + offset).toISOString().slice(0, 10),
    '2030-01-01',
  );
  assert.equal(
    new Date(insertedAt + offset).toISOString().slice(0, 10),
    '2030-01-02',
  );
  console.log(
    `D11 TEST actual lock wait ms=${insertedAt - started}; offset boundary=2030-01-01->2030-01-02 (synthetic, no clock mutation)`,
  );
  pass(
    '4b database insertion clock after real Project lock, with uniform-offset synthetic midnight boundary',
  );
  await holdProject();
  const itemCall = save([{ ...item('work-1'), plannedDate: '2030-07-01' }]);
  pending.push(itemCall);
  await blocked(1);
  await releaseProject();
  assert.equal((await itemCall).status, 200);
  assert.equal(
    (await all()).find((i) => i.key === 'work-1')!.plannedDate,
    '2030-07-01',
  );
  pass('saveItems also waits at Project lock before master reads/writes');

  const revisionSnapshot = async (businessDate: string) => {
    const result = await owner!.query<{ snapshot: Record<string, unknown> }>(
      `SELECT r.snapshot FROM "DailyClose" d
       JOIN "Revision" r ON r."dailyCloseId"=d.id
         AND r."revisionNumber"=d."currentRevisionNumber"
       WHERE d."projectId"=$1 AND d."businessDate"=$2`,
      [project, businessDate],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0]!.snapshot;
  };
  const controlledSnapshotRace = async (
    route: 'submit' | 'no-work',
    mutation: 'primary' | 'milestone',
    order: 'edit-first' | 'snapshot-first',
    businessDate: string,
  ) => {
    const currentMaster = await owner!.query<{
      primaryWorkItemKey: string | null;
      plannedDate: string | null;
    }>(
      `SELECT p."primaryWorkItemKey", i."plannedDate"::text AS "plannedDate"
       FROM "Project" p
       JOIN "ReportItem" i ON i."orgId"=p."orgId" AND i."projectId"=p.id
       WHERE p.id=$1 AND i.key='node' AND i.kind='milestone'`,
      [project],
    );
    assert.equal(currentMaster.rows.length, 1);
    const beforePrimary = currentMaster.rows[0]!.primaryWorkItemKey;
    assert.ok(beforePrimary === 'work-1' || beforePrimary === 'work-2');
    const beforeMilestoneDate = currentMaster.rows[0]!.plannedDate;
    assert.ok(
      beforeMilestoneDate === '2030-02-01' ||
        beforeMilestoneDate === '2030-08-01',
    );
    const afterPrimary = beforePrimary === 'work-1' ? 'work-2' : 'work-1';
    const afterMilestoneDate =
      beforeMilestoneDate === '2030-02-01' ? '2030-08-01' : '2030-02-01';
    const snapshotRequest = () => {
      const request = {
        projectId: project,
        businessDate,
        expectedVersion: 0,
        clientMutationId: randomUUID(),
        ...(route === 'no-work' ? { reason: 'weather', note: 'TEST' } : {}),
      };
      return call(`/api/report/${route}`, pm, request);
    };
    const masterEdit = async () => {
      if (mutation === 'primary') {
        const version = Number(
          (
            await owner!.query('SELECT version FROM "Project" WHERE id=$1', [
              project,
            ])
          ).rows[0].version,
        );
        return call(primary(), pm, choose(version, afterPrimary));
      }
      return save([
        item('work-1'),
        { ...item('work-2'), plannedDate: '2030-06-01' },
        item('inactive', 'work', false),
        item('machine', 'machinery'),
        {
          ...item('node', 'milestone'),
          plannedDate: afterMilestoneDate,
        },
      ]);
    };
    await holdProject();
    let snap: Promise<{ status: number; data: Wire }> | undefined;
    let edit: Promise<{ status: number; data: Wire }> | undefined;
    if (order === 'edit-first') {
      edit = masterEdit();
      pending.push(edit);
      await blockedProjectLock('NO KEY UPDATE', 1);
      snap = snapshotRequest();
      pending.push(snap);
      await blockedProjectLock('SHARE', 1);
    } else {
      snap = snapshotRequest();
      pending.push(snap);
      await blockedProjectLock('SHARE', 1);
      edit = masterEdit();
      pending.push(edit);
      await blockedProjectLock('NO KEY UPDATE', 1);
    }
    await releaseProject();
    const responses = await Promise.all([snap!, edit!]);
    assert.ok(responses.every((r) => r.status === 200));
    const frozen = await revisionSnapshot(businessDate);
    const frozenPrimary = frozen.primaryWorkItemKey;
    const frozenMilestoneDate = (
      frozen.milestones as Array<Record<string, unknown>>
    ).find((m) => m.key === 'node')?.plannedDate;
    if (mutation === 'primary') {
      assert.equal(frozenMilestoneDate, beforeMilestoneDate);
      assert.ok(
        frozenPrimary === beforePrimary ||
          (order === 'edit-first' && frozenPrimary === afterPrimary),
      );
    } else {
      assert.equal(frozenPrimary, beforePrimary);
      assert.ok(
        frozenMilestoneDate === beforeMilestoneDate ||
          (order === 'edit-first' &&
            frozenMilestoneDate === afterMilestoneDate),
      );
    }
  };
  let raceDate = 1;
  for (const route of ['submit', 'no-work'] as const) {
    for (const mutation of ['primary', 'milestone'] as const) {
      for (const order of ['edit-first', 'snapshot-first'] as const) {
        await controlledSnapshotRace(
          route,
          mutation,
          order,
          `2040-01-0${raceDate++}`,
        );
      }
    }
    pass(
      `C19 controlled ${route} snapshots serialize one primary or milestone edit as a complete before/after value`,
    );
  }
  assert.ok(
    events.filter((e) => e === 'project-status.primary-ack').length >= 3,
  );
  assert.ok(
    events.filter((e) => e === 'project-status.expectation-ack').length >= 5,
  );
  const stateBeforeRevoked = await counts();
  await owner.query(
    'UPDATE "Membership" SET role=\'EXECUTIVE_READER\' WHERE id=$1',
    [managerMembership],
  );
  code(await call(primary(), pm, first), 403, 'READ_ONLY');
  code(await call(expectation(), pm, c1), 403, 'READ_ONLY');
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()-interval \'1 second\' WHERE id=$1',
    [managerMembership],
  );
  code(await call(primary(), pm, first), 404, 'NOT_FOUND');
  code(await call(expectation(), pm, c1), 404, 'NOT_FOUND');
  assert.equal(
    (await call(expectation(emptyProject), pm, calendar())).status,
    200,
  );
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()-interval \'1 second\' WHERE id=$1',
    [executiveMembership],
  );
  code(await items(), 403, 'FORBIDDEN');
  assert.equal(
    (await call(`/api/report/items?projectId=${emptyProject}`, reader)).status,
    200,
  );
  assert.equal((await counts()).keys, stateBeforeRevoked.keys + 1);
  pass(
    'demotion and project-specific revocation checked before replay, other project membership remains usable; revoked GET is denied',
  );
  async function rejects(
    client: PoolClient,
    sql: string,
    args: unknown[],
    expected: string,
  ) {
    await client.query('SAVEPOINT negative');
    let caught: unknown;
    try {
      await client.query(sql, args);
    } catch (e) {
      caught = e;
    }
    await client.query('ROLLBACK TO SAVEPOINT negative');
    assert.equal((caught as { code?: string })?.code, expected);
  }
  const appClient = await appPool.connect();
  try {
    await appClient.query('BEGIN');
    await appClient.query("SELECT set_config('app.org_id',$1,true)", [org]);
    assert.equal(
      (
        await appClient.query(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0].rolbypassrls,
      false,
    );
    await appClient.query(
      'SELECT id FROM "Project" WHERE id=$1 FOR NO KEY UPDATE',
      [project],
    );
    await appClient.query(
      'UPDATE "Project" SET region=\'TEST region\',"projectType"=\'TEST type\' WHERE id=$1',
      [project],
    );
    for (const col of ['code', 'timezone', 'status'])
      await rejects(
        appClient,
        `UPDATE "Project" SET "${col}"="${col}" WHERE id=$1`,
        [project],
        '42501',
      );
    await rejects(
      appClient,
      'UPDATE "ReportingExpectationVersion" SET n=n',
      [],
      '42501',
    );
    await rejects(
      appClient,
      'DELETE FROM "ReportingExpectationVersion"',
      [],
      '42501',
    );
    assert.equal(
      (
        await appClient.query(
          'SELECT id FROM "ReportingExpectationVersion" WHERE "orgId"=$1',
          [otherOrg],
        )
      ).rows.length,
      0,
    );
    const insert =
      'INSERT INTO "ReportingExpectationVersion"(id,"orgId","projectId",n,"fromDate","toDate",workdays,"registeredBy") VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8)';
    await rejects(
      appClient,
      insert,
      [randomUUID(), otherOrg, otherProject, 1, '2030-01-01', null, [1], other],
      '42501',
    );
    await rejects(
      appClient,
      insert,
      [randomUUID(), org, otherProject, 100, '2030-01-01', null, [1], manager],
      '23503',
    );
    await rejects(
      appClient,
      insert,
      [randomUUID(), org, project, 100, '2030-01-01', null, [1], other],
      '23503',
    );
    for (const [from, to, days] of [
      ['2030-02-01', '2030-01-01', [1]],
      ['2030-01-01', null, []],
      ['2030-01-01', null, [1, 1]],
      ['2030-01-01', null, [8]],
      ['2030-01-01', null, [null]],
      [
        '2030-01-01',
        null,
        [
          [1, 2],
          [3, 4],
        ],
      ],
    ])
      await rejects(
        appClient,
        insert,
        [randomUUID(), org, project, 100, from, to, days, manager],
        '23514',
      );
  } finally {
    try {
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }
  }
  const privileged = await owner.connect();
  try {
    await privileged.query('BEGIN');
    await rejects(
      privileged,
      'UPDATE "ReportingExpectationVersion" SET n=n',
      [],
      'P0001',
    );
    await rejects(
      privileged,
      'DELETE FROM "ReportingExpectationVersion"',
      [],
      'P0001',
    );
    await rejects(
      privileged,
      "UPDATE \"ReportItem\" SET unit='m' WHERE kind='milestone'",
      [],
      '23514',
    );
    await rejects(
      privileged,
      'UPDATE "ReportItem" SET "designQty"=\'0\' WHERE kind=\'milestone\'',
      [],
      '23514',
    );
    await rejects(
      privileged,
      'UPDATE "ReportItem" SET kind=\'not-a-kind\'',
      [],
      '23514',
    );
  } finally {
    try {
      await privileged.query('ROLLBACK');
    } finally {
      privileged.release();
    }
  }
  pass(
    '12a minimum Project column grants, tenant RLS/FKs, owner append-only trigger, database date/weekday/milestone constraints',
  );
  const final = await counts();
  assert.equal(final.audits, final.keys);
  const calendarAudits = await owner.query(
    'SELECT "correlationId","after" FROM "AuditLog" WHERE "entityType"=\'REPORTING_EXPECTATION\'',
  );
  assert.equal(calendarAudits.rows.length, 5);
  assert.ok(
    calendarAudits.rows.every(
      (r) => r.correlationId === r.after.clientMutationId,
    ),
  );
  pass(
    'each successful command has exactly one audit and idempotency record; no rollback/history rewrite',
  );
  console.log(
    `Project master: ${checks} checks; bounded protocol RETRY responses=${retries}; TEST suffix=${suffix}`,
  );
} catch (e) {
  failed = true;
  failure = e;
} finally {
  observeProjectStatusProjections(null);
  const attempt = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      cleanupErrors.push(e);
    }
  };
  if (holder) {
    await attempt(() => holder!.query('ROLLBACK'));
    holder.release();
  }
  await attempt(() => Promise.allSettled(pending));
  if (app) await attempt(() => app!.close());
  for (const pool of [appPool, owner])
    if (pool) {
      closing.add(pool);
      await attempt(() => pool.end());
    }
  if (dbCreated)
    await attempt(() =>
      admin.query(`DROP DATABASE "${database}" WITH (FORCE)`),
    );
  if (roleCreated) await attempt(() => admin.query(`DROP ROLE "${username}"`));
  closing.add(admin);
  await attempt(() => admin.end());
}
if (failed || cleanupErrors.length)
  throw new AggregateError(
    [...(failed ? [failure] : []), ...cleanupErrors],
    'Project master TEST failed or cleanup incomplete',
  );
