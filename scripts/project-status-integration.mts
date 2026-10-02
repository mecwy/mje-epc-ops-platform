/** A7-1a: signed HTTP + non-bypass application role, isolated synthetic TEST DB. */
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
} from '../packages/domain/dist/index.js';
import { observeProjectStatusProjections } from '../packages/domain/dist/project-status/reader.js';
import type {
  DeclareStatusCommand,
  ProjectStatusHistoryDto,
  StatusCommandResultDto,
  ProjectStatus,
} from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import { assertLocalDatabase } from './local-db.mjs';

const raw = process.env['DATABASE_URL'];
assert.ok(raw);
const source = assertLocalDatabase(raw),
  suffix = randomBytes(6).toString('hex');
const database = `mje_status_test_${suffix}`,
  username = `mje_status_${suffix}`;
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
type Body = Omit<DeclareStatusCommand, 'projectId'>;
type Wire = Partial<StatusCommandResultDto & ProjectStatusHistoryDto> & {
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
  const path = (p = project) => `/api/projects/${p}/status`;
  function command(
    expectedN: number,
    status: ProjectStatus = 'NORMAL',
    overrides: Partial<Body> = {},
  ): Body {
    return {
      expectedN,
      clientMutationId: randomUUID(),
      status,
      areas: status === 'NORMAL' || status === 'PAUSED' ? [] : ['SCHEDULE'],
      situation: status === 'NORMAL' ? '' : 'TEST 原始情况 ',
      recovery:
        status === 'AT_RISK' || status === 'OFF_TRACK'
          ? ' TEST recovery\n'
          : '',
      expectedRecoveryDate: null,
      expectedRecoveryUnknown: status !== 'NORMAL',
      needsSupport: false,
      supportNote: '',
      ...overrides,
    };
  }
  function code(
    result: { status: number; data: Wire },
    status: number,
    expected: string,
    fields = false,
  ) {
    assert.equal(result.status, status);
    assert.equal(result.data.code, expected);
    assert.match(result.data.correlationId ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      Object.keys(result.data).sort(),
      (fields
        ? ['code', 'correlationId', 'fields']
        : ['code', 'correlationId']
      ).sort(),
    );
  }
  async function counts() {
    const r = await owner!.query<{
      updates: number;
      notes: number;
      audits: number;
      keys: number;
    }>(
      'SELECT (SELECT count(*)::int FROM "ProjectStatusUpdate") AS updates,(SELECT count(*)::int FROM "ProjectStatusNote") AS notes,(SELECT count(*)::int FROM "AuditLog" WHERE "entityType" LIKE \'PROJECT_STATUS_%\') AS audits,(SELECT count(*)::int FROM "IdempotencyRecord") AS keys',
    );
    return r.rows[0]!;
  }
  const events: string[] = [];
  const oldNodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'test';
  observeProjectStatusProjections((name) => events.push(name));
  if (oldNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = oldNodeEnv;
  code(await call(path(), undefined), 401, 'LOGIN_REQUIRED');
  code(
    await call(path(), await token(object, 'https://example.invalid')),
    401,
    'LOGIN_REQUIRED',
  );
  const initial = await call(path(emptyProject), pm);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, {
    projectId: emptyProject,
    currentN: 0,
    updates: [],
  });
  pass('signed HTTP authentication and authorized empty history (n=0)');
  for (const p of [hiddenProject, otherProject, randomUUID()]) {
    code(await call(path(p), pm), 404, 'NOT_FOUND');
    code(await call(path(p), pm, command(0)), 404, 'NOT_FOUND');
    code(
      await call(path(p) + '/1/notes', pm, {
        clientMutationId: randomUUID(),
        text: 'TEST note',
      }),
      404,
      'NOT_FOUND',
    );
  }
  code(await call(path(), foreign), 404, 'NOT_FOUND');
  pass(
    'tenant and project isolation: absent and unauthorized paths have identical safe envelopes',
  );
  const untouched = await counts();
  code(await call(path(), reader, command(0)), 403, 'READ_ONLY');
  for (const extra of [
    { orgId: otherOrg },
    { declaredBy: executive },
    { declaredAt: '1900-01-01T00:00:00Z' },
    { projectId: hiddenProject },
    { role: 'PROJECT_MANAGER' },
    { businessDate: '1900-01-01' },
  ])
    code(
      await call(path(), pm, { ...command(0), ...extra }),
      400,
      'INVALID_INPUT',
    );
  assert.deepEqual(await counts(), untouched);
  pass(
    '1a writer gate and rejection of client authority/clock injection before any write',
  );
  const invalid: Body[] = [
    command(0, 'AT_RISK', { areas: [] }),
    command(0, 'AT_RISK', { situation: ' \n\t' }),
    command(0, 'AT_RISK', { recovery: '' }),
    command(0, 'OFF_TRACK', { areas: [] }),
    command(0, 'OFF_TRACK', { situation: '' }),
    command(0, 'OFF_TRACK', { recovery: ' ' }),
    command(0, 'PAUSED', { situation: '' }),
    command(0, 'NORMAL', { needsSupport: true }),
    command(0, 'NORMAL', { expectedRecoveryDate: '2030-01-01' }),
    command(0, 'NORMAL', { expectedRecoveryUnknown: true }),
    command(0, 'NORMAL', { areas: ['SAFETY'] }),
    command(0, 'NORMAL', { supportNote: 'TEST sensitive rejected content' }),
  ];
  for (const state of ['AT_RISK', 'OFF_TRACK', 'PAUSED'] as const) {
    invalid.push(
      command(0, state, { expectedRecoveryUnknown: false }),
      command(0, state, { expectedRecoveryDate: '2030-01-01' }),
    );
  }
  for (const c of invalid) {
    const rejected = await call(path(), pm, c);
    code(rejected, 409, 'STATUS_FIELDS_REQUIRED', true);
    assert.ok(rejected.data.fields?.length);
    assert.ok(
      rejected.data.fields.every((f) =>
        [
          'areas',
          'situation',
          'recovery',
          'expectedRecoveryDate',
          'expectedRecoveryUnknown',
          'needsSupport',
          'supportNote',
        ].includes(f),
      ),
    );
    assert.ok(!JSON.stringify(rejected.data).includes('TEST'));
  }
  assert.deepEqual(await counts(), untouched);
  pass(
    '2 conditional fields and date/unknown exclusivity, no declaration/audit/idempotency rows on refusal',
  );
  const first = command(0);
  const response = await call(path(), pm, first);
  assert.equal(response.status, 200);
  assert.equal(response.data.n, 1);
  const afterFirst = await counts();
  const replay = await call(path(), pm, first);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, response.data);
  assert.deepEqual(await counts(), afterFirst);
  code(
    await call(path(), pm, { ...first, situation: 'TEST changed body' }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  code(
    await call(path(emptyProject), pm, first),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  const firstId = response.data.statusUpdateId;
  assert.ok(firstId);
  assert.deepEqual(afterFirst, { updates: 1, notes: 0, audits: 1, keys: 1 });
  pass(
    '9 response-loss retry returns identical acknowledgement with one declaration and audit',
  );
  const note = {
    clientMutationId: randomUUID(),
    text: ' TEST executive reply\n',
  };
  const noteResponse = await call(path() + '/1/notes', reader, note);
  assert.equal(noteResponse.status, 200);
  assert.equal(
    (
      await call(path() + '/1/notes', pm, {
        clientMutationId: randomUUID(),
        text: 'TEST manager reply',
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await call(path() + '/1/notes', reader, note)).data,
    noteResponse.data,
  );
  code(
    await call(path() + '/99/notes', reader, {
      clientMutationId: randomUUID(),
      text: 'TEST missing target',
    }),
    404,
    'NOT_FOUND',
  );
  const hist = (await call(path(), reader)).data as ProjectStatusHistoryDto;
  assert.equal(hist.updates[0]!.notes[0]!.text, note.text);
  assert.equal(hist.updates[0]!.notes[0]!.byPersonId, readerPerson);
  assert.equal(hist.updates[0]!.declaredBy, manager);
  assert.equal(hist.updates[0]!.declaredByPersonId, person);
  const oldHeader = { ...hist.updates[0]!, notes: [] };
  const frozen = await owner.query<{
    at: string;
    business: string;
    timezone: string;
  }>(
    'SELECT "declaredAt"::text AS at,("declaredAt" AT TIME ZONE "siteTimezone")::date::text AS business,"siteTimezone" AS timezone FROM "ProjectStatusUpdate" WHERE id=$1',
    [firstId],
  );
  assert.equal(hist.updates[0]!.businessDate, frozen.rows[0]!.business);
  assert.equal(hist.updates[0]!.siteTimezone, 'Pacific/Kiritimati');
  assert.equal(
    hist.updates[0]!.declaredAt,
    new Date(frozen.rows[0]!.at).toISOString(),
  );
  pass(
    '1a executives and managers append replies; server UTC/site day and account/person provenance retained',
  );
  await owner.query(
    'UPDATE "Membership" SET role=\'EXECUTIVE_READER\' WHERE id=$1',
    [managerMembership],
  );
  code(await call(path(), pm, first), 403, 'READ_ONLY');
  await owner.query(
    'UPDATE "Membership" SET role=\'PROJECT_MANAGER\' WHERE id=$1',
    [managerMembership],
  );
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now()-interval \'1 day\' WHERE id=$1',
    [executiveMembership],
  );
  const beforeRevokedReplay = await counts();
  code(await call(path() + '/1/notes', reader, note), 403, 'FORBIDDEN');
  assert.deepEqual(await counts(), beforeRevokedReplay);
  await owner.query('UPDATE "Membership" SET "activeUntil"=NULL WHERE id=$1', [
    executiveMembership,
  ]);
  const acknowledgements = events.filter(
    (x) => x === 'project-status.ack',
  ).length;
  assert.equal((await call(path() + '/1/notes', reader, note)).status, 200);
  assert.equal(
    events.filter((x) => x === 'project-status.ack').length,
    acknowledgements + 1,
  );
  assert.ok(events.includes('project-status.history'));
  pass(
    '9 current authorization before replay, live/replay acknowledgements and GET consume registered projections',
  );
  holder = await owner.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM "Project" WHERE id=$1 FOR NO KEY UPDATE', [
    project,
  ]);
  const a = call(path(), pm, command(1)),
    b = call(path(), pmTwin, command(1));
  pending.push(a, b);
  const deadline = Date.now() + 3500;
  let waiting = 0;
  do {
    waiting = (
      await owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%FROM \"Project\"%FOR NO KEY UPDATE%'",
        [username],
      )
    ).rows[0]!.n;
    if (waiting === 2) break;
    await delay(20);
  } while (Date.now() < deadline);
  assert.equal(waiting, 2, 'both actual commands reached the project lock');
  await holder.query('COMMIT');
  holder.release();
  holder = undefined;
  const pair = await Promise.all([a, b]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]);
  code(
    pair.find((r) => r.status === 409)!,
    409,
    'VERSION_CONFLICT',
  );
  const twins = await owner.query<{ person: string }>(
    'SELECT "declaredByPersonId" AS person FROM "ProjectStatusUpdate" WHERE "projectId"=$1 ORDER BY n',
    [project],
  );
  assert.ok(twins.rows.every((r) => r.person === person));
  pass(
    '3 controlled simultaneous expectedN: one append, one conflict; same person across two accounts',
  );
  let n = 2;
  // Explicitly cover all 16 ordered pairs, including each same-state declaration.
  for (const from of ['NORMAL', 'AT_RISK', 'OFF_TRACK', 'PAUSED'] as const)
    for (const to of ['NORMAL', 'AT_RISK', 'OFF_TRACK', 'PAUSED'] as const) {
      for (const status of [from, to]) {
        const r = await call(path(), pm, command(n, status));
        assert.equal(r.status, 200);
        assert.equal(r.data.n, ++n);
      }
    }
  const dated = command(n, 'AT_RISK', {
    expectedRecoveryDate: '2030-02-28',
    expectedRecoveryUnknown: false,
    needsSupport: true,
    supportNote: ' TEST requested support\n',
  });
  const datedResponse = await call(path(), pm, dated);
  assert.equal(datedResponse.status, 200);
  n++;
  const page1 = (await call(path(), reader)).data as ProjectStatusHistoryDto,
    page2 = (await call(path() + '?page=2', reader))
      .data as ProjectStatusHistoryDto;
  assert.equal(page1.currentN, n);
  assert.equal(page1.updates.length, 20);
  assert.equal(page2.currentN, n);
  assert.equal(page2.updates.length, n - 20);
  assert.deepEqual(
    [...page1.updates, ...page2.updates].map((r) => r.n),
    Array.from({ length: n }, (_, i) => n - i),
  );
  assert.deepEqual({ ...page2.updates.at(-1)!, notes: [] }, oldHeader);
  assert.equal(page2.updates.at(-1)!.notes.length, 2);
  assert.equal(page1.updates[0]!.situation, dated.situation);
  assert.equal(page1.updates[0]!.recovery, dated.recovery);
  assert.equal(page1.updates[0]!.supportNote, dated.supportNote);
  assert.equal(
    page1.updates[0]!.expectedRecoveryDate,
    dated.expectedRecoveryDate,
  );
  assert.equal(page1.updates[0]!.expectedRecoveryUnknown, false);
  assert.deepEqual((await call(path() + '?page=3', reader)).data, {
    projectId: project,
    currentN: n,
    updates: [],
  });
  code(await call(path() + '?page=0', reader), 400, 'INVALID_INPUT');
  pass(
    '5a all 16 transitions and repeats accepted; paginated immutable history, original strings and known/unknown dates',
  );
  assert.equal(
    (await call(path(otherProject), foreign, command(0))).status,
    200,
  );
  const tx = await appPool.connect();
  async function rejects(
    client: PoolClient,
    sql: string,
    args: unknown[],
    expected: string,
  ) {
    await client.query('SAVEPOINT negative');
    let err: unknown;
    try {
      await client.query(sql, args);
    } catch (e) {
      err = e;
    }
    await client.query('ROLLBACK TO SAVEPOINT negative');
    assert.ok(err && typeof err === 'object' && 'code' in err);
    assert.equal(err.code, expected);
  }
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.org_id',$1,true)", [org]);
    assert.equal(
      (
        await tx.query(
          'SELECT id FROM "Project" WHERE "orgId"=$1 AND id=$2 FOR UPDATE',
          [org, project],
        )
      ).rowCount,
      1,
    );
    for (const column of ['code', 'timezone'])
      await rejects(
        tx,
        `UPDATE "Project" SET "${column}"=$1 WHERE id=$2`,
        ['TEST invalid', project],
        '42501',
      );
    for (const table of ['ProjectStatusUpdate', 'ProjectStatusNote']) {
      await rejects(tx, `UPDATE "${table}" SET id=id`, [], '42501');
      await rejects(tx, `DELETE FROM "${table}"`, [], '42501');
    }
    const foreignRows = await tx.query(
      'SELECT id FROM "ProjectStatusUpdate" WHERE "orgId"=$1',
      [otherOrg],
    );
    assert.equal(foreignRows.rowCount, 0);
    await rejects(
      tx,
      'INSERT INTO "ProjectStatusNote"(id,"orgId","projectId","statusUpdateId",text,"byAccountId","byPersonId") VALUES($1,$2,$3,$4,\'TEST illegal cross-project\',$5,$6)',
      [randomUUID(), org, hiddenProject, firstId, manager, person],
      '23503',
    );
    await rejects(
      tx,
      'INSERT INTO "ProjectStatusNote"(id,"orgId","projectId","statusUpdateId",text,"byAccountId","byPersonId") VALUES($1,$2,$3,$4,\'TEST illegal cross-tenant\',$5,$6)',
      [randomUUID(), otherOrg, otherProject, firstId, other, otherPerson],
      '42501',
    );
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  const privileged = await owner.connect();
  try {
    await privileged.query('BEGIN');
    for (const table of ['ProjectStatusUpdate', 'ProjectStatusNote']) {
      await rejects(privileged, `UPDATE "${table}" SET id=id`, [], 'P0001');
      await rejects(privileged, `DELETE FROM "${table}"`, [], 'P0001');
    }
    // All inserts select the valid first declaration and change just a consequential field.
    await rejects(
      privileged,
      'INSERT INTO "ProjectStatusUpdate" SELECT $1,"orgId","projectId",1000,\'AT_RISK\',areas,situation,recovery,"expectedRecoveryDate","expectedRecoveryUnknown","needsSupport","supportNote","declaredAt","siteTimezone","businessDate","declaredBy","declaredByPersonId" FROM "ProjectStatusUpdate" WHERE id=$2',
      [randomUUID(), firstId],
      '23514',
    );
  } finally {
    await privileged.query('ROLLBACK');
    privileged.release();
  }
  pass(
    '4a least grants, app row lock, tenant RLS/FKs, owner append-only triggers and DB conditional CHECK',
  );
  const finalCounts = await counts();
  assert.deepEqual(finalCounts, {
    updates: n + 1,
    notes: 2,
    audits: n + 3,
    keys: n + 3,
  });
  pass(
    'all writes have exactly one audit and idempotency row; safe rejections have none',
  );
  console.log(
    `Project status: ${checks} checks; bounded protocol RETRY responses=${retries}; TEST suffix=${suffix}`,
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
    'Project status TEST failed or cleanup incomplete',
  );
