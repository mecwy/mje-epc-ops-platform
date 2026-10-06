/** C03 dedicated PG/HTTP TEST harness. Parent full report-route wiring is a separate gate. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { Pool } from 'pg';
import {
  WeatherStore,
  readWeatherLocations,
  readWeatherRequest,
  readWeatherSnapshot,
  readReportLocationCoordinates,
  resolveWeatherFacts,
  writeReportLocation,
  frozenWeatherReferences,
  type WeatherDayScope,
} from '../packages/domain/dist/weather-store.js';
import {
  claimWeatherJob,
  finishWeatherJob,
  failWeatherJob,
} from '../packages/domain/dist/weather-jobs.js';
import {
  inTransaction,
  idempotent,
  audit,
} from '../packages/domain/dist/store-kit.js';
import {
  ReportStore,
  blankFacts,
  reportReader,
} from '../packages/domain/dist/index.js';
import { runWeatherOnce } from '../apps/worker/dist/weather-worker.js';
import {
  WeatherController,
  type WeatherApiPort,
} from '../apps/api/dist/weather.controller.js';
import { ReportController } from '../apps/api/dist/report.controller.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import {
  parseFacts,
  parseWeatherQuery,
  parseWeatherReferenceDraft,
  type ReportLocationOperation,
  type WeatherFactsExtension,
} from '../packages/contracts/dist/index.js';
const raw = process.env['DATABASE_URL'];
assert.ok(raw, 'TEST DATABASE_URL required');
const source = new URL(raw);
assert.equal(source.hostname, '127.0.0.1');
assert.equal(source.port, '55343');
assert.equal(source.pathname, '/mje_c03_test_20261006');
const owner = new Pool({ connectionString: source.toString(), max: 5 });
let appPool: Pool | undefined;
let app:
  | {
      close: () => Promise<void>;
      listen: (port: number, host: string) => Promise<unknown>;
    }
  | undefined;
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log('PASS ' + name);
};
const seed = randomUUID(),
  tenantId = randomUUID(),
  org = randomUUID(),
  otherOrg = randomUUID(),
  project = randomUUID(),
  otherProject = randomUUID(),
  person = randomUUID(),
  account = randomUUID(),
  objectId = randomUUID(),
  readerPerson = randomUUID(),
  readerAccount = randomUUID(),
  readerObject = randomUUID();
const identity = { tenantId, objectId },
  readerIdentity = { tenantId, objectId: readerObject };
const role = 'mje_c03_test_app_' + randomBytes(4).toString('hex'),
  password = randomBytes(24).toString('hex');
let roleCreated = false;
try {
  await owner.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${role}"`);
  const appUrl = new URL(source);
  appUrl.username = role;
  appUrl.password = password;
  appPool = new Pool({ connectionString: appUrl.toString(), max: 8 });
  for (const [id, name] of [
    [org, 'TEST C03 org'],
    [otherOrg, 'TEST C03 other org'],
  ])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [id, name, seed],
    );
  for (const [id, name] of [
    [project, 'TEST-C03-' + project.slice(0, 8)],
    [otherProject, 'TEST-C03-other-' + otherProject.slice(0, 8)],
  ])
    await owner.query(
      `INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,'Europe/Belgrade','ACTIVE')`,
      [id, id === project ? org : otherOrg, seed, name],
    );
  for (const id of [person, readerPerson])
    await owner.query(
      `INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,'TEST C03 person')`,
      [id, org, seed],
    );
  for (const [id, p, oid] of [
    [account, person, objectId],
    [readerAccount, readerPerson, readerObject],
  ])
    await owner.query(
      `INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)`,
      [id, org, seed, tenantId, oid, p],
    );
  for (const [id, roleName] of [
    [account, 'PROJECT_MANAGER'],
    [readerAccount, 'EXECUTIVE_READER'],
  ])
    await owner.query(
      `INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now(),$5,$6)`,
      [randomUUID(), org, seed, roleName, id, project],
    );
  const stores = new WeatherStore(appPool);
  const reports = new ReportStore(appPool, { weatherReferenceEnabled: true });
  const businessDate = (
    await owner.query<{ day: string }>(
      `SELECT ((clock_timestamp() AT TIME ZONE 'Europe/Belgrade')::date-1)::text AS day`,
    )
  ).rows[0]!.day;
  // pg DATE is normally text; this type remains string under pg's date parser.
  const configure = {
    projectId: project,
    scopeKey: 'TEST-site',
    expectedN: 0,
    clientMutationId: randomUUID(),
    point: { lat: '45.123456789012', lon: '019.000000000001' },
  };
  const location = await stores.configureLocation(identity, configure);
  assert.equal(location.point.lat, configure.point.lat);
  assert.equal(location.point.lon, configure.point.lon);
  assert.deepEqual(
    await stores.configureLocation(identity, configure),
    location,
  );
  await assert.rejects(
    stores.configureLocation(identity, {
      ...configure,
      point: { lat: '46', lon: '20' },
    }),
    /IDEMPOTENCY_KEY_REUSED/,
  );
  pass('location CAS/idempotency preserves 12 digits and raw strings');
  await assert.rejects(
    stores.configureLocation(readerIdentity, {
      ...configure,
      clientMutationId: randomUUID(),
      expectedN: 1,
    }),
    /READ_ONLY/,
  );
  await assert.rejects(
    inTransaction(appPool, readerIdentity, (c, a) =>
      readWeatherLocations(c, a, project),
    ),
    /READ_ONLY/,
  );
  await assert.rejects(
    inTransaction(appPool, identity, (c, a) =>
      readWeatherLocations(c, a, otherProject),
    ),
    /FORBIDDEN/,
  );
  pass('read-only and cross-project denied before empty/live reads');
  const requestCommand = {
    projectId: project,
    locationVersionId: location.id,
    businessDate,
    refresh: false,
    clientMutationId: randomUUID(),
  };
  const [request, coalesced] = await Promise.all([
    stores.request(identity, requestCommand),
    stores.request(identity, {
      ...requestCommand,
      clientMutationId: randomUUID(),
    }),
  ]);
  assert.equal(request.id, coalesced.id);
  pass('concurrent requests coalesce to one active scoped outbox event');
  const [claimedA, claimedB] = await Promise.all([
    claimWeatherJob(appPool, org),
    claimWeatherJob(appPool, org),
  ]);
  const lease = claimedA ?? claimedB;
  assert.ok(lease);
  assert.equal([claimedA, claimedB].filter(Boolean).length, 1);
  assert.deepEqual(lease.query.point, configure.point);
  assert.equal(lease.query.businessDate, businessDate);
  assert.equal(lease.query.product, 'historical-weather');
  const body = {
    latitude: 45,
    longitude: 19,
    timezone: 'Europe/Belgrade',
    daily_units: {
      weather_code: 'wmo code',
      temperature_2m_min: '°C',
      temperature_2m_max: '°C',
      precipitation_sum: 'mm',
      wind_speed_10m_max: 'm/s',
      wind_gusts_10m_max: 'm/s',
    },
    daily: {
      time: [businessDate],
      weather_code: [3],
      temperature_2m_min: [9],
      temperature_2m_max: [15],
      precipitation_sum: [0],
      wind_speed_10m_max: [null],
    },
  };
  const worked = await runWeatherOnce({
    enabled: true,
    jobs: {
      claim: async () => lease,
      finish: (l, d) => finishWeatherJob(appPool!, l, d),
      fail: (l, code) => failWeatherJob(appPool!, l, code),
    },
    provider: {
      acceptQuery: parseWeatherQuery,
      acceptReference: parseWeatherReferenceDraft,
      transport: async () => ({ status: 200, body }),
      now: () => new Date().toISOString(),
    },
  });
  assert.equal(worked.state, 'ready');
  const status = await inTransaction(appPool, identity, (c, a) =>
    readWeatherRequest(c, a, project, request.id),
  );
  assert.ok(status.snapshotId);
  const snapshot = await inTransaction(appPool, identity, (c, a) =>
    readWeatherSnapshot(c, a, project, status.snapshotId!),
  );
  assert.equal(snapshot.data.metrics.precipitation.state, 'value');
  assert.equal(snapshot.data.publishedAt, null);
  assert.equal(snapshot.data.metrics.windMax.state, 'missing');
  assert.equal(snapshot.data.metrics.gustMax.state, 'missing');
  assert.equal(await finishWeatherJob(appPool, lease, snapshot.data), false);
  pass(
    'single worker publishes strict partial/zero snapshot once; settled token refused',
  );
  const manual = await reports.saveFacts(identity, {
    projectId: project,
    businessDate,
    expectedVersion: 0,
    clientMutationId: randomUUID(),
    facts: parseFacts({ ...blankFacts(), weather: 'TEST manual rain' }),
  });
  const dayId = (
    await owner.query<{ id: string }>(
      `SELECT id FROM "DailyClose" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "scopeKey"='report'`,
      [org, project, businessDate],
    )
  ).rows[0]!.id;
  const scope: WeatherDayScope = {
    projectId: project,
    dailyCloseId: dayId,
    businessDate,
    siteTimezone: 'Europe/Belgrade',
  };
  const operation: ReportLocationOperation = {
    kind: 'capture',
    candidate: {
      lat: '33.987654321012',
      lon: '011.000000000001',
      accuracyM: '200.00',
      deviceFixAt: null,
      acquiredAt: new Date().toISOString(),
    },
    clientConfirmedAt: new Date().toISOString(),
  };
  const key = randomUUID();
  let extension: WeatherFactsExtension = {};
  // Dedicated join proof: same transaction/lock/CAS/idempotency/audit. Shared ReportStore hook still belongs to A7.
  const save = () =>
    inTransaction(appPool!, identity, async (c, a) =>
      idempotent(c, a, 'TEST_C03_JOIN', key, { scope, operation }, async () => {
        const row = (
          await c.query<{ version: number }>(
            `SELECT version FROM "DailyClose" WHERE "orgId"=$1 AND id=$2 FOR UPDATE`,
            [org, dayId],
          )
        ).rows[0]!;
        assert.equal(row.version, manual.version);
        extension = await resolveWeatherFacts(
          c,
          a,
          scope,
          {},
          {
            weatherReferences: [
              {
                locationVersionId: location.id,
                snapshotId: status.snapshotId!,
              },
            ],
          },
          key,
        );
        const reportLocationRef = await writeReportLocation(
          c,
          a,
          scope,
          operation,
          null,
          key,
        );
        assert.ok(reportLocationRef);
        extension.reportLocationRef = reportLocationRef;
        const facts = {
          ...blankFacts(),
          weather: 'TEST manual rain',
          ...extension,
        };
        await c.query(
          `UPDATE "DailyReportDraft" SET facts=$3,"updatedAt"=clock_timestamp(),"updatedBy"=$4 WHERE "orgId"=$1 AND "dailyCloseId"=$2`,
          [org, dayId, JSON.stringify(facts), a.accountId],
        );
        await c.query(
          `UPDATE "DailyClose" SET version=version+1 WHERE "orgId"=$1 AND id=$2`,
          [org, dayId],
        );
        await audit(
          c,
          a,
          { type: 'SITE_DAILY_CLOSE', id: dayId, version: row.version + 1 },
          'TEST_C03_JOIN',
          '',
          null,
          facts,
          key,
        );
        return { version: row.version + 1, extension };
      }),
    );
  const saved = await save();
  assert.deepEqual(await save(), saved);
  assert.equal(
    (
      await owner.query(
        `SELECT id FROM "ReportLocationRecord" WHERE "orgId"=$1 AND "clientMutationId"=$2`,
        [org, key],
      )
    ).rowCount,
    1,
  );
  pass(
    'atomic dedicated join and original-key replay create one restricted position/adoption',
  );
  const frozen = await inTransaction(appPool, identity, (c, a) =>
    frozenWeatherReferences(c, a, scope, extension),
  );
  assert.equal(frozen[0]?.snapshotId, status.snapshotId);
  assert.equal(extension.reportLocationRef?.deviceFixAt, null);
  const coords = await inTransaction(appPool, identity, (c, a) =>
    readReportLocationCoordinates(
      c,
      a,
      project,
      extension.reportLocationRef!.recordId,
    ),
  );
  assert.equal(coords.lat, operation.candidate.lat);
  await assert.rejects(
    inTransaction(appPool, readerIdentity, (c, a) =>
      readReportLocationCoordinates(
        c,
        a,
        project,
        extension.reportLocationRef!.recordId,
      ),
    ),
    /READ_ONLY/,
  );
  pass(
    'only writer coordinate helper resolves raw position; generic refs retain unknown device time',
  );
  const persistedRef = (
    await owner.query<{ facts: WeatherFactsExtension }>(
      `SELECT facts FROM "DailyReportDraft" WHERE "orgId"=$1 AND "dailyCloseId"=$2`,
      [org, dayId],
    )
  ).rows[0]!.facts.reportLocationRef!;
  assert.deepEqual(
    await inTransaction(appPool, identity, (c, a) =>
      writeReportLocation(c, a, scope, undefined, persistedRef, randomUUID()),
    ),
    persistedRef,
  );
  pass('refreshed JSONB reference retains position across a no-operation save');

  await inTransaction(appPool, identity, async (c, a) => {
    assert.deepEqual(
      await resolveWeatherFacts(c, a, scope, extension, {}, randomUUID()),
      extension,
    );
    assert.deepEqual(
      (
        await resolveWeatherFacts(
          c,
          a,
          scope,
          extension,
          { weatherReferences: [] },
          randomUUID(),
        )
      ).weatherReferences,
      [],
    );
    await assert.rejects(
      resolveWeatherFacts(
        c,
        a,
        { ...scope, businessDate: '2000-01-01' },
        extension,
        {},
        randomUUID(),
      ),
      /NOT_FOUND/,
    );
  });
  pass('old-client omission preserved; explicit detach and wrong-day refused');
  const submitted = await reports.submit(identity, {
    projectId: project,
    businessDate,
    expectedVersion: saved.version,
    clientMutationId: randomUUID(),
  });
  const history = await reports.read(identity, (ctx) =>
    reportReader.forContext(ctx).revision(project, businessDate, 1),
  );
  assert.ok(history);
  const historyFacts = (
    history.snapshot as { facts: WeatherFactsExtension & { weather: string } }
  ).facts;
  assert.equal(historyFacts.weather, 'TEST manual rain');
  assert.equal(
    historyFacts.weatherReferences?.[0]?.snapshotId,
    status.snapshotId,
  );
  assert.equal(
    historyFacts.reportLocationRef?.recordId,
    extension.reportLocationRef?.recordId,
  );
  assert.equal(
    JSON.stringify(history).includes(operation.candidate.lat),
    false,
  );
  pass(
    'existing report submit/history freezes thin IDs and manual values without personal coordinates',
  );
  await inTransaction(appPool, identity, async (c, a) => {
    await assert.rejects(
      writeReportLocation(
        c,
        a,
        scope,
        operation,
        extension.reportLocationRef!,
        randomUUID(),
      ),
      /LOCKED/,
    );
  });
  const corrected = await reports.startCorrection(identity, {
    projectId: project,
    businessDate,
    expectedVersion: submitted.version,
    clientMutationId: randomUUID(),
    reason: 'TEST C03 correction',
  });
  await reports.saveFacts(identity, {
    projectId: project,
    businessDate,
    expectedVersion: corrected.version,
    clientMutationId: randomUUID(),
    facts: parseFacts({ ...blankFacts(), weather: 'TEST changed' }),
  });
  assert.equal(
    (
      (
        await reports.read(identity, (ctx) =>
          reportReader.forContext(ctx).revision(project, businessDate, 1),
        )
      )?.snapshot['facts'] as { weather: string }
    ).weather,
    'TEST manual rain',
  );
  pass(
    'submitted position write locked; correction does not rewrite prior Revision',
  );
  // Database constraints independent of application checks, with successful transaction recovery.
  await assert.rejects(
    owner.query(
      `UPDATE "WeatherSnapshot" SET "adapterVersion"='TEST rewrite' WHERE id=$1`,
      [status.snapshotId],
    ),
    /append-only/,
  );
  await assert.rejects(
    owner.query(`DELETE FROM "WeatherLocationVersion" WHERE id=$1`, [
      location.id,
    ]),
    /append-only/,
  );
  await assert.rejects(
    owner.query(`UPDATE "WeatherRequest" SET query='{}'::jsonb WHERE id=$1`, [
      request.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    owner.query(
      `UPDATE "ReportLocationRecord" SET "rawLat"='1' WHERE "orgId"=$1 AND "clientMutationId"=$2`,
      [org, key],
    ),
    /append-only/,
  );
  pass(
    'database enforces immutable versions, requests, snapshots and personal positions',
  );
  await assert.rejects(
    owner.query(
      `INSERT INTO "WeatherReportReference"(id,"orgId","projectId","dailyCloseId","businessDate","siteTimezone","locationVersionId","snapshotId","adoptedByAccountId","adoptedByPersonId","clientMutationId") VALUES($1,$2,$3,$4,$5::date,'Europe/Belgrade',$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        org,
        project,
        dayId,
        businessDate,
        randomUUID(),
        status.snapshotId,
        account,
        person,
        randomUUID(),
      ],
    ),
    (e: unknown) =>
      typeof e === 'object' && e !== null && 'code' in e && e.code === '23503',
  );
  await assert.rejects(
    owner.query(
      `INSERT INTO "WeatherLocationVersion"(id,"orgId","projectId","scopeKey",n,"siteTimezone",lat,lon,"rawLat","rawLon","confirmedByAccountId","confirmedByPersonId") VALUES($1,$2,$3,'TEST-too-precise',1,'Europe/Belgrade','45.1234567890123',19,'45.1234567890123','19',$4,$5)`,
      [randomUUID(), org, project, account, person],
    ),
    (e: unknown) =>
      typeof e === 'object' && e !== null && 'code' in e && e.code === '23514',
  );
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id',$1,true)", [otherOrg]);
    assert.equal(
      (
        await c.query(`SELECT id FROM "WeatherSnapshot" WHERE id=$1`, [
          status.snapshotId,
        ])
      ).rowCount,
      0,
    );
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }
  pass(
    'composite snapshot/location FK, precision rejection and org RLS enforced independently of app',
  );

  const leaked =
    JSON.stringify(
      (
        await owner.query(
          `SELECT "after","before" FROM "AuditLog" WHERE "orgId"=$1`,
          [org],
        )
      ).rows,
    ) +
    JSON.stringify(
      (
        await owner.query(
          `SELECT payload FROM "OutboxEvent" WHERE "orgId"=$1`,
          [org],
        )
      ).rows,
    ) +
    JSON.stringify(
      (
        await owner.query(
          `SELECT "responseBody" FROM "IdempotencyRecord" WHERE "orgId"=$1`,
          [org],
        )
      ).rows,
    );
  assert.equal(leaked.includes(operation.candidate.lat), false);
  assert.equal(leaked.includes(operation.candidate.lon), false);
  pass('no personal coordinates in audit/outbox/idempotency response bodies');
  const freshRequest = await stores.request(identity, {
    ...requestCommand,
    refresh: true,
    clientMutationId: randomUUID(),
  });
  const crash = await claimWeatherJob(appPool, org);
  assert.ok(crash);
  await owner.query(
    `UPDATE "WeatherRequest" SET "leasedUntil"=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [freshRequest.id],
  );
  const recovered = await claimWeatherJob(appPool, org);
  assert.ok(recovered);
  assert.notEqual(recovered.token, crash.token);
  assert.equal(await finishWeatherJob(appPool, crash, snapshot.data), false);
  assert.equal(await failWeatherJob(appPool, recovered, 'UNAVAILABLE'), true);
  assert.equal(
    (
      await inTransaction(appPool, identity, (c, a) =>
        readWeatherRequest(c, a, project, freshRequest.id),
      )
    ).state,
    'UNAVAILABLE',
  );
  pass('crash/reclaim rejects old token and stops at bounded retry budget');
  // Test least-privilege queue policy and rollback using the real application connection.
  const otherEvent = randomUUID();
  await owner.query(
    `INSERT INTO "OutboxEvent"(id,"orgId","updatedAt","updatedBy","eventType","aggregateId","aggregateVersion",payload) VALUES($1,$2,clock_timestamp(),$3,'TEST_OTHER_EVENT',$4,1,'{}')`,
    [otherEvent, org, account, randomUUID()],
  );
  const access = await appPool.connect();
  try {
    await access.query('BEGIN');
    await access.query("SELECT set_config('app.org_id',$1,true)", [org]);
    assert.equal(
      (
        await access.query(`SELECT id FROM "OutboxEvent" WHERE id=$1`, [
          otherEvent,
        ])
      ).rowCount,
      0,
    );
    const rejectSql = async (sql: string, args: unknown[]) => {
      await access.query('SAVEPOINT negative');
      await assert.rejects(
        access.query(sql, args),
        (e: unknown) =>
          typeof e === 'object' &&
          e !== null &&
          'code' in e &&
          e.code === '42501',
      );
      await access.query('ROLLBACK TO SAVEPOINT negative');
    };
    const eventSql = `INSERT INTO "OutboxEvent"(id,"orgId","updatedAt","updatedBy","eventType","aggregateId","aggregateVersion",payload) VALUES($1,$2,clock_timestamp(),$3,$4,$5,$6,$7)`;
    await rejectSql(eventSql, [
      randomUUID(),
      org,
      account,
      'TEST_OTHER_EVENT',
      request.id,
      1,
      JSON.stringify({ requestId: request.id }),
    ]);
    await rejectSql(eventSql, [
      randomUUID(),
      org,
      account,
      'WEATHER_FETCH',
      request.id,
      999,
      JSON.stringify({ requestId: request.id }),
    ]);
    await rejectSql(eventSql, [
      randomUUID(),
      otherOrg,
      account,
      'WEATHER_FETCH',
      request.id,
      1,
      JSON.stringify({ requestId: request.id }),
    ]);
    await rejectSql(eventSql, [
      randomUUID(),
      org,
      account,
      'WEATHER_FETCH',
      randomUUID(),
      1,
      JSON.stringify({ requestId: request.id }),
    ]);
    await rejectSql(
      `UPDATE "OutboxEvent" SET payload='{}' WHERE "orgId"=$1 AND "aggregateId"=$2`,
      [org, request.id],
    );
    await rejectSql(
      `UPDATE "WeatherRequest" SET query='{}' WHERE "orgId"=$1 AND id=$2`,
      [org, request.id],
    );
    await access.query('ROLLBACK');
  } finally {
    access.release();
  }
  pass(
    'low-privilege queue rejects other types/orgs/generations and immutable payload/query rewrites',
  );
  const countBefore = (
    await owner.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM "WeatherRequest" WHERE "orgId"=$1`,
      [org],
    )
  ).rows[0]!.n;
  const rejectedKey = randomUUID();
  await owner.query(
    `CREATE POLICY test_c03_reject_queue ON "OutboxEvent" AS RESTRICTIVE FOR INSERT TO "${role}" WITH CHECK(false)`,
  );
  try {
    await assert.rejects(
      stores.request(identity, {
        ...requestCommand,
        refresh: true,
        clientMutationId: rejectedKey,
      }),
      /WEATHER_STORE_FAILED/,
    );
  } finally {
    await owner.query('DROP POLICY test_c03_reject_queue ON "OutboxEvent"');
  }
  assert.equal(
    (
      await owner.query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM "WeatherRequest" WHERE "orgId"=$1`,
        [org],
      )
    ).rows[0]!.n,
    countBefore,
  );
  assert.equal(
    (
      await owner.query(
        `SELECT id FROM "IdempotencyRecord" WHERE "orgId"=$1 AND key=$2`,
        [org, rejectedKey],
      )
    ).rowCount,
    0,
  );
  pass(
    'real queue insertion failure rolls back request and idempotency completion',
  );
  // Dedicated actual controller + cryptographic TEST tokens. Root app registration/field-map remains separate.
  const requireApi = createRequire(
    new URL('../apps/api/package.json', import.meta.url),
  );
  const { Module } = await import(requireApi.resolve('@nestjs/common'));
  const { NestFactory } = await import(requireApi.resolve('@nestjs/core'));
  const { createLocalJWKSet, generateKeyPair, exportJWK, SignJWT } =
    await import(requireApi.resolve('jose'));
  const keys = await generateKeyPair('RS256'),
    audience = randomUUID(),
    clientId = randomUUID();
  const verifier = new TokenVerifier(
    { tenantId, audience, clientId, scope: 'access_as_user' },
    createLocalJWKSet({
      keys: [
        { ...(await exportJWK(keys.publicKey)), kid: 'TEST', alg: 'RS256' },
      ],
    }),
  );
  const port: WeatherApiPort = {
    configureLocation: (i, c) => stores.configureLocation(i, c),
    request: (i, c) => stores.request(i, c),
    locations: (i, p) =>
      inTransaction(appPool!, i, (c, a) => readWeatherLocations(c, a, p)),
    requestStatus: (i, p, r) =>
      inTransaction(appPool!, i, (c, a) => readWeatherRequest(c, a, p, r)),
    snapshot: (i, p, s) =>
      inTransaction(appPool!, i, (c, a) => readWeatherSnapshot(c, a, p, s)),
    coordinates: (i, p, r) =>
      inTransaction(appPool!, i, (c, a) =>
        readReportLocationCoordinates(c, a, p, r),
      ),
  };
  class TestWeatherModule {}
  Module({
    controllers: [WeatherController, ReportController],
    providers: [
      { provide: 'C03_WEATHER_API', useValue: port },
      { provide: TokenVerifier, useValue: verifier },
      { provide: ReportStore, useValue: reports },
    ],
  })(TestWeatherModule);
  await new Promise<void>((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(34103, '127.0.0.1', () => s.close(() => ok()));
  });
  app = await NestFactory.create(TestWeatherModule, { logger: false });
  await app!.listen(34103, '127.0.0.1');
  const token = (oid: string) =>
    new SignJWT({
      tid: tenantId,
      oid,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      sub: 'TEST-subject',
      nbf: Math.floor(Date.now() / 1000) - 1,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST' })
      .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  const bearer = await token(objectId),
    readerBearer = await token(readerObject);
  assert.deepEqual(await verifier.verify(`Bearer ${bearer}`), identity);
  const list = await fetch(
    `http://127.0.0.1:34103/api/weather/locations?projectId=${project}`,
    { headers: { authorization: `Bearer ${bearer}` } },
  );
  assert.equal(list.status, 200);
  assert.ok((await list.json()).length >= 1);
  assert.equal(
    (
      await fetch(
        `http://127.0.0.1:34103/api/weather/locations?projectId=${project}`,
      )
    ).status,
    401,
  );
  const denied = await fetch(
    `http://127.0.0.1:34103/api/weather/report-location/coordinates?projectId=${project}&recordId=${extension.reportLocationRef!.recordId}`,
    { headers: { authorization: `Bearer ${readerBearer}` } },
  );
  assert.notEqual(denied.status, 200);
  assert.equal((await denied.text()).includes(operation.candidate.lat), false);
  pass(
    'dedicated HTTP controller validates real TEST JWT and hides precise position from reader',
  );
  // Revocation is checked before idempotency replay, not after returning a cached config.
  await owner.query(
    `UPDATE "Membership" SET "activeUntil"=clock_timestamp() WHERE "orgId"=$1 AND "accountId"=$2`,
    [org, account],
  );
  await assert.rejects(
    stores.configureLocation(identity, configure),
    /FORBIDDEN/,
  );
  pass('revoked actor cannot replay formerly authorized configuration');
  const result = {
    status: 'DEDICATED_BACKEND_VERIFIED_FULL_C03_NOT_COMPLETE',
    checks: checks.length,
    passed: checks,
    notRun: [
      'parent shared ReportStore saveFacts hook/extension parser and authz registered weather exits',
      'parent WeatherLocation/DayStore save-refresh command owner and complete UI/history/correction journey',
      'full repository check/public allowlist/independent review and actual phone/provider',
    ],
    database: 'mje_c03_test_20261006',
    postgresPort: 55343,
    apiPort: 34103,
    privateCoordinates: 'synthetic TEST only',
    migrations: [
      '202610130001_weather_report_reference',
      '202610130002_weather_outbox_access',
    ],
  };
  if (process.env['C03_RESULT_FILE'])
    writeFileSync(
      process.env['C03_RESULT_FILE'],
      JSON.stringify(result, null, 2) + '\n',
    );
  console.log(JSON.stringify(result));
} finally {
  await app?.close();
  await appPool?.end();
  try {
    if (roleCreated) await owner.query(`DROP ROLE "${role}"`);
  } finally {
    await owner.end();
  }
}
