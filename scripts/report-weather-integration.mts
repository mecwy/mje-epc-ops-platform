/** Focused parent ReportStore/createApp HTTP seams; synthetic TEST only, no provider/GPS I/O. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { assertLocalDatabase } from './local-db.mjs';
import {
  AlphaStore,
  ReportStore,
  WeatherStore,
  blankFacts,
} from '../packages/domain/dist/index.js';
import {
  claimWeatherJob,
  finishWeatherJob,
} from '../packages/domain/dist/weather-jobs.js';
import {
  parseFacts,
  parseWeatherReferenceDraft,
  WEATHER_METRICS,
  type DayFactsDto,
  type SaveFactsCommand,
  type ReportLocationOperation,
} from '../packages/contracts/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';

type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
const object = (value: Json | undefined): JsonObject => {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected response object',
  );
  return value;
};
const text = (value: Json | undefined): string => {
  assert.equal(typeof value, 'string', 'expected response text');
  return value as string;
};
const integer = (value: Json | undefined): number => {
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value),
    'expected response integer',
  );
  return value;
};
const array = (value: Json | undefined): Json[] => {
  assert.ok(Array.isArray(value), 'expected response array');
  return value;
};
const checks: string[] = [];
let currentGroup = 'setup';
const begin = (name: string) => {
  currentGroup = name;
};
const pass = () => {
  checks.push(currentGroup);
  console.log(`PASS ${currentGroup}`);
};

async function run(): Promise<void> {
  const raw = process.env['DATABASE_URL'];
  assert.ok(raw, 'TEST DATABASE_URL required');
  const source = assertLocalDatabase(raw);
  assert.match(
    decodeURIComponent(source.pathname),
    /^\/mje_[a-z0-9_]*test[a-z0-9_]*$/,
    'explicit disposable TEST database required',
  );
  const owner = new Pool({ connectionString: source.toString(), max: 4 });
  let appPool: Pool | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let roleCreated = false;
  const policyTables = new Map<string, string>();
  const suffix = randomBytes(6).toString('hex');
  const role = `mje_report_weather_test_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const seed = randomUUID(),
    tenantId = randomUUID(),
    audience = randomUUID(),
    clientId = randomUUID();
  const org = randomUUID(),
    otherOrg = randomUUID(),
    project = randomUUID(),
    emptyProject = randomUUID(),
    otherProject = randomUUID();
  const pmPerson = randomUUID(),
    readerPerson = randomUUID(),
    pmAccount = randomUUID(),
    readerAccount = randomUUID();
  const pmObject = randomUUID(),
    readerObject = randomUUID(),
    pmMembership = randomUUID();
  const identity = { tenantId, objectId: pmObject };
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
      [org, 'TEST report weather org'],
      [otherOrg, 'TEST report weather other org'],
    ])
      await owner.query(
        'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
        [id, name, seed],
      );
    for (const [id, orgId] of [
      [project, org],
      [emptyProject, org],
      [otherProject, otherOrg],
    ])
      await owner.query(
        `INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,'Europe/Belgrade','ACTIVE')`,
        [id, orgId, seed, `TEST-RW-${id!.slice(0, 8)}`],
      );
    for (const id of [pmPerson, readerPerson])
      await owner.query(
        `INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,'TEST report weather person')`,
        [id, org, seed],
      );
    for (const [id, personId, objectId] of [
      [pmAccount, pmPerson, pmObject],
      [readerAccount, readerPerson, readerObject],
    ])
      await owner.query(
        'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
        [id, org, seed, tenantId, objectId, personId],
      );
    for (const [id, accountId, roleName] of [
      [pmMembership, pmAccount, 'PROJECT_MANAGER'],
      [randomUUID(), readerAccount, 'EXECUTIVE_READER'],
    ])
      await owner.query(
        'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now(),$5,$6)',
        [id, org, seed, roleName, accountId, project],
      );
    const requireApi = createRequire(
      new URL('../apps/api/package.json', import.meta.url),
    );
    const jose = (await import(
      requireApi.resolve('jose')
    )) as typeof import('../apps/api/node_modules/jose/dist/types/index.js');
    const keys = await jose.generateKeyPair('RS256');
    const auth = { tenantId, audience, clientId, scope: 'access_as_user' };
    const verifier = new TokenVerifier(
      auth,
      jose.createLocalJWKSet({
        keys: [
          {
            ...(await jose.exportJWK(keys.publicKey)),
            alg: 'RS256',
            kid: 'TEST-report-weather',
          },
        ],
      }),
    );
    const token = (oid: string) =>
      new jose.SignJWT({
        tid: tenantId,
        oid,
        azp: clientId,
        scp: 'access_as_user',
        ver: '2.0',
        sub: 'TEST-report-weather',
        nbf: Math.floor(Date.now() / 1000) - 1,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'TEST-report-weather' })
        .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(keys.privateKey);
    const pm = await token(pmObject),
      reader = await token(readerObject);
    const weather = new WeatherStore(appPool);
    app = await createApp({
      store: new AlphaStore(appPool),
      reportStore: new ReportStore(appPool),
      weatherStore: weather,
      verifier,
      auth,
    });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = async (
      path: string,
      bearer: string | null,
      body?: object,
    ): Promise<{ status: number; body: Json }> => {
      const command = body as { clientMutationId?: string } | undefined;
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(body
            ? {
                'Content-Type': 'application/json',
                'Idempotency-Key': command?.clientMutationId ?? '',
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      return {
        status: response.status,
        body: JSON.parse(await response.text()) as Json,
      };
    };
    const expect = async (
      pending: ReturnType<typeof call>,
      status: number,
      code?: string,
    ): Promise<JsonObject> => {
      const response = await pending;
      assert.equal(response.status, status, 'unexpected HTTP status');
      const body = object(response.body);
      if (code) assert.equal(body['code'], code, 'unexpected safe error code');
      return body;
    };
    const businessDate = (
      await owner.query<{ day: string }>(
        `SELECT ((clock_timestamp() AT TIME ZONE 'Europe/Belgrade')::date-1)::text AS day`,
      )
    ).rows[0]!.day;
    const scopeQuery = new URLSearchParams({
      projectId: project,
      businessDate,
    }).toString();
    const day = () => expect(call(`/api/report/day?${scopeQuery}`, pm), 200);
    const readerDay = () =>
      expect(call(`/api/report/day?${scopeQuery}`, reader), 200);
    const revision = (n: number, bearer = reader) =>
      expect(call(`/api/report/revision?${scopeQuery}&n=${n}`, bearer), 200);
    const location = await weather.configureLocation(identity, {
      projectId: project,
      scopeKey: 'TEST-site',
      expectedN: 0,
      clientMutationId: randomUUID(),
      point: { lat: '45.000000', lon: '19.000000' },
    });
    // Finite local provider fixture: no transport implementation is invoked.
    const snapshot = async (
      refresh: boolean,
      value: string,
    ): Promise<string> => {
      const request = await weather.request(identity, {
        projectId: project,
        locationVersionId: location.id,
        businessDate,
        refresh,
        clientMutationId: randomUUID(),
      });
      const lease = await claimWeatherJob(appPool!, org);
      assert.ok(
        lease && lease.requestId === request.id,
        'expected exact TEST job lease',
      );
      const data = parseWeatherReferenceDraft({
        provider: 'open-meteo',
        query: lease.query,
        category: 'reanalysis',
        fetchedAt: new Date().toISOString(),
        publishedAt: null,
        coverage: 'complete',
        grid: null,
        metrics: Object.fromEntries(
          WEATHER_METRICS.map((key) => [
            key,
            { state: 'value', value, raw: value, unit: 'TEST-unit' },
          ]),
        ),
      });
      assert.equal(
        await finishWeatherJob(appPool!, lease, data),
        true,
        'expected finite TEST job finish',
      );
      const status = await expect(
        call(
          `/api/weather/requests?projectId=${project}&requestId=${request.id}`,
          pm,
        ),
        200,
      );
      return text(status['snapshotId']);
    };
    const snapshot1 = await snapshot(false, '0');
    const capture: ReportLocationOperation = {
      kind: 'capture',
      candidate: {
        lat: '44.123456789012',
        lon: '19.987654321012',
        accuracyM: '10.00',
        deviceFixAt: null,
        acquiredAt: new Date().toISOString(),
      },
      clientConfirmedAt: new Date().toISOString(),
    };
    let version = 0;
    const command = (
      facts: DayFactsDto,
      operation?: ReportLocationOperation,
    ): SaveFactsCommand => ({
      projectId: project,
      businessDate,
      expectedVersion: version,
      clientMutationId: randomUUID(),
      facts,
      ...(operation ? { reportLocationOperation: operation } : {}),
    });
    const save = async (payload: SaveFactsCommand): Promise<JsonObject> => {
      const response = await expect(
        call('/api/report/facts', pm, payload),
        200,
      );
      version = integer(response['version']);
      return response;
    };
    interface State {
      version: number;
      facts: DayFactsDto;
      positions: number;
      adoptions: number;
      requests: number;
      audits: number;
      idempotency: number;
    }
    const inspect = async (): Promise<State> =>
      (
        await owner.query<State>(
          `SELECT d.version,f.facts,
      (SELECT count(*)::integer FROM "ReportLocationRecord" WHERE "orgId"=$1) AS positions,
      (SELECT count(*)::integer FROM "WeatherReportReference" WHERE "orgId"=$1) AS adoptions,
      (SELECT count(*)::integer FROM "WeatherRequest" WHERE "orgId"=$1) AS requests,
      (SELECT count(*)::integer FROM "AuditLog" WHERE "orgId"=$1) AS audits,
      (SELECT count(*)::integer FROM "IdempotencyRecord" WHERE "orgId"=$1) AS idempotency
      FROM "DailyClose" d JOIN "DailyReportDraft" f ON f."orgId"=d."orgId" AND f."dailyCloseId"=d.id WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND d."scopeKey"='report'`,
          [org, project, businessDate],
        )
      ).rows[0]!;
    const privacy = async (): Promise<void> => {
      const serialized = JSON.stringify(
        (
          await owner.query<{ safe: Json }>(
            `SELECT jsonb_build_object('facts',f.facts) AS safe FROM "DailyReportDraft" f WHERE f."orgId"=$1
        UNION ALL SELECT jsonb_build_object('revision',r.snapshot) FROM "Revision" r WHERE r."orgId"=$1
        UNION ALL SELECT jsonb_build_object('before',a."before",'after',a."after") FROM "AuditLog" a WHERE a."orgId"=$1
        UNION ALL SELECT jsonb_build_object('response',i."responseBody") FROM "IdempotencyRecord" i WHERE i."orgId"=$1
        UNION ALL SELECT jsonb_build_object('payload',e.payload) FROM "OutboxEvent" e WHERE e."orgId"=$1`,
            [org],
          )
        ).rows,
      );
      assert.ok(
        !serialized.includes('44.123456') && !serialized.includes('19.987654'),
        'personal position leaked into generic record',
      );
    };

    begin(
      'atomic parent facts save with safe refs and restricted raw precision',
    );
    const firstCommand = command(
      {
        ...parseFacts(blankFacts()),
        people: { installer: '0' },
        weatherReferences: [
          { snapshotId: snapshot1, locationVersionId: location.id },
        ],
      },
      capture,
    );
    const firstResult = await save(firstCommand);
    const firstState = await inspect();
    assert.equal(firstState.positions, 1);
    assert.equal(firstState.adoptions, 1);
    assert.ok(firstState.facts.weatherReferences?.[0]?.referenceId);
    assert.equal(firstState.facts.reportLocationRef?.deviceFixAt, null);
    const rawPosition = (
      await owner.query<{ lat: string; lon: string }>(
        `SELECT "rawLat" AS lat,"rawLon" AS lon FROM "ReportLocationRecord" WHERE "orgId"=$1 AND id=$2`,
        [org, firstState.facts.reportLocationRef?.recordId],
      )
    ).rows[0]!;
    assert.equal(rawPosition.lat, capture.candidate.lat);
    assert.equal(rawPosition.lon, capture.candidate.lon);
    await privacy();
    pass();

    begin('same-key replay creates no extra version adoption or position');
    const replay = await expect(
      call('/api/report/facts', pm, firstCommand),
      200,
    );
    assert.deepEqual(replay, firstResult);
    assert.deepEqual(await inspect(), firstState);
    pass();

    begin(
      'omission preserves while explicit empty references and clear detach draft only',
    );
    await save(
      command({
        ...parseFacts(blankFacts()),
        people: { installer: 'unknown' },
      }),
    );
    const preserved = await inspect();
    assert.deepEqual(
      preserved.facts.weatherReferences,
      firstState.facts.weatherReferences,
    );
    assert.deepEqual(
      preserved.facts.reportLocationRef,
      firstState.facts.reportLocationRef,
    );
    await save(
      command({ ...preserved.facts, weatherReferences: [] }, { kind: 'clear' }),
    );
    const detached = await inspect();
    assert.deepEqual(detached.facts.weatherReferences, []);
    assert.equal(detached.facts.reportLocationRef, null);
    assert.equal(detached.positions, 1);
    assert.equal(detached.adoptions, 1);
    pass();

    begin(
      'actual identity scope and revoked replay checks include empty reads',
    );
    await expect(
      call(`/api/weather/locations?projectId=${project}`, reader),
      403,
      'READ_ONLY',
    );
    await expect(
      call(`/api/weather/locations?projectId=${emptyProject}`, pm),
      403,
      'FORBIDDEN',
    );
    await expect(
      call(`/api/weather/locations?projectId=${otherProject}`, pm),
      403,
      'FORBIDDEN',
    );
    await expect(
      call(`/api/weather/locations?projectId=${emptyProject}`, null),
      401,
      'LOGIN_REQUIRED',
    );
    await expect(
      call('/api/report/facts', reader, firstCommand),
      403,
      'READ_ONLY',
    );
    await owner.query(
      'UPDATE "Membership" SET "activeUntil"=clock_timestamp()-interval \'1 second\' WHERE "orgId"=$1 AND id=$2',
      [org, pmMembership],
    );
    try {
      await expect(
        call('/api/report/facts', pm, firstCommand),
        403,
        'FORBIDDEN',
      );
    } finally {
      await owner.query(
        'UPDATE "Membership" SET "activeUntil"=NULL WHERE "orgId"=$1 AND id=$2',
        [org, pmMembership],
      );
    }
    pass();

    begin(
      'submit day chosen revision and correction keep frozen safe references',
    );
    await save(
      command(
        {
          ...detached.facts,
          reportLocationRef: null,
          weatherReferences: [
            { snapshotId: snapshot1, locationVersionId: location.id },
          ],
        },
        capture,
      ),
    );
    const submitted = await expect(
      call('/api/report/submit', pm, {
        projectId: project,
        businessDate,
        expectedVersion: version,
        clientMutationId: randomUUID(),
      }),
      200,
    );
    version = integer(submitted['version']);
    assert.equal(submitted['revisionNumber'], 1);
    const originalRevision = object((await revision(1))['snapshot']);
    const originalJson = JSON.stringify(originalRevision);
    const originalReferences = array(originalRevision['weatherReferences']);
    assert.equal(object(originalReferences[0])['snapshotId'], snapshot1);
    assert.equal(
      object(object(originalRevision['facts'])['reportLocationRef'])[
        'deviceFixAt'
      ],
      null,
    );
    assert.deepEqual(
      (await readerDay())['weatherReferences'],
      originalReferences,
    );
    assert.deepEqual((await day())['weatherReferences'], originalReferences);
    const correcting = await expect(
      call('/api/report/correction/start', pm, {
        projectId: project,
        businessDate,
        expectedVersion: version,
        clientMutationId: randomUUID(),
        reason: 'TEST weather correction',
      }),
      200,
    );
    version = integer(correcting['version']);
    const snapshot2 = await snapshot(true, '7');
    const correctionFacts = parseFacts((await day())['facts']);
    await save(
      command({
        ...correctionFacts,
        people: { installer: '2' },
        weatherReferences: [
          { snapshotId: snapshot2, locationVersionId: location.id },
        ],
      }),
    );
    assert.deepEqual(
      (await readerDay())['weatherReferences'],
      originalReferences,
    );
    const secondSubmit = await expect(
      call('/api/report/submit', pm, {
        projectId: project,
        businessDate,
        expectedVersion: version,
        clientMutationId: randomUUID(),
      }),
      200,
    );
    version = integer(secondSubmit['version']);
    assert.equal(secondSubmit['revisionNumber'], 2);
    assert.equal(
      JSON.stringify(object((await revision(1))['snapshot'])),
      originalJson,
    );
    const corrected = object((await revision(2))['snapshot']);
    assert.equal(
      object(array(corrected['weatherReferences'])[0])['snapshotId'],
      snapshot2,
    );
    assert.deepEqual(
      object(corrected['facts'])['reportLocationRef'],
      object(originalRevision['facts'])['reportLocationRef'],
    );
    assert.ok(corrected['personnelSummary'], 'C06 frozen summary must coexist');
    await privacy();
    pass();

    begin(
      'excess coordinate precision rejected with null fix timestamp preserved',
    );
    const beforePrecision = await inspect();
    const tooPrecise = {
      ...command(beforePrecision.facts),
      reportLocationOperation: {
        ...capture,
        candidate: { ...capture.candidate, lat: '44.1234567890123' },
      },
    };
    await expect(
      call('/api/report/facts', pm, tooPrecise),
      400,
      'INVALID_INPUT',
    );
    assert.deepEqual(await inspect(), beforePrecision);
    assert.equal(beforePrecision.facts.reportLocationRef?.deviceFixAt, null);
    pass();

    begin(
      'strict parent payload rejects private facts and invented operation fields',
    );
    const currentFacts = (await inspect()).facts;
    for (const badFacts of [
      { ...currentFacts, lat: capture.candidate.lat },
      {
        ...currentFacts,
        reportLocationRef: {
          ...currentFacts.reportLocationRef,
          lon: capture.candidate.lon,
        },
      },
      {
        ...currentFacts,
        weatherReferences: [
          {
            locationVersionId: location.id,
            snapshotId: snapshot2,
            adoptedByPersonId: pmPerson,
          },
        ],
      },
    ])
      await expect(
        call('/api/report/facts', pm, {
          ...command(currentFacts),
          facts: badFacts,
        }),
        400,
        'INVALID_INPUT',
      );
    await expect(
      call('/api/report/facts', pm, {
        ...command(currentFacts),
        reportLocationOperation: { kind: 'clear', lat: capture.candidate.lat },
      }),
      400,
      'INVALID_INPUT',
    );
    await expect(
      call('/api/report/facts', pm, { ...command(currentFacts), orgId: org }),
      400,
      'INVALID_INPUT',
    );
    pass();

    begin(
      'queue invalid reference and late report failure leave parent records unchanged',
    );
    const reopen = await expect(
      call('/api/report/correction/start', pm, {
        projectId: project,
        businessDate,
        expectedVersion: version,
        clientMutationId: randomUUID(),
        reason: 'TEST atomic rejection',
      }),
      200,
    );
    version = integer(reopen['version']);
    const stable = await inspect();
    const queuePolicy = `test_rw_queue_${suffix}`;
    await owner.query(
      `CREATE POLICY "${queuePolicy}" ON "OutboxEvent" AS RESTRICTIVE FOR INSERT TO "${role}" WITH CHECK(false)`,
    );
    policyTables.set(queuePolicy, 'OutboxEvent');
    await expect(
      call('/api/weather/requests', pm, {
        projectId: project,
        locationVersionId: location.id,
        businessDate,
        refresh: true,
        clientMutationId: randomUUID(),
      }),
      500,
      'REQUEST_FAILED',
    );
    await owner.query(`DROP POLICY "${queuePolicy}" ON "OutboxEvent"`);
    policyTables.delete(queuePolicy);
    assert.deepEqual(await inspect(), stable);
    await expect(
      call(
        '/api/report/facts',
        pm,
        command(
          {
            ...stable.facts,
            weatherReferences: [
              { locationVersionId: location.id, snapshotId: randomUUID() },
            ],
          },
          capture,
        ),
      ),
      400,
      'INVALID_INPUT',
    );
    assert.deepEqual(await inspect(), stable);
    const draftPolicy = `test_rw_draft_${suffix}`;
    await owner.query(
      `CREATE POLICY "${draftPolicy}" ON "DailyReportDraft" AS RESTRICTIVE FOR ALL TO "${role}" USING(true) WITH CHECK(false)`,
    );
    policyTables.set(draftPolicy, 'DailyReportDraft');
    await expect(
      call(
        '/api/report/facts',
        pm,
        command(
          {
            ...stable.facts,
            weatherReferences: [
              { locationVersionId: location.id, snapshotId: snapshot2 },
            ],
          },
          capture,
        ),
      ),
      500,
      'REQUEST_FAILED',
    );
    await owner.query(`DROP POLICY "${draftPolicy}" ON "DailyReportDraft"`);
    policyTables.delete(draftPolicy);
    assert.deepEqual(await inspect(), stable);
    await privacy();
    pass();
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await appPool?.end();
      } finally {
        try {
          for (const [policy, table] of policyTables)
            await owner.query(
              `DROP POLICY IF EXISTS "${policy}" ON "${table}"`,
            );
          if (roleCreated) await owner.query(`DROP ROLE "${role}"`);
        } finally {
          await owner.end();
        }
      }
    }
  }
}

let failed = false;
let failureKind: string | null = null;
let failureLine: number | null = null;
try {
  await run();
} catch (error: unknown) {
  failed = true;
  // Never emit assertion values, SQL, credentials, coordinates or underlying error messages.
  failureKind = error instanceof Error ? error.name : 'UnknownFailure';
  const match =
    error instanceof Error
      ? error.stack?.match(/report-weather-integration\.mts:(\d+):\d+/)
      : null;
  failureLine = match?.[1] ? Number(match[1]) : null;
}
const result = {
  status: failed ? 'FAIL' : 'PASS',
  checks: checks.length,
  passed: checks,
  failedGroup: failed ? currentGroup : null,
  failureKind,
  failureLine,
  scope: 'actual parent HTTP and low-privilege PostgreSQL TEST seams',
  notRun: [
    'browser/device GPS',
    'external provider transport',
    'private-source acceptance',
    'deployment',
  ],
};
const resultPath = process.env['TEST_RESULT_PATH'];
if (resultPath)
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
console.log(JSON.stringify(result));
if (failed) process.exitCode = 1;
