/** Local C04-only synthetic TEST PG + signed-token HTTP harness. No shared app mount or live grant. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  ManagerReviewStore,
  type ReviewServerPorts,
} from '../packages/domain/dist/manager-review-store.js';
import {
  ManagerReviewController,
  MANAGER_REVIEW_SERVICE,
} from '../apps/api/dist/manager-review.controller.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import {
  inTransaction,
  projectAccess,
  lockReportDay,
} from '../packages/domain/dist/store-kit.js';
import { managerReviewReader } from '../packages/domain/dist/manager-review-reader.js';
import { DENY_REVIEW_PORTS } from '../packages/domain/dist/manager-review-store.js';
import { parseManagerReviewScope } from '../packages/contracts/dist/manager-review-service.js';
import type { ReviewForemanCommand } from '../packages/contracts/dist/index.js';

const root = process.env['C04_RUNTIME_ROOT'];
assert.equal(root, '/private/tmp/mje-c04-review-runtime-20261006');
const lease = JSON.parse(readFileSync(`${root}/LEASE.json`, 'utf8')) as {
  syntheticOnly: boolean;
  status: string;
  port: number;
  database: string;
  holder: string;
};
assert.equal(lease.syntheticOnly, true);
assert.equal(lease.status, 'RUNNING_FRESH_C04_ONLY_BEFORE_TEST');
assert.match(lease.database, /^mje_c04_review_test_/);
assert.equal(lease.holder, '01a1109e-4aec-7eb1-874c-20e6bdcdc1c6');
const config = JSON.parse(
  readFileSync(`${root}/session-private.json`, 'utf8'),
) as {
  admin: { host: string; port: number; database: string; user: string };
  app: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
};
assert.equal(config.admin.host, '127.0.0.1');
assert.equal(config.app.host, '127.0.0.1');
assert.equal(config.admin.port, lease.port);
assert.equal(config.app.database, lease.database);
assert.match(config.app.user, /^c04_review_app_[a-z0-9]+$/);
assert.match(config.app.password, /^[a-f0-9]{48}$/);
const owner = new Pool(config.admin);
const appPool = new Pool({ ...config.app, max: 8 });
const checks: { id: string; status: 'PASS' }[] = [];
let current = 'SETUP';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1),
  foreignOrg = id(2),
  project = id(31),
  foreignProject = id(32),
  crew = id(51),
  report = id(61),
  revision = id(62);
const tenant = id(71),
  audience = id(72),
  clientId = id(73),
  policy = id(81),
  grant = id(82),
  independentPolicy = id(83),
  basisId = id(84),
  wholeScope = id(85),
  partialScope = id(86);
const day = '2026-10-06';
const scope = {
  projectId: project,
  businessDate: day,
  crewId: crew,
  itemKey: 'TEST_work',
};
const target = { ...scope, foremanRevisionId: revision };
const identities = [
  { account: id(41), object: id(101), person: id(21) },
  { account: id(42), object: id(102), person: id(21) },
  { account: id(43), object: id(103), person: id(22) },
  { account: id(44), object: id(104), person: id(23) },
];
type Control = {
  active: boolean;
  resolved: boolean;
  sourceResolved: boolean;
  independence: 'CLEAR' | 'CONFLICT' | 'UNKNOWN';
  evidence: boolean;
  evidenceVersion: number;
  evidenceUnit: string;
};
const control = async (
  c: Parameters<ReviewServerPorts['resolveAuthority']>[0],
  account: string,
) => {
  const r = await c.query<Control>(
    'SELECT * FROM "TESTReviewControl" WHERE "accountId"=$1 FOR SHARE',
    [account],
  );
  return r.rows[0];
};
const ports: ReviewServerPorts = {
  resolveAuthority: async (c, a, s) => {
    const x = await control(c, a.accountId);
    return {
      orgId: a.orgId,
      accountId: a.accountId,
      personId: a.personId,
      active: true,
      identityResolved: x?.resolved ?? false,
      policyRef: policy,
      decidedAt: new Date(a.decidedAt).toISOString(),
      grants:
        x?.active && s.projectId === project
          ? [
              {
                id: grant,
                orgId: org,
                projectId: project,
                crewId: crew,
                itemKey: 'TEST_work',
                actions: [
                  'READ_REVIEW',
                  'RETURN',
                  'INCONCLUSIVE',
                  'CONFIRM_SCOPE',
                ],
                validFrom: '2026-01-01T00:00:00Z',
                validUntil: null,
              },
            ]
          : [],
    };
  },
  resolveIndependence: async (c, a) => {
    const x = await control(c, a.accountId);
    return {
      status: x?.independence ?? 'UNKNOWN',
      partiesComplete: true,
      policyRef: independentPolicy,
      partyPersonIds: [],
    };
  },
  sourceContextFor: async (c, a) => {
    const x = await control(c, a.accountId);
    return {
      unit: 'TEST_unit',
      scopeRef: wholeScope,
      scopeStatus: 'CONFIRMED',
      reportedIdentityResolved: x?.sourceResolved ?? false,
      changedByPersonIds: [],
    };
  },
  evidenceFor: async (c, a, t) => {
    const x = await control(c, a.accountId);
    return x?.evidence
      ? {
          orgId: org,
          target: { ...t },
          basis: { linkSetId: basisId, version: x.evidenceVersion },
          state: 'PARTIAL',
          coverage: {
            scopeRef: partialScope,
            withinScopeRef: wholeScope,
            qty: '40',
            unit: x.evidenceUnit,
          },
          photos: [{ photoId: id(91), photoVersion: 1, linkId: id(92) }],
        }
      : null;
  },
};
const identity = (index = 2) => ({
  tenantId: tenant,
  objectId: identities[index]!.object,
});
const confirm = (version = 0): ReviewForemanCommand => ({
  schemaVersion: 1,
  clientMutationId: randomUUID(),
  target: { ...target },
  expectedRevision: 1,
  expectedVersion: version,
  decision: 'CONFIRM_SCOPE',
  coverage: { kind: 'PARTIAL', scopeRef: partialScope, qty: '40' },
  evidenceBasis: { linkSetId: basisId, version: 1 },
  reason: '',
  method: 'TEST independent observation',
  limitations: 'TEST photo scope only',
});
const returned = (version: number): ReviewForemanCommand => ({
  schemaVersion: 1,
  clientMutationId: randomUUID(),
  target: { ...target },
  expectedRevision: 1,
  expectedVersion: version,
  decision: 'RETURN',
  coverage: null,
  evidenceBasis: null,
  reason: 'TEST correction',
  method: '',
  limitations: '',
});
const count = async () =>
  Number(
    (
      await owner.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM "ManagerReviewEvent"',
      )
    ).rows[0]!.n,
  );
const requireApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { NestFactory } = requireApi(
  '@nestjs/core',
) as typeof import('../apps/api/node_modules/@nestjs/core/index.js');
const { Module } = requireApi(
  '@nestjs/common',
) as typeof import('../apps/api/node_modules/@nestjs/common/index.js');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } =
  (await import(
    requireApi.resolve('jose')
  )) as typeof import('../apps/api/node_modules/jose/dist/types/index.js');
requireApi('reflect-metadata');
let api: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
try {
  await owner.query(readFileSync(`${root}/manager-review-schema.sql`, 'utf8'));
  if (
    !(
      await owner.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
        config.app.user,
      ])
    ).rowCount
  )
    await owner.query(
      `CREATE ROLE "${config.app.user}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${config.app.password}'`,
    );
  await owner.query(`GRANT mje_alpha_app TO "${config.app.user}"`);
  for (const o of [org, foreignOrg])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$2,now(),$3)',
      [o, 'TEST C04 org', id(999)],
    );
  for (const [p, o] of [
    [project, org],
    [foreignProject, foreignOrg],
  ])
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,$4,\'Europe/Belgrade\',\'ACTIVE\')',
      [p, o, id(999), 'TEST_' + p!.slice(-4)],
    );
  for (const p of [id(21), id(22), id(23)])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,$4)',
      [p, org, id(999), 'TEST C04 person'],
    );
  for (const a of identities) {
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [a.account, org, id(999), tenant, a.object, a.person],
    );
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'PROJECT_MANAGER\',now()-interval \'1 day\',$4,$5)',
      [randomUUID(), org, id(999), a.account, project],
    );
  }
  await owner.query(
    'INSERT INTO "Crew"(id,"orgId","projectId",code,name,"createdBy") VALUES($1,$2,$3,\'TEST_C04\',\'TEST C04 crew\',$4)',
    [crew, org, project, id(43)],
  );
  await owner.query(
    `INSERT INTO "FieldDevice"(id,"orgId","projectId","personId",state,"tokenHash","pendingUntil","expiresAt","lastSeenAt") VALUES($1,$2,$3,$4,'PENDING',$5,now()+interval '1 day',now()+interval '2 days',now())`,
    [id(52), org, project, id(21), 'a'.repeat(64)],
  );
  await owner.query(
    'INSERT INTO "ForemanReport"(id,"orgId","projectId","crewId","businessDate","currentN") VALUES($1,$2,$3,$4,$5::date,1)',
    [report, org, project, crew, day],
  );
  const addRevision = async (r: string, n: number, qty: string) =>
    owner.query(
      `INSERT INTO "ForemanReportRevision"(id,"orgId","projectId","reportId",n,rows,note,"byPersonId","byDeviceId","occurredAt","receivedAt","siteTimezone","daySeq") VALUES($1,$2,$3,$4,$5,$6::jsonb,'TEST source',$7,$8,now(),now(),'Europe/Belgrade',$9)`,
      [
        r,
        org,
        project,
        report,
        n,
        JSON.stringify([{ itemKey: 'TEST_work', qty }]),
        id(21),
        id(52),
        n,
      ],
    );
  await addRevision(revision, 1, '100');
  await owner.query(
    'INSERT INTO "FieldDay"(id,"orgId","projectId","businessDate","lastSeq") VALUES($1,$2,$3,$4::date,1)',
    [id(53), org, project, day],
  );
  // PG row locks need UPDATE on one column. Only this inert lock pad is writable; permission fields remain read-only.
  await owner.query(
    `CREATE TABLE "TESTReviewControl"("accountId" uuid PRIMARY KEY,active boolean NOT NULL,resolved boolean NOT NULL,"sourceResolved" boolean NOT NULL,independence text NOT NULL,evidence boolean NOT NULL,"evidenceVersion" integer NOT NULL,"evidenceUnit" text NOT NULL,"lockPad" integer NOT NULL DEFAULT 0); GRANT SELECT,UPDATE("lockPad") ON "TESTReviewControl" TO mje_alpha_app`,
  );
  for (const a of identities)
    await owner.query(
      'INSERT INTO "TESTReviewControl" ("accountId",active,resolved,"sourceResolved",independence,evidence,"evidenceVersion","evidenceUnit") VALUES($1,true,true,true,\'CLEAR\',true,1,\'TEST_unit\')',
      [a.account],
    );
  const store = new ManagerReviewStore(appPool, ports);
  // TEST composition only. Actual report-reader opens and owns the opaque read context at integration.
  const read = async (
    i: Parameters<typeof store.write>[0],
    input: unknown,
    serverPorts = ports,
  ) => {
    const s = parseManagerReviewScope(input);
    return inTransaction(appPool, i, async (c, a) => {
      await projectAccess(c, a, s.projectId);
      await lockReportDay(c, a.orgId, s.projectId, s.businessDate);
      return managerReviewReader.read(c, a, s, serverPorts);
    });
  };
  const change = async (column: string, value: unknown) => {
    assert.ok(
      [
        'active',
        'resolved',
        'sourceResolved',
        'independence',
        'evidence',
        'evidenceVersion',
        'evidenceUnit',
      ].includes(column),
    );
    await owner.query(
      `UPDATE "TESTReviewControl" SET "${column}"=$1 WHERE "accountId"=$2`,
      [value, id(43)],
    );
  };
  const check = async (name: string, work: () => Promise<void>) => {
    current = name;
    await work();
    checks.push({ id: name, status: 'PASS' });
    console.log('PASS', name);
  };
  await check('LOW_PRIVILEGE_ROLE', async () => {
    const r = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    assert.equal(r.rows[0]!.rolsuper, false);
    assert.equal(r.rows[0]!.rolbypassrls, false);
  });
  await check('DEFAULT_DENY_PM_NOT_A_REVIEW_GRANT', async () => {
    await assert.rejects(
      new ManagerReviewStore(appPool).write(identity(), returned(0)),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(read(identity(), scope, DENY_REVIEW_PORTS), {
      code: 'FORBIDDEN',
    });
    assert.equal(await count(), 0);
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'TEST_C04_KEY';
  const verifier = new TokenVerifier(
    { tenantId: tenant, audience, clientId, scope: 'access_as_user' },
    createLocalJWKSet({ keys: [jwk] }),
  );
  const tokens = await Promise.all(
    identities.map((a) =>
      new SignJWT({
        tid: tenant,
        oid: a.object,
        azp: clientId,
        scp: 'access_as_user',
        ver: '2.0',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'TEST_C04_KEY' })
        .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
        .setSubject(a.object)
        .setAudience(audience)
        .setIssuedAt()
        .setNotBefore('0s')
        .setExpirationTime('5m')
        .sign(privateKey),
    ),
  );
  let loseOnce = false;
  let committed: () => void = () => {};
  let releaseReply: () => void = () => {};
  const service = {
    read,
    write: async (
      i: Parameters<typeof store.write>[0],
      c: ReviewForemanCommand,
    ) => {
      const result = await store.write(i, c);
      if (loseOnce) {
        loseOnce = false;
        committed();
        await new Promise<void>((r) => {
          releaseReply = r;
        });
      }
      return result;
    },
  };
  class TestModule {}
  Module({
    controllers: [ManagerReviewController],
    providers: [
      { provide: TokenVerifier, useValue: verifier },
      { provide: MANAGER_REVIEW_SERVICE, useValue: service },
    ],
  })(TestModule);
  api = await NestFactory.create(TestModule, { logger: false });
  await api.listen(0, '127.0.0.1');
  const address = api.getHttpServer().address() as { port: number };
  assert.ok(address.port > 0);
  assert.ok(
    ![55343, 34103, 45103, 51464, 52034, 52035, 55362, 56319, 56330].includes(
      address.port,
    ),
  );
  writeFileSync(
    `${root}/API-LEASE.json`,
    JSON.stringify(
      {
        holder: lease.holder,
        pid: process.pid,
        port: address.port,
        syntheticOnly: true,
        database: lease.database,
        status: 'RUNNING_TEST_ONLY',
      },
      null,
      2,
    ),
  );
  const url = `http://127.0.0.1:${address.port}/api/report/manager-review`;
  const post = async (
    c: ReviewForemanCommand,
    index = 2,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens[index]}`,
        'content-type': 'application/json',
        'idempotency-key': c.clientMutationId,
        ...headers,
      },
      body: JSON.stringify(c),
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: r.status,
      body: (await r.json()) as {
        code?: string;
        eventId?: string;
        reviewVersion?: number;
      },
    };
  };
  const get = async (s = scope, index = 2) => {
    const r = await fetch(`${url}?${new URLSearchParams(s)}`, {
      headers: { authorization: `Bearer ${tokens[index]}` },
      signal: AbortSignal.timeout(8000),
    });
    return {
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    };
  };
  await check('TOKEN_VERIFIER_NO_AUTH_BYPASS', async () => {
    const r = await fetch(url);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { code: 'LOGIN_REQUIRED' });
    const x = await fetch(url, {
      headers: { authorization: 'Bearer TEST_INVALID_TOKEN' },
    });
    assert.equal(x.status, 401);
  });
  await check('AUTHORIZED_READ_NOT_IMPLICIT_CONFIRMATION', async () => {
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal((r.body['state'] as { status: string }).status, 'NOT_CHECKED');
    assert.equal(r.body['declaredQty'], '100');
  });
  const c = confirm();
  let firstEvent = '';
  await check('PARTIAL_SCOPE_SINGLE_ORIGINAL_QUANTITY', async () => {
    const r = await post(c);
    assert.equal(r.status, 200);
    firstEvent = r.body.eventId!;
    assert.equal(await count(), 1);
    const read = await get();
    assert.deepEqual(
      (read.body['state'] as { coverage: string; confirmedQty: string })
        .coverage,
      'PARTIAL',
    );
    assert.equal(
      (read.body['state'] as { confirmedQty: string }).confirmedQty,
      '40',
    );
    assert.equal(read.body['declaredQty'], '100');
    assert.ok(
      !Object.hasOwn(read.body['judgment'] as object, 'reviewerAccountId'),
    );
    assert.ok(!Object.hasOwn(read.body['evidence'] as object, 'orgId'));
  });
  await check('SAME_KEY_SAME_BODY_ONCE_CHANGED_BODY_REFUSED', async () => {
    const r = await post(c);
    assert.equal(r.body.eventId, firstEvent);
    assert.equal(await count(), 1);
    assert.equal(
      (await post({ ...c, limitations: 'TEST changed payload' })).body.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal(
      (await post({ ...c, expectedVersion: 1 }, 3)).body.code,
      'IDEMPOTENCY_KEY_REUSED',
    );
  });
  await check('HEADER_AND_CLIENT_AUTHORITY_FORGERY_REFUSED', async () => {
    assert.equal(
      (
        await post({ ...c, clientMutationId: randomUUID() }, 2, {
          'idempotency-key': randomUUID(),
        })
      ).body.code,
      'INVALID_INPUT',
    );
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens[2]}`,
        'content-type': 'application/json',
        'idempotency-key': c.clientMutationId,
      },
      body: JSON.stringify({
        ...c,
        orgId: foreignOrg,
        role: 'PROJECT_MANAGER',
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(await count(), 1);
  });
  await check('CROSS_TENANT_SCOPE_DENIED_EVEN_EMPTY', async () => {
    assert.equal(
      (await get({ ...scope, projectId: foreignProject })).status,
      403,
    );
  });
  await check('SAME_PERSON_MULTIPLE_ACCOUNTS_NOT_INDEPENDENT', async () => {
    for (const index of [0, 1]) {
      const r = await post(returned(1), index);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'SELF_REVIEW');
    }
    assert.equal(await count(), 1);
  });
  await check('REVOKED_GRANT_CHECKED_BEFORE_STORED_REPLAY', async () => {
    await change('active', false);
    assert.equal((await post(c)).body.code, 'FORBIDDEN');
    assert.equal(await count(), 1);
    await change('active', true);
  });
  await check('UNKNOWN_AND_CONFLICT_IDENTITY_CANNOT_REPLAY', async () => {
    await change('sourceResolved', false);
    assert.equal((await post(c)).body.code, 'IDENTITY_UNKNOWN');
    await change('sourceResolved', true);
    await change('independence', 'CONFLICT');
    assert.equal((await post(c)).body.code, 'REVIEW_CONFLICT');
    await change('independence', 'CLEAR');
  });
  await check('CHANGED_BASIS_AND_UNIT_REFUSE_NEW_CONFIRMATION', async () => {
    await change('evidenceVersion', 2);
    assert.equal((await post(confirm(1))).body.code, 'EVIDENCE_CHANGED');
    await change('evidenceVersion', 1);
    await change('evidenceUnit', 'TEST_other');
    assert.equal((await post(confirm(1))).body.code, 'UNIT_MISMATCH');
    await change('evidenceUnit', 'TEST_unit');
    assert.equal(await count(), 1);
  });
  await check(
    'MISSING_C05_PERMITS_RETURN_NOT_CONFIRMATION_REPLAY_PRECEDES_CAS',
    async () => {
      await change('evidence', false);
      assert.equal((await post(confirm(1))).body.code, 'EVIDENCE_CHANGED');
      assert.equal((await post(returned(1))).status, 200);
      assert.equal((await post(c)).body.eventId, firstEvent);
      assert.equal(await count(), 2);
      assert.equal((await get()).body['declaredQty'], '100');
      await change('evidence', true);
    },
  );
  await check('TWO_REVIEWERS_ONE_CAS_WINNER', async () => {
    const r = await Promise.all([post(returned(2), 2), post(returned(2), 3)]);
    assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
    assert.equal(
      r.find((x) => x.status === 409)!.body.code,
      'REVIEW_VERSION_CONFLICT',
    );
    assert.equal(await count(), 3);
  });
  await check('COMMITTED_HTTP_RESPONSE_LOSS_SAME_KEY_RETRY_ONCE', async () => {
    const command = returned(3);
    loseOnce = true;
    const afterCommit = new Promise<void>((r) => {
      committed = r;
    });
    const abort = new AbortController();
    const lost = fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens[2]}`,
        'content-type': 'application/json',
        'idempotency-key': command.clientMutationId,
      },
      body: JSON.stringify(command),
      signal: abort.signal,
    }).catch(() => null);
    await afterCommit;
    abort.abort();
    releaseReply();
    await lost;
    assert.equal(await count(), 4);
    assert.equal((await post(command)).status, 200);
    assert.equal(await count(), 4);
  });
  await check('EVENT_AUDIT_REPLAY_ATOMIC_AND_APPEND_ONLY', async () => {
    const r = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "AuditLog" WHERE "entityType"='ManagerReviewEvent'`,
    );
    assert.equal(Number(r.rows[0]!.n), 4);
    await assert.rejects(
      appPool.query(
        'UPDATE "ManagerReviewEvent" SET reason=\'TEST overwrite\'',
      ),
      { code: '42501' },
    );
    await assert.rejects(appPool.query('DELETE FROM "ManagerReviewEvent"'), {
      code: '42501',
    });
    await assert.rejects(
      owner.query('UPDATE "ManagerReviewEvent" SET reason=\'TEST overwrite\''),
    );
    assert.equal(await count(), 4);
    assert.equal(
      (await appPool.query('SELECT * FROM "ManagerReviewEvent"')).rowCount,
      0,
    );
  });
  await check('FAILED_AUDIT_ROLLS_BACK_EVENT_COUNTER_AND_REPLAY', async () => {
    const seq = (
      await owner.query(
        'SELECT "lastSeq" FROM "FieldDay" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3',
        [org, project, day],
      )
    ).rows[0].lastSeq;
    await owner.query(
      `CREATE FUNCTION test_review_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityType"='ManagerReviewEvent' AND NEW.reason='TEST rollback' THEN RAISE EXCEPTION 'TEST audit refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_review_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION test_review_audit_failure()`,
    );
    const command = { ...returned(4), reason: 'TEST rollback' };
    assert.equal((await post(command)).body.code, 'REQUEST_FAILED');
    assert.equal(await count(), 4);
    assert.equal(
      (
        await owner.query(
          'SELECT "lastSeq" FROM "FieldDay" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3',
          [org, project, day],
        )
      ).rows[0].lastSeq,
      seq,
    );
    assert.equal(
      (
        await owner.query('SELECT 1 FROM "IdempotencyRecord" WHERE key=$1', [
          command.clientMutationId,
        ])
      ).rowCount,
      0,
    );
    await owner.query(
      'DROP TRIGGER test_review_audit_failure ON "AuditLog"; DROP FUNCTION test_review_audit_failure()',
    );
  });
  await check('COMPOSITE_FOREIGN_SCOPE_AND_RLS_INSERT_REFUSED', async () => {
    await assert.rejects(
      owner.query(
        `INSERT INTO "ManagerReviewEvent" SELECT (jsonb_populate_record(NULL::"ManagerReviewEvent",to_jsonb(e)||jsonb_build_object('id',$1::uuid,'projectId',$2::uuid,'clientMutationId',$3::uuid))).* FROM "ManagerReviewEvent" e WHERE id=$4`,
        [randomUUID(), foreignProject, randomUUID(), firstEvent],
      ),
      { code: '23503' },
    );
    const e = (
      await owner.query('SELECT * FROM "ManagerReviewEvent" WHERE id=$1', [
        firstEvent,
      ])
    ).rows[0];
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id',$1,true)", [org]);
      await assert.rejects(
        c.query(
          `INSERT INTO "ManagerReviewEvent" SELECT (jsonb_populate_record(NULL::"ManagerReviewEvent",$1::jsonb)).*`,
          [
            JSON.stringify({
              ...e,
              id: randomUUID(),
              orgId: foreignOrg,
              clientMutationId: randomUUID(),
            }),
          ],
        ),
        { code: '42501' },
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    await assert.rejects(
      appPool.query('UPDATE "TESTReviewControl" SET active=false'),
      { code: '42501' },
    );
    assert.equal(await count(), 4);
  });
  await check(
    'R2_REQUIRES_NEW_REVIEW_R1_FACT_AND_EVENTS_PRESERVED',
    async () => {
      const before = await owner.query(
        'SELECT rows FROM "ForemanReportRevision" WHERE id=$1',
        [revision],
      );
      await addRevision(id(63), 2, '80');
      await owner.query('UPDATE "ForemanReport" SET "currentN"=2 WHERE id=$1', [
        report,
      ]);
      const r = await get();
      assert.equal(
        (r.body['state'] as { status: string }).status,
        'REVIEW_REQUIRED',
      );
      assert.equal(
        (r.body['state'] as { confirmedQty: null }).confirmedQty,
        null,
      );
      assert.equal((await post(returned(4))).body.code, 'TARGET_CHANGED');
      assert.deepEqual(
        (
          await owner.query(
            'SELECT rows FROM "ForemanReportRevision" WHERE id=$1',
            [revision],
          )
        ).rows,
        before.rows,
      );
      assert.equal(await count(), 4);
    },
  );
  writeFileSync(
    `${root}/integration-result.json`,
    JSON.stringify(
      {
        status: 'PASS_DEDICATED_TEST_ONLY',
        database: lease.database,
        checks,
        productionGrant: 'NONE',
        realC05Evidence: 'NOT_RUN',
        sharedSnapshotUiIntegration: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
  console.log(
    'C04 integration PASS',
    checks.length,
    'cases; synthetic TEST only',
  );
} catch (error) {
  writeFileSync(
    `${root}/integration-result.json`,
    JSON.stringify(
      {
        status: 'FAIL',
        failedCase: current,
        checks,
        errorCode:
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'ASSERTION_OR_HARNESS_ERROR',
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await api?.close();
  await appPool.end();
  await owner.end();
  writeFileSync(
    `${root}/API-STOPPED.json`,
    JSON.stringify({ pid: process.pid, status: 'STOPPED_OWN_TEST_API' }),
  );
}
