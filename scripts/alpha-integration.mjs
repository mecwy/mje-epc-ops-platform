import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { AlphaStore } from '../packages/domain/dist/index.js';
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
const database = `mje_alpha_test_${suffix}`;
const username = `mje_test_${suffix}`;
const password = randomBytes(24).toString('hex');
const admin = new Pool({ connectionString: source.toString() });
// pool.end() resolves before idle sockets finish closing; DROP DATABASE ... WITH (FORCE) can
// then terminate one (57P01) and the pool would re-emit it as an unhandled 'error'. Only that
// shutdown termination is ignored; any other pool error still fails the run.
const tolerateShutdown = (pool) =>
  pool.on('error', (error) => {
    if (error?.code !== '57P01') throw error;
  });
const isolated = new URL(source);
isolated.pathname = `/${database}`;
let owner, appPool, app;
let dbCreated = false,
  roleCreated = false,
  restoreCreated = false,
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
    new Pool({ connectionString: appUrl.toString(), max: 4 }),
  );
  const tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID();
  const personA = randomUUID(),
    orgA = randomUUID(),
    orgB = randomUUID();
  const projectA = randomUUID(),
    projectB = randomUUID(),
    hiddenProject = randomUUID();
  const accountA = randomUUID(),
    accountB = randomUUID(),
    accountTwin = randomUUID();
  const objectA = randomUUID(),
    objectB = randomUUID(),
    objectTwin = randomUUID();
  const actor = randomUUID();
  for (const [orgId, name] of [
    [orgA, 'TEST Organization A'],
    [orgB, 'TEST Organization B'],
  ]) {
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [orgId, name, actor],
    );
  }
  const personB = randomUUID();
  for (const [id, orgId] of [
    [personA, orgA],
    [personB, orgB],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST Person\')',
      [id, orgId, actor],
    );
  for (const [id, orgId, code] of [
    [projectA, orgA, 'TEST-A'],
    [hiddenProject, orgA, 'TEST-HIDDEN'],
    [projectB, orgB, 'TEST-B'],
  ]) {
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,\'Europe/Belgrade\',\'ACTIVE\')',
      [id, orgId, actor, code],
    );
  }
  for (const [id, orgId, personId, objectId, projectId] of [
    [accountA, orgA, personA, objectA, projectA],
    [accountTwin, orgA, personA, objectTwin, projectA],
    [accountB, orgB, personB, objectB, projectB],
  ]) {
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, orgId, actor, tenantId, objectId, personId],
    );
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'ALPHA_OWNER\',now(),$4,$5)',
      [randomUUID(), orgId, actor, id, projectId],
    );
  }
  const keys = await generateKeyPair('RS256');
  const key = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'RS256',
    kid: 'TEST',
  };
  const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
  const verifier = new TokenVerifier(auth, createLocalJWKSet({ keys: [key] }));
  app = await createApp({ auth, verifier, store: new AlphaStore(appPool) });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function token(oid, overrides = {}) {
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
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .sign(keys.privateKey);
  }
  const bearerA = await token(objectA),
    bearerB = await token(objectB),
    bearerTwin = await token(objectTwin);
  async function call(path, bearer, body) {
    return fetch(base + path, {
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
  }
  function command(projectId = projectA) {
    return {
      recordId: randomUUID(),
      projectId,
      expectedVersion: 0,
      baseRevisionNumber: null,
      clientMutationId: randomUUID(),
      action: 'SAVE_VERSION',
      reason: '',
      declaration: {
        businessDate: '2026-10-25',
        deviceRecordedAt: '2026-10-26T00:30:00+01:00',
        workItems: [
          {
            id: randomUUID(),
            area: 'TEST area',
            description: 'TEST initial work',
            quantity: { state: 'VALUE', value: '0.000000' },
            unit: 'TEST unit',
          },
        ],
        reportedHeadcount: { state: 'UNKNOWN', value: null },
        headcountNote: '',
        issues: '',
        tomorrow: {
          targetBusinessDate: '2026-10-26',
          text: 'TEST next-day plan',
        },
      },
    };
  }
  assert.equal((await call('/api/projects')).status, 401);
  assert.equal(
    (await call('/api/projects', await token(randomUUID()))).status,
    403,
  );
  assert.equal(
    (
      await call(
        '/api/projects',
        await token(objectA, { iss: 'https://example.invalid' }),
      )
    ).status,
    401,
  );
  pass(
    'HTTP authentication: unsigned, wrong issuer and unauthorized account denied',
  );
  const projects = await (await call('/api/projects', bearerA)).json();
  assert.deepEqual(
    projects.projects.map((p) => p.id),
    [projectA],
  );
  assert.equal(
    (await call(`/api/site-days?projectId=${hiddenProject}`, bearerA)).status,
    403,
  );
  assert.equal(
    (await call('/api/site-days/save', bearerA, command(projectB))).status,
    403,
  );
  assert.equal(
    (await call('/api/site-days/save', bearerA, { ...command(), orgId: orgB }))
      .status,
    400,
  );
  pass(
    'HTTP project and organization isolation; forged authority fields rejected',
  );
  const original = command();
  original.declaration.reportedSections = {
    originalRecorder: '',
    weather: 'TEST mixed',
    temperature: '',
    reportedDuration: '',
    sourceNote: 'TEST manual declaration',
    progress: [
      {
        id: randomUUID(),
        item: 'TEST rail',
        scopeCandidate: 'TEST area candidate',
        unit: '套',
        today: { state: 'VALUE', value: '0' },
        cumulative: { state: 'BLANK', value: null },
        designTotal: { state: 'UNKNOWN', value: null },
        reportedPercent: { state: 'VALUE', value: '17.3%' },
        nextPlan: { state: 'NOT_APPLICABLE', value: null },
      },
    ],
    workforce: [],
    machines: [],
    materials: [],
    milestones: [],
    photoReferences: [
      {
        id: randomUUID(),
        description: 'TEST reference only',
        source: 'TEST recorder',
        reportedTakenAt: '',
        watermark: 'TEST other area',
        scopeCandidate: 'TEST pending area',
      },
    ],
    qualityText: 'TEST check requested; no acceptance result',
    ehsText: '',
    constructionText: 'TEST site work',
    photoNotes: '',
  };
  const responses = await Promise.all(
    Array.from({ length: 10 }, () =>
      call('/api/site-days/save', bearerA, original),
    ),
  );
  for (const response of responses) assert.equal(response.status, 200);
  const saved = await responses[0].json();
  for (const response of responses.slice(1))
    assert.deepEqual(await response.json(), saved);
  assert.equal(saved.revisionNumber, 1);
  assert.equal(saved.version, 1);
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "Revision"')).rows[0].n,
    1,
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "AuditLog"')).rows[0].n,
    1,
  );
  pass(
    'ten concurrent retries and lost-response replay produce one snapshot/audit/result',
  );
  assert.equal(
    (
      await call('/api/site-days/save', bearerA, {
        ...original,
        reason: 'changed payload',
      })
    ).status,
    409,
  );
  const recordPath = `/api/site-days/${original.recordId}`;
  assert.equal((await call(recordPath, bearerB)).status, 404);
  const detail = await (await call(recordPath, bearerA)).json();
  assert.equal(detail.content.declaration.businessDate, '2026-10-25');
  assert.equal(
    detail.content.declaration.workItems[0].quantity.value,
    '0.000000',
  );
  assert.equal(detail.content.declaration.reportedHeadcount.value, null);
  assert.equal(detail.content.declaration.issues, '');
  assert.deepEqual(
    detail.content.declaration.reportedSections,
    original.declaration.reportedSections,
  );
  assert.equal(detail.content.siteTimezone, 'Europe/Belgrade');
  pass(
    'readback keeps business date, raw zero, unknown count and blank issues',
  );
  const change = {
    ...original,
    clientMutationId: randomUUID(),
    expectedVersion: 1,
    baseRevisionNumber: 1,
    reason: 'TEST correction',
    declaration: structuredClone(original.declaration),
  };
  change.declaration.workItems[0].description = 'TEST corrected work';
  const competing = { ...change, clientMutationId: randomUUID() };
  const race = await Promise.all([
    call('/api/site-days/save', bearerA, change),
    call('/api/site-days/save', bearerA, competing),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const revised = await (await call(recordPath, bearerA)).json();
  assert.equal(revised.revisions.length, 2);
  assert.equal(
    revised.revisions[0].snapshot.declaration.workItems[0].description,
    'TEST initial work',
  );
  assert.deepEqual(
    revised.revisions[0].snapshot.declaration.reportedSections,
    original.declaration.reportedSections,
  );
  assert.equal(
    revised.revisions[1].snapshot.declaration.workItems[0].description,
    'TEST corrected work',
  );
  pass('two-window stale version conflict and immutable v1/v2 readback');
  const invalidCorrection = {
    ...change,
    clientMutationId: randomUUID(),
    expectedVersion: 2,
    reason: '',
  };
  assert.equal(
    (await call('/api/site-days/save', bearerA, invalidCorrection)).status,
    409,
  );
  assert.equal((await (await call(recordPath, bearerA)).json()).version, 2);
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM "AuditLog"')).rows[0].n,
    2,
  );
  pass(
    'failed correction rolls back aggregate version, content and audit atomically',
  );
  assert.equal(
    (
      await call(`/api/site-days/${original.recordId}/review`, bearerTwin, {
        clientMutationId: randomUUID(),
      })
    ).status,
    404,
  );
  const twin = await (await call('/api/projects', bearerTwin)).json();
  assert.equal(twin.personId, personA);
  pass(
    'same person second account cannot invoke independent review; no review endpoint exists',
  );
  await owner.query(
    'UPDATE "Membership" SET "activeUntil"=now() WHERE "accountId"=$1',
    [accountA],
  );
  assert.equal(
    (await call('/api/site-days/save', bearerA, original)).status,
    403,
  );
  assert.equal((await call(recordPath, bearerA)).status, 403);
  pass(
    'revoked membership blocks prior successful idempotency response and reads',
  );
  assert.equal((await appPool.query('SELECT * FROM "Project"')).rowCount, 0);
  assert.equal((await appPool.query('SELECT * FROM "AlphaDraft"')).rowCount, 0);
  await assert.rejects(appPool.query('UPDATE "Revision" SET snapshot=\'{}\''));
  await assert.rejects(owner.query('UPDATE "Revision" SET snapshot=\'{}\''));
  await assert.rejects(owner.query('DELETE FROM "AuditLog"'));
  pass(
    'non-owner RLS has no leaked connection context; snapshot/audit mutation refused',
  );
  await app.close();
  app = undefined;
  app = await createApp({ auth, verifier, store: new AlphaStore(appPool) });
  await app.listen(0, '127.0.0.1');
  const restart = await fetch((await app.getUrl()) + recordPath, {
    headers: { Authorization: `Bearer ${bearerTwin}` },
  });
  assert.equal(restart.status, 200);
  assert.equal((await restart.json()).revisions.length, 2);
  pass('application restart preserves records and immutable revision history');
  const draftCommand = {
    ...change,
    clientMutationId: randomUUID(),
    expectedVersion: 2,
    baseRevisionNumber: 2,
    action: 'SAVE_DRAFT',
    reason: '',
  };
  const freshBase = await app.getUrl();
  const draftResult = await fetch(freshBase + '/api/site-days/save', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerTwin}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': draftCommand.clientMutationId,
    },
    body: JSON.stringify(draftCommand),
  });
  assert.equal(draftResult.status, 200);
  const listResult = await fetch(
    freshBase + `/api/site-days?projectId=${projectA}`,
    { headers: { Authorization: `Bearer ${bearerTwin}` } },
  );
  assert.equal((await listResult.json())[0].status, 'DRAFT');
  pass('new draft after a saved version remains visibly DRAFT');
  const invalidJson = await fetch(freshBase + '/api/site-days/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(invalidJson.status, 400);
  const oversized = await fetch(freshBase + '/api/site-days/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'TEST'.repeat(100000) }),
  });
  assert.equal(oversized.status, 413);
  pass(
    'invalid JSON and oversized bodies fail explicitly without payload logging',
  );
  const fromOlder = {
    ...draftCommand,
    clientMutationId: randomUUID(),
    expectedVersion: 3,
    baseRevisionNumber: 1,
    action: 'SAVE_VERSION',
    reason: 'TEST correction based on original v1',
  };
  const olderResponse = await fetch(freshBase + '/api/site-days/save', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerTwin}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': fromOlder.clientMutationId,
    },
    body: JSON.stringify(fromOlder),
  });
  assert.equal(olderResponse.status, 200);
  const oldBase = await owner.query(
    'SELECT "baseRevisionNumber" FROM "Revision" WHERE "revisionNumber"=3',
  );
  assert.equal(oldBase.rows[0].baseRevisionNumber, 1);
  pass(
    'correction from an older snapshot records that exact base without replacing newer history',
  );
  const dump = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      source.username,
      '-Fc',
      database,
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  await admin.query(`CREATE DATABASE "${database}_restore"`);
  restoreCreated = true;
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      source.username,
      '--no-owner',
      '--exit-on-error',
      '-d',
      database + '_restore',
    ],
    {
      input: dump,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const restoredUrl = new URL(isolated);
  restoredUrl.pathname = `/${database}_restore`;
  const restored = tolerateShutdown(
    new Pool({ connectionString: restoredUrl.toString() }),
  );
  try {
    assert.equal(
      (await restored.query('SELECT count(*)::int AS n FROM "Revision"'))
        .rows[0].n,
      3,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS n FROM "AuditLog"'))
        .rows[0].n,
      4,
    );
    const backupSnapshot = await owner.query(
      'SELECT snapshot FROM "Revision" ORDER BY "revisionNumber"',
    );
    assert.deepEqual(
      (
        await restored.query(
          'SELECT snapshot FROM "Revision" ORDER BY "revisionNumber"',
        )
      ).rows,
      backupSnapshot.rows,
    );
    assert.equal(
      (await restored.query('SELECT version FROM "DailyClose"')).rows[0]
        .version,
      4,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS n FROM "AlphaDraft"'))
        .rows[0].n,
      1,
    );
  } finally {
    await restored.end();
  }
  pass(
    'isolated logical backup/restore preserves drafts, three revisions and all four audits',
  );
  console.log(
    `Alpha HTTP/DB integration: ${checks} checks passed; synthetic TEST data only. Cloud login, browser UAT and Blob recovery remain separate.`,
  );
} finally {
  if (app) await app.close();
  if (appPool) await appPool.end();
  if (owner) await owner.end();
  if (restoreCreated)
    await admin.query(`DROP DATABASE "${database}_restore" WITH (FORCE)`);
  if (dbCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  await admin.end();
}
