/** Synthetic TEST protocol harness only. Real parent source/gate/grant/media/snapshot exits remain separate acceptance. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import {
  BusinessEvidenceStore,
  BusinessEvidenceError,
} from '../packages/domain/dist/business-evidence-store.js';
import type { EvidenceDeclarationSource } from '../packages/domain/dist/business-evidence-store.js';
import { BusinessEvidenceReader } from '../packages/domain/dist/business-evidence-reader.js';
import type {
  BusinessEvidenceReadPorts,
  EvidenceReadCut,
} from '../packages/domain/dist/business-evidence-reader.js';
import {
  accountTransaction,
  projectAccess,
  ReportError,
} from '../packages/domain/dist/store-kit.js';
import type { Actor } from '../packages/domain/dist/store-kit.js';
import { evidenceNeedsReview } from '../packages/domain/dist/business-evidence-rules.js';
import type {
  BusinessEvidenceCommand,
  BusinessEvidenceReceipt,
  BusinessEvidenceService,
  EvidenceTarget,
  EvidenceWorkspace,
} from '../packages/contracts/dist/index.js';
import {
  InvalidReportInput,
  parseBusinessEvidenceReceipt,
} from '../packages/contracts/dist/index.js';
import {
  BusinessEvidenceController,
  BUSINESS_EVIDENCE_SERVICE,
} from '../apps/api/dist/business-evidence.controller.js';
import { TokenVerifier } from '../apps/api/dist/auth/token-verifier.js';
import {
  businessEvidencePorts,
  businessEvidenceService,
} from '../packages/domain/dist/business-evidence-adapters.js';

const runtimePath = process.env['C05_RESOURCE_MANIFEST'];
assert.ok(
  runtimePath && process.env['C05_SYNTHETIC_RUNTIME_ACK'] === 'TEST_ONLY',
  'explicit owned TEST runtime manifest required',
);
interface Runtime {
  id: string;
  root: string;
  host: string;
  port: number;
  database: string;
  ownerRole: string;
  appRole: string;
  privateCredentials: string;
  pid: number;
  api?: { pid: number; port: number; status: string };
  integration?: string;
}
const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as Runtime;
const fieldCloseout = runtime.id === 'A7-FIELD-CLOSEOUT-TEST-20261008';
assert.ok(fieldCloseout || runtime.id === 'C05-OWN-SYNTHETIC-PG-20261006');
assert.equal(runtime.host, '127.0.0.1');
assert.ok(
  fieldCloseout
    ? runtime.root === '/private/tmp/mje-a7-field-closeout-runtime-20261008' &&
        /^mje_a7_fc_test_[0-9a-f]{12}$/.test(runtime.database) &&
        runtime.ownerRole === 'postgres' &&
        /^mje_a7_fc_role_[0-9a-f]{12}$/.test(runtime.appRole)
    : runtime.database.startsWith('c05_') &&
        runtime.ownerRole.startsWith('c05_') &&
        runtime.appRole.startsWith('c05_'),
);
assert.ok(
  Number.isSafeInteger(runtime.port) &&
    runtime.port > 0 &&
    Number.isSafeInteger(runtime.pid),
);
const credentials = JSON.parse(
  await readFile(runtime.privateCredentials, 'utf8'),
) as { ownerPassword: string; appPassword: string };
const connection = (role: string, password: string) => {
  const url = new URL(
    `postgresql://${role}@127.0.0.1:${runtime.port}/${runtime.database}`,
  );
  url.password = password;
  return url.toString();
};
const owner = new Pool({
  connectionString: connection(runtime.ownerRole, credentials.ownerPassword),
  max: 4,
});
const pool = new Pool({
  connectionString: connection(runtime.appRole, credentials.appPassword),
  max: 8,
});
interface TestApp {
  listen(port: number, host: string): Promise<void>;
  getHttpServer(): { address(): AddressInfo | null };
  useGlobalFilters(filter: {
    catch(
      error: unknown,
      host: {
        switchToHttp(): {
          getResponse(): { status(n: number): { json(body: unknown): void } };
        };
      },
    ): void;
  }): void;
  close(): Promise<void>;
}
let app: TestApp | null = null;
const results: { id: string; status: string }[] = [];
let activeGroup = 'SETUP';
const check = async (id: string, run: () => Promise<void>) => {
  if (
    process.env['C05_FOCUSED_MEDIA_GATE'] === '1' &&
    ![
      'B08-real-PG-HTTP-bind4-reload',
      'B03-competing-fresh-basis-CAS',
      'B03-media-revoked-between-admission-and-gate',
    ].includes(id)
  )
    return;
  activeGroup = id;
  await run();
  results.push({ id, status: 'PASS' });
};
const record = async () =>
  writeFile(
    `${runtime.root}/integration-result.json`,
    JSON.stringify(
      {
        fixture:
          'TEST only; no real bytes/privacy/parent C04 or browser acceptance',
        results,
        notRun: [
          'Production ports/shared gate integration',
          'Actual C04 review append',
          'Parent submit/correction snapshot',
          'Blob byte/privacy acceptance',
          'Parent browser journey',
          'Independent Claude M1-M6 review',
        ],
      },
      null,
      2,
    ) + '\n',
  );
const tenantId = randomUUID(),
  audience = randomUUID(),
  clientId = randomUUID();
const orgA = randomUUID(),
  orgB = randomUUID(),
  project = randomUUID(),
  otherProject = randomUUID(),
  projectB = randomUUID();
const person = randomUUID(),
  otherPerson = randomUUID(),
  account = randomUUID(),
  twinAccount = randomUUID(),
  readerAccount = randomUUID(),
  accountB = randomUUID();
const objectId = randomUUID(),
  twinObject = randomUUID(),
  readerObject = randomUUID(),
  objectB = randomUUID();
const crew = randomUUID(),
  device = randomUUID(),
  report = randomUUID(),
  revision = randomUUID(),
  scope = randomUUID(),
  partial = randomUUID();
const photoIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const date = '2026-10-06';
const target: EvidenceTarget = {
  projectId: project,
  businessDate: date,
  crewId: crew,
  foremanRevisionId: revision,
  itemKey: 'TEST_WORK',
};
const bind = (
  basis: BusinessEvidenceReceipt['basis'] | null,
  photoId: string = photoIds[0]!,
  qty: string | null = '4',
  t = target,
): Extract<BusinessEvidenceCommand, { operation: 'BIND' }> => ({
  schemaVersion: 1,
  clientMutationId: randomUUID(),
  target: t,
  expectedRevision: 1,
  expectedBasis: basis,
  operation: 'BIND',
  photo: { photoId, photoVersion: 1 },
  coverage: {
    scopeRef: qty === null ? null : partial,
    withinScopeRef: qty === null ? null : scope,
    qty,
    unit: qty === null ? null : 'm',
  },
});
const unbind = (
  basis: BusinessEvidenceReceipt['basis'],
  linkId: string,
): BusinessEvidenceCommand => ({
  schemaVersion: 1,
  clientMutationId: randomUUID(),
  target,
  expectedRevision: 1,
  expectedBasis: basis,
  operation: 'UNBIND',
  linkId,
});
const identity = { tenantId, objectId };
const gateKey = (actor: Actor, t: EvidenceTarget) =>
  `TEST_C05_FIELD_GATE:${actor.orgId}:${t.projectId}:${t.businessDate}`;
let failAfterGate = false;
const ports: BusinessEvidenceReadPorts = {
  async resolveAuthority(client, actor, t) {
    const grant = await client.query<{ enabled: boolean }>(
      'SELECT enabled FROM "TEST_C05_Grant" WHERE "orgId"=$1 AND "accountId"=$2 AND "projectId"=$3 AND "crewId"=$4 AND "itemKey"=$5',
      [actor.orgId, actor.accountId, t.projectId, t.crewId, t.itemKey],
    );
    return grant.rows[0]?.enabled
      ? {
          orgId: actor.orgId,
          projectId: t.projectId,
          crewId: t.crewId,
          itemKey: t.itemKey,
          policyRef: 'TEST_FIXTURE_ASSOCIATION_POLICY',
          allowed: ['BIND', 'UNBIND'],
        }
      : null;
  },
  async resolveDeclaration(
    client,
    actor,
    t,
  ): Promise<EvidenceDeclarationSource | null> {
    const found = await client.query<{
      reportId: string;
      n: number;
      currentN: number;
      rows: { itemKey: string; qty: string }[];
      byPersonId: string;
      unit: string | null;
      scopeRef: string | null;
    }>(
      `SELECT r."reportId",r.n,f."currentN",r.rows,r."byPersonId",m.unit,m."scopeRef" FROM "ForemanReportRevision" r JOIN "ForemanReport" f ON f."orgId"=r."orgId" AND f."projectId"=r."projectId" AND f.id=r."reportId" LEFT JOIN "TEST_C05_SourceMetadata" m ON m."orgId"=r."orgId" AND m."revisionId"=r.id AND m."itemKey"=$6 WHERE r."orgId"=$1 AND r."projectId"=$2 AND r.id=$3 AND f."crewId"=$4 AND f."businessDate"=$5::date`,
      [
        actor.orgId,
        t.projectId,
        t.foremanRevisionId,
        t.crewId,
        t.businessDate,
        t.itemKey,
      ],
    );
    const row = found.rows[0],
      fact = row?.rows.find((r) => r.itemKey === t.itemKey);
    if (!row || !fact) return null;
    return {
      reportId: row.reportId,
      currentRevisionNumber: row.currentN,
      declaration: {
        orgId: actor.orgId,
        target: t,
        revisionNumber: row.n,
        qty: fact.qty,
        unit: row.unit ?? null,
        scopeRef: row.scopeRef ?? null,
        scopeStatus: row.scopeRef ? 'CONFIRMED' : 'PENDING',
        reportedByPersonId: row.byPersonId,
        reportedIdentityResolved: true,
        changedByPersonIds: [row.byPersonId],
      },
    };
  },
  async readMedia(client, actor, t, ref, purpose) {
    assert.ok(['BIND', 'UNBIND', 'READ'].includes(purpose));
    // Explicit TEST availability/permission records; these do not assert Blob bytes exist.
    const result = await client.query<{
      available: boolean;
      permitted: boolean;
    }>(
      `SELECT f.available,f.permitted FROM "PhotoEvidence" m JOIN "TEST_C05_Media" f ON f."orgId"=m."orgId" AND f."photoId"=m.id WHERE m."orgId"=$1 AND m."projectId"=$2 AND m."businessDate"=$3::date AND m.id=$4 AND m.version=$5`,
      [actor.orgId, t.projectId, t.businessDate, ref.photoId, ref.photoVersion],
    );
    const found = result.rows[0];
    return found
      ? {
          ...ref,
          orgId: actor.orgId,
          projectId: t.projectId,
          businessDate: t.businessDate,
          available: found.available,
          authorized: found.permitted,
        }
      : null;
  },
  async readScopes(client, actor) {
    const result = await client.query<{
      scopeRef: string;
      withinScopeRef: string;
      label: string;
    }>(
      'SELECT "scopeRef","withinScopeRef",label FROM "TEST_C05_Scope" WHERE "orgId"=$1',
      [actor.orgId],
    );
    return result.rows;
  },
  async withDayGate(client, actor, t, work) {
    // This TEST-only implementation verifies the port protocol. A7 supplies the actual field owner exit.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      gateKey(actor, t),
    ]);
    if (failAfterGate) throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    return work({
      async assertWritable() {
        const state = await client.query<{ frozen: boolean }>(
          'SELECT frozen FROM "TEST_C05_Day" WHERE "orgId"=$1 AND "projectId"=$2 AND day=$3::date',
          [actor.orgId, t.projectId, t.businessDate],
        );
        if (!state.rows[0] || state.rows[0].frozen)
          throw new BusinessEvidenceError('LOCKED');
      },
      async nextSequence() {
        const value = await client.query<{ seq: string }>(
          'UPDATE "FieldDay" SET "lastSeq"="lastSeq"+1 WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date RETURNING "lastSeq"::text AS seq',
          [actor.orgId, t.projectId, t.businessDate],
        );
        assert.ok(value.rows[0]);
        return Number(value.rows[0].seq);
      },
    });
  },
  async resolveReadCut(client, actor, t): Promise<EvidenceReadCut> {
    const { access } = await projectAccess(client, actor, t.projectId);
    if (access === 'write')
      return {
        kind: 'CURRENT',
        writable: !(
          await client.query<{ frozen: boolean }>(
            'SELECT frozen FROM "TEST_C05_Day" WHERE "orgId"=$1 AND "projectId"=$2 AND day=$3::date',
            [actor.orgId, t.projectId, t.businessDate],
          )
        ).rows[0]?.frozen,
      };
    const row = (
      await client.query<{
        manifestId: string;
        setId: string;
        version: number;
        seq: string;
      }>(
        'SELECT "manifestId","setId",version,seq::text FROM "TEST_C05_Snapshot" WHERE "orgId"=$1 AND "revisionId"=$2 AND "itemKey"=$3',
        [actor.orgId, t.foremanRevisionId, t.itemKey],
      )
    ).rows[0];
    return row
      ? {
          kind: 'FROZEN',
          daySeq: Number(row.seq),
          manifest: {
            id: row.manifestId,
            basis: { linkSetId: row.setId, version: row.version },
          },
        }
      : { kind: 'FROZEN', daySeq: 0, manifest: null };
  },
  async listMedia(client, actor, t) {
    return (
      await client.query<{
        photoId: string;
        photoVersion: number;
        label: string;
      }>(
        `SELECT m.id AS "photoId",m.version AS "photoVersion",'TEST media fixture'::text AS label FROM "PhotoEvidence" m JOIN "TEST_C05_Media" f ON f."orgId"=m."orgId" AND f."photoId"=m.id WHERE m."orgId"=$1 AND m."projectId"=$2 AND m."businessDate"=$3::date AND f.available AND f.permitted`,
        [actor.orgId, t.projectId, t.businessDate],
      )
    ).rows;
  },
};
const store = new BusinessEvidenceStore(pool, ports);
const service: BusinessEvidenceService = {
  write: (id, cmd) => store.write(id, cmd),
  read: (id, t) =>
    accountTransaction(
      pool,
      id,
      {
        admit: (m) =>
          m.some((r) =>
            ['PROJECT_MANAGER', 'EXECUTIVE_READER'].includes(r.role),
          ),
        forbidden: () => new BusinessEvidenceError('FORBIDDEN'),
      },
      (client, actor) => BusinessEvidenceReader.read(client, actor, t, ports),
    ),
};
const count = async () =>
  (
    await owner.query<{
      sets: number;
      versions: number;
      receipts: number;
      audits: number;
      seq: string;
    }>(
      `SELECT (SELECT count(*)::integer FROM "BusinessEvidenceSet") sets,(SELECT count(*)::integer FROM "BusinessEvidenceVersion") versions,(SELECT count(*)::integer FROM "IdempotencyRecord" WHERE route='business-evidence') receipts,(SELECT count(*)::integer FROM "AuditLog" WHERE "entityType"='BusinessEvidenceSet') audits,(SELECT "lastSeq"::text FROM "FieldDay" WHERE "projectId"=$1) seq`,
      [project],
    )
  ).rows[0]!;
const rejectCode = async (action: Promise<unknown>, code: string) =>
  assert.rejects(
    action,
    (e) => e instanceof Error && 'code' in e && e.code === code,
  );
const holdGate = async () => {
  const c = await owner.connect();
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `TEST_C05_FIELD_GATE:${orgA}:${project}:${date}`,
  ]);
  return c;
};
const waitForWaiter = async () => {
  const key = `TEST_C05_FIELD_GATE:${orgA}:${project}:${date}`;
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const { n } = (
      await owner.query<{ n: number }>(
        `SELECT count(*)::integer n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND ((classid::bigint<<32)|objid::bigint)=hashtextextended($1,0)`,
        [key],
      )
    ).rows[0]!;
    if (n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('TEST gate waiter timeout');
};
try {
  assert.match(
    (await owner.query<{ version: string }>('SELECT version()')).rows[0]!
      .version,
    /PostgreSQL 17\.6/,
  );
  await owner.query(`CREATE TABLE "TEST_C05_Grant"("orgId" uuid,"accountId" uuid,"projectId" uuid,"crewId" uuid,"itemKey" text,enabled boolean,PRIMARY KEY("orgId","accountId","projectId","crewId","itemKey"));
CREATE TABLE "TEST_C05_SourceMetadata"("orgId" uuid,"revisionId" uuid,"itemKey" text,unit text,"scopeRef" uuid,PRIMARY KEY("orgId","revisionId","itemKey"));
CREATE TABLE "TEST_C05_Media"("orgId" uuid,"photoId" uuid,available boolean,permitted boolean,PRIMARY KEY("orgId","photoId"));
CREATE TABLE "TEST_C05_Scope"("orgId" uuid,"scopeRef" uuid,"withinScopeRef" uuid,label text);
CREATE TABLE "TEST_C05_Day"("orgId" uuid,"projectId" uuid,day date,frozen boolean);
CREATE TABLE "TEST_C05_Snapshot"("orgId" uuid,"revisionId" uuid,"itemKey" text,"manifestId" uuid,"setId" uuid,version integer,seq bigint);
CREATE TABLE "TEST_C05_Review"("orgId" uuid,"setId" uuid,version integer);
CREATE TABLE "TEST_C05_Fault"(phase text,enabled boolean);
GRANT SELECT ON "TEST_C05_Grant","TEST_C05_SourceMetadata","TEST_C05_Media","TEST_C05_Scope","TEST_C05_Day","TEST_C05_Snapshot" TO mje_alpha_app;
CREATE FUNCTION test_c05_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM public."TEST_C05_Fault" WHERE phase=TG_ARGV[0] AND enabled) THEN RAISE EXCEPTION 'TEST C05 forced atomic failure'; END IF;RETURN NEW;END $$;
CREATE TRIGGER test_c05_audit_failure BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN(NEW."entityType"='BusinessEvidenceSet') EXECUTE FUNCTION test_c05_failure('AUDIT');
CREATE TRIGGER test_c05_receipt_failure BEFORE INSERT ON "IdempotencyRecord" FOR EACH ROW WHEN(NEW.route='business-evidence') EXECUTE FUNCTION test_c05_failure('RECEIPT');
GRANT SELECT ON "TEST_C05_Fault" TO mje_alpha_app;`);
  for (const table of [
    'Grant',
    'SourceMetadata',
    'Media',
    'Scope',
    'Day',
    'Snapshot',
  ])
    await owner.query(
      `ALTER TABLE "TEST_C05_${table}" ENABLE ROW LEVEL SECURITY; CREATE POLICY test_org ON "TEST_C05_${table}" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true))`,
    );
  const seed = randomUUID();
  for (const o of [orgA, orgB])
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST C05 organization\',now(),$2)',
      [o, seed],
    );
  for (const [id, org] of [
    [person, orgA],
    [otherPerson, orgB],
  ])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST synthetic person\')',
      [id, org, seed],
    );
  for (const [id, org] of [
    [project, orgA],
    [otherProject, orgA],
    [projectB, orgB],
  ] as const)
    await owner.query(
      'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,$4,\'TEST C05 project\',\'Europe/Belgrade\',\'ACTIVE\')',
      [id, org, seed, 'TEST-' + id.slice(0, 8)],
    );
  for (const [id, org, p, obj] of [
    [account, orgA, person, objectId],
    [twinAccount, orgA, person, twinObject],
    [readerAccount, orgA, person, readerObject],
    [accountB, orgB, otherPerson, objectB],
  ])
    await owner.query(
      'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
      [id, org, seed, tenantId, obj, p],
    );
  for (const [id, org, p, r] of [
    [account, orgA, project, 'PROJECT_MANAGER'],
    [twinAccount, orgA, project, 'PROJECT_MANAGER'],
    [readerAccount, orgA, null, 'EXECUTIVE_READER'],
    [accountB, orgB, projectB, 'PROJECT_MANAGER'],
  ])
    await owner.query(
      'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,$4,now(),$5,$6)',
      [randomUUID(), org, seed, r, id, p],
    );
  await owner.query(
    'INSERT INTO "Crew"(id,"orgId","projectId",code,name,"createdBy") VALUES($1,$2,$3,\'TEST_C05\',\'TEST C05 crew\',$4)',
    [crew, orgA, project, account],
  );
  await owner.query(
    'INSERT INTO "FieldDevice"(id,"orgId","projectId","personId",state,"tokenHash","pendingUntil","expiresAt","lastSeenAt") VALUES($1,$2,$3,$4,\'PENDING\',$5,now()+interval \'1 hour\',now()+interval \'2 hours\',now())',
    [device, orgA, project, person, 'a'.repeat(64)],
  );
  await owner.query(
    'INSERT INTO "FieldDay"(id,"orgId","projectId","businessDate","lastSeq") VALUES($1,$2,$3,$4::date,1)',
    [randomUUID(), orgA, project, date],
  );
  await owner.query(
    'INSERT INTO "ForemanReport"(id,"orgId","projectId","crewId","businessDate","currentN") VALUES($1,$2,$3,$4,$5::date,1)',
    [report, orgA, project, crew, date],
  );
  const rows = [
    { itemKey: 'TEST_WORK', qty: '10' },
    { itemKey: 'TEST_BLANK', qty: '' },
    { itemKey: 'TEST_UNKNOWN', qty: 'unknown' },
    { itemKey: 'TEST_NA', qty: 'na' },
    { itemKey: 'TEST_ZERO', qty: '0.000000' },
    { itemKey: 'TEST_ROLLBACK', qty: '10' },
  ];
  await owner.query(
    'INSERT INTO "ForemanReportRevision"(id,"orgId","projectId","reportId",n,rows,note,"byPersonId","byDeviceId","occurredAt","receivedAt","siteTimezone","daySeq") VALUES($1,$2,$3,$4,1,$5,\'TEST immutable declaration\',$6,$7,now(),now(),\'Europe/Belgrade\',1)',
    [revision, orgA, project, report, JSON.stringify(rows), person, device],
  );
  for (const row of rows) {
    await owner.query(
      'INSERT INTO "TEST_C05_SourceMetadata" VALUES($1,$2,$3,\'m\',$4)',
      [orgA, revision, row.itemKey, scope],
    );
    for (const a of [account, twinAccount])
      await owner.query(
        'INSERT INTO "TEST_C05_Grant" VALUES($1,$2,$3,$4,$5,true)',
        [orgA, a, project, crew, row.itemKey],
      );
  }
  await owner.query(
    "INSERT INTO \"TEST_C05_Scope\" VALUES($1,$2,$2,'TEST whole'),($1,$3,$2,'TEST partial')",
    [orgA, scope, partial],
  );
  await owner.query('INSERT INTO "TEST_C05_Day" VALUES($1,$2,$3::date,false)', [
    orgA,
    project,
    date,
  ]);
  for (const id of photoIds) {
    const hash = createHash('sha256')
      .update('TEST synthetic ref ' + id)
      .digest('hex');
    await owner.query(
      'INSERT INTO "PhotoEvidence"(id,"orgId","updatedAt","updatedBy","projectId","businessDate",source,"uploadedByAccountId","uploadedByPersonId",sha256,"blobKey","mediaType","sizeBytes") VALUES($1,$2,now(),$3,$4,$5::date,\'album\',$3,$6,$7,$8,\'image/jpeg\',1)',
      [id, orgA, account, project, date, person, hash, orgA + '/' + hash],
    );
    await owner.query('INSERT INTO "TEST_C05_Media" VALUES($1,$2,true,true)', [
      orgA,
      id,
    ]);
  }
  const requireApi = createRequire(
    new URL('../apps/api/package.json', import.meta.url),
  );
  const { Module } = await import(requireApi.resolve('@nestjs/common'));
  const { NestFactory } = (await import(
    requireApi.resolve('@nestjs/core')
  )) as {
    NestFactory: {
      create(module: unknown, options: { logger: false }): Promise<TestApp>;
    };
  };
  const { createLocalJWKSet, generateKeyPair, exportJWK, SignJWT } =
    (await import(
      requireApi.resolve('jose')
    )) as typeof import('../apps/api/node_modules/jose/dist/types/index.js');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk['kid'] = 'TEST_C05_KEY';
  const verifier = new TokenVerifier(
    { tenantId, audience, clientId, scope: 'access_as_user' },
    createLocalJWKSet({ keys: [jwk] }),
  );
  class EvidenceTestModule {}
  Module({
    controllers: [BusinessEvidenceController],
    providers: [
      { provide: BUSINESS_EVIDENCE_SERVICE, useValue: service },
      { provide: TokenVerifier, useValue: verifier },
    ],
  })(EvidenceTestModule);
  app = await NestFactory.create(EvidenceTestModule, { logger: false });
  // TEST envelope only; parent must register the C05 codes in its real safe filter.
  app.useGlobalFilters({
    catch(error, host) {
      if (
        error instanceof Error &&
        'getStatus' in error &&
        'getResponse' in error &&
        typeof error.getStatus === 'function' &&
        typeof error.getResponse === 'function'
      ) {
        const response = error.getResponse() as unknown;
        if (
          response &&
          typeof response === 'object' &&
          'code' in response &&
          typeof response.code === 'string' &&
          /^[A-Z_]{1,50}$/.test(response.code)
        ) {
          host
            .switchToHttp()
            .getResponse()
            .status(error.getStatus() as number)
            .json({ code: response.code });
          return;
        }
      }
      const code =
        error instanceof BusinessEvidenceError || error instanceof ReportError
          ? error.code
          : error instanceof InvalidReportInput
            ? 'INVALID_INPUT'
            : error instanceof Error && 'getStatus' in error
              ? 'LOGIN_REQUIRED'
              : 'REQUEST_FAILED';
      const status =
        code === 'LOGIN_REQUIRED'
          ? 401
          : code === 'FORBIDDEN' || code === 'READ_ONLY'
            ? 403
            : code === 'INVALID_INPUT'
              ? 400
              : code === 'REQUEST_FAILED'
                ? 500
                : 409;
      host.switchToHttp().getResponse().status(status).json({ code });
    },
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  assert.ok(address);
  runtime.api = {
    pid: process.pid,
    port: address.port,
    status: 'BOUND_BEFORE_JOURNEY',
  };
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2) + '\n');
  const base = `http://127.0.0.1:${address.port}/api/report/business-evidence`;
  const token = async (obj: string) =>
    new SignJWT({
      tid: tenantId,
      oid: obj,
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'TEST_C05_KEY' })
      .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .setAudience(audience)
      .setSubject(obj)
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime('10m')
      .sign(privateKey);
  const pmToken = await token(objectId),
    readerToken = await token(readerObject);
  const httpWrite = async (
    command: BusinessEvidenceCommand,
    auth = pmToken,
    key = command.clientMutationId,
  ) => {
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + auth,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(command),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const httpRead = async (
    auth = pmToken,
    t = target,
  ): Promise<EvidenceWorkspace> => {
    const response = await fetch(base + '?' + new URLSearchParams({ ...t }), {
      headers: { authorization: 'Bearer ' + auth },
    });
    assert.equal(response.status, 200);
    return (await response.json()) as EvidenceWorkspace;
  };
  let latest!: BusinessEvidenceReceipt;
  let initial!: BusinessEvidenceReceipt;
  let first!: BusinessEvidenceCommand;
  if (fieldCloseout)
    await check(
      'A7-actual-immutable-source-and-default-policy-ports',
      async () => {
        const concrete = businessEvidenceService(pool, businessEvidencePorts());
        const identity = { tenantId, objectId };
        const before = await count();
        const view = await concrete.read(identity, target);
        assert.equal(view.declaration.qty, '10');
        assert.equal(view.declaration.unit, null);
        assert.equal(view.declaration.scopeRef, null);
        assert.equal(view.revisionNumber, 1);
        assert.equal(view.canBind, false);
        assert.deepEqual(view.availablePhotos, []);
        await assert.rejects(
          concrete.write(identity, bind(null)),
          (e: unknown) =>
            e instanceof BusinessEvidenceError && e.code === 'FORBIDDEN',
        );
        assert.deepEqual(await count(), before);
      },
    );
  await check(
    'B01-auth-strict-input-default-deny-cross-boundaries',
    async () => {
      const privileges = (
        await pool.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>(
          'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0]!;
      assert.deepEqual(privileges, {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const before = await count();
      assert.equal((await httpWrite(bind(null), 'invalid')).status, 401);
      assert.equal(
        (await httpWrite(bind(null), pmToken, randomUUID())).status,
        400,
      );
      await rejectCode(
        new BusinessEvidenceStore(pool).write(identity, bind(null)),
        'FORBIDDEN',
      );
      await rejectCode(
        store.write(
          identity,
          bind(null, photoIds[0]!, '4', { ...target, projectId: otherProject }),
        ),
        'FORBIDDEN',
      );
      await rejectCode(
        store.write({ tenantId, objectId: objectB }, bind(null)),
        'FORBIDDEN',
      );
      await owner.query(
        'UPDATE "TEST_C05_Grant" SET enabled=false WHERE "accountId"=$1',
        [account],
      );
      await rejectCode(store.write(identity, bind(null)), 'FORBIDDEN');
      await owner.query(
        'UPDATE "TEST_C05_Grant" SET enabled=true WHERE "accountId"=$1',
        [account],
      );
      await rejectCode(
        store.write(identity, {
          ...bind(null),
          operation: 'BIND',
          photo: { photoId: photoIds[0]!, photoVersion: 2 },
        }),
        'FORBIDDEN',
      );
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.org_id',$1,true)", [orgB]);
        assert.equal(
          (await client.query('SELECT * FROM "BusinessEvidenceSet"')).rowCount,
          0,
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      assert.deepEqual(await count(), before);
    },
  );
  await check('B07-active-and-closed-account-read-context', async () => {
    const closed = await accountTransaction(
      pool,
      identity,
      {
        admit: () => true,
        forbidden: () => new BusinessEvidenceError('FORBIDDEN'),
      },
      async (client, actor) => ({ client, actor }),
    );
    await rejectCode(
      BusinessEvidenceReader.read(closed.client, closed.actor, target, ports),
      'INTEGRATION_REQUIRED',
    );
    assert.equal((await service.read(identity, target)).declaration.qty, '10');
  });
  await check('B08-real-PG-HTTP-bind4-reload', async () => {
    first = bind(null);
    const response = await httpWrite(first);
    assert.equal(response.status, 200);
    latest = initial = parseBusinessEvidenceReceipt(response.body);
    const ws = await httpRead();
    assert.equal(ws.declaration.qty, '10');
    assert.equal(ws.evidence?.coverage?.qty, '4');
    assert.equal(ws.evidence?.state, 'PARTIAL');
    assert.deepEqual((await httpRead()).evidence?.basis, initial.basis);
  });
  await check(
    'B02-concurrent-lost-receipt-replay-and-key-conflict',
    async () => {
      const before = await count();
      const [a, b] = await Promise.all([httpWrite(first), httpWrite(first)]);
      assert.equal(a.status, 200);
      assert.deepEqual(a.body, b.body);
      assert.deepEqual(await count(), before);
      await rejectCode(
        store.write(identity, {
          ...first,
          coverage: {
            scopeRef: partial,
            withinScopeRef: scope,
            qty: '5',
            unit: 'm',
          },
        } as BusinessEvidenceCommand),
        'IDEMPOTENCY_KEY_REUSED',
      );
      await owner.query(
        'UPDATE "TEST_C05_Grant" SET enabled=false WHERE "accountId"=$1',
        [account],
      );
      await rejectCode(store.write(identity, first), 'FORBIDDEN');
      await owner.query(
        'UPDATE "TEST_C05_Grant" SET enabled=true WHERE "accountId"=$1',
        [account],
      );
      await owner.query(
        'UPDATE "TEST_C05_Media" SET permitted=false WHERE "photoId"=$1',
        [photoIds[0]],
      );
      await rejectCode(store.write(identity, first), 'FORBIDDEN');
      await owner.query(
        'UPDATE "TEST_C05_Media" SET permitted=true WHERE "photoId"=$1',
        [photoIds[0]],
      );
      assert.deepEqual(await count(), before);
    },
  );
  await check('B03-competing-fresh-basis-CAS', async () => {
    const a = bind(latest.basis, photoIds[1]!),
      b = bind(latest.basis, photoIds[2]!);
    const outcomes = await Promise.allSettled([
      store.write(identity, a),
      store.write(identity, b),
    ]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    const success = outcomes.find((o) => o.status === 'fulfilled');
    assert.ok(success?.status === 'fulfilled');
    latest = success.value;
    const fail = outcomes.find((o) => o.status === 'rejected');
    assert.ok(fail?.status === 'rejected');
    assert.equal(
      (fail.reason as BusinessEvidenceError).code,
      'EVIDENCE_CHANGED',
    );
  });
  await check('B03-media-revoked-between-admission-and-gate', async () => {
    const photo = (await httpRead()).evidence!.photos[0]!;
    const before = await count();
    const held = await holdGate();
    try {
      const pending = store.write(identity, unbind(latest.basis, photo.linkId));
      pending.catch(() => undefined);
      await waitForWaiter();
      await held.query(
        'UPDATE "TEST_C05_Media" SET permitted=false WHERE "photoId"=$1',
        [photo.photoId],
      );
      await held.query('COMMIT');
      await rejectCode(pending, 'FORBIDDEN');
    } finally {
      await held.query('ROLLBACK');
      held.release();
      await owner.query(
        'UPDATE "TEST_C05_Media" SET permitted=true WHERE "photoId"=$1',
        [photo.photoId],
      );
    }
    assert.deepEqual(await count(), before);
  });
  await check(
    'B02-no-op-canonical-receipt-tenant-key-twin-account',
    async () => {
      const ws = await httpRead();
      const ref = ws.evidence!.photos[0]!;
      const command = bind(latest.basis, ref.photoId, '4.000000');
      const before = await count();
      const receipt = await store.write(identity, command);
      assert.equal(receipt.changed, false);
      assert.deepEqual(receipt.basis, latest.basis);
      assert.equal((await httpRead()).associationCoverage?.qty, '4');
      await rejectCode(
        store.write({ tenantId, objectId: twinObject }, command),
        'IDEMPOTENCY_KEY_REUSED',
      );
      const after = await count();
      assert.equal(after.versions, before.versions);
      assert.equal(after.seq, before.seq);
      assert.equal(after.receipts, before.receipts + 1);
    },
  );
  await check('B07-atomic-rollback-at-audit-and-receipt', async () => {
    for (const phase of ['AUDIT', 'RECEIPT']) {
      await owner.query('INSERT INTO "TEST_C05_Fault" VALUES($1,true)', [
        phase,
      ]);
      const before = await count();
      const response = await httpWrite(
        bind(null, photoIds[3]!, '4', { ...target, itemKey: 'TEST_ROLLBACK' }),
      );
      assert.equal(response.status, 500);
      assert.deepEqual(await count(), before);
      await owner.query('DELETE FROM "TEST_C05_Fault" WHERE phase=$1', [phase]);
    }
    failAfterGate = true;
    const before = await count();
    await rejectCode(
      store.write(identity, bind(latest.basis, photoIds[3]!)),
      'INTEGRATION_REQUIRED',
    );
    failAfterGate = false;
    assert.deepEqual(await count(), before);
  });
  await check(
    'B04-original-values-null-zero-and-six-decimal-limit',
    async () => {
      for (const itemKey of ['TEST_BLANK', 'TEST_UNKNOWN', 'TEST_NA']) {
        const t = { ...target, itemKey };
        await rejectCode(
          store.write(identity, bind(null, photoIds[0]!, '0', t)),
          'QUANTITY_UNKNOWN',
        );
        await store.write(identity, bind(null, photoIds[0]!, null, t));
        const ws = await httpRead(pmToken, t);
        assert.equal(ws.associationCoverage?.qty, null);
        assert.equal(ws.evidence?.coverage, null);
        assert.equal(
          ws.declaration.qty,
          itemKey === 'TEST_BLANK'
            ? ''
            : itemKey === 'TEST_UNKNOWN'
              ? 'unknown'
              : 'na',
        );
      }
      const zero = bind(null, photoIds[0]!, '0.000000', {
        ...target,
        itemKey: 'TEST_ZERO',
      });
      if (zero.operation === 'BIND') zero.coverage.scopeRef = scope;
      await store.write(identity, zero);
      assert.equal(
        (await httpRead(pmToken, zero.target)).declaration.qty,
        '0.000000',
      );
      await rejectCode(
        store.write(identity, bind(latest.basis, photoIds[3]!, '10.000001')),
        'COVERAGE_INVALID',
      );
    },
  );
  await check('B05-frozen4-correction6-and-immutable-history', async () => {
    await owner.query(
      'INSERT INTO "TEST_C05_Snapshot" VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        orgA,
        revision,
        target.itemKey,
        initial.manifestId,
        initial.basis.linkSetId,
        initial.basis.version,
        initial.daySeq,
      ],
    );
    await owner.query('UPDATE "TEST_C05_Day" SET frozen=true');
    await rejectCode(
      store.write(identity, bind(latest.basis, photoIds[3]!)),
      'LOCKED',
    );
    assert.equal((await httpRead(readerToken)).evidence?.coverage?.qty, '4');
    await owner.query('UPDATE "TEST_C05_Day" SET frozen=false'); // Explicit TEST correction gate, not parent report workflow.
    for (const ref of (await httpRead()).evidence!.photos) {
      const cmd = unbind(latest.basis, ref.linkId);
      latest = await store.write(identity, cmd);
      assert.deepEqual(await store.write(identity, cmd), latest);
    }
    latest = await store.write(identity, bind(latest.basis, photoIds[0]!, '6'));
    const current = await httpRead();
    assert.equal(current.evidence?.coverage?.qty, '6');
    assert.equal(current.declaration.qty, '10');
    assert.equal(
      current.history.find((v) => v.basis.version === initial.basis.version)
        ?.coverage?.qty,
      '4',
    );
    assert.equal((await httpRead(readerToken)).evidence?.coverage?.qty, '4');
    const c = await pool.connect();
    try {
      for (const sql of [
        'UPDATE "BusinessEvidenceVersion" SET state=\'READY\'',
        'DELETE FROM "BusinessEvidenceVersion"',
        'UPDATE "BusinessEvidenceSet" SET "itemKey"=\'TEST_X\'',
        'DELETE FROM "BusinessEvidenceSet"',
      ]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.org_id',$1,true)", [orgA]);
        await assert.rejects(c.query(sql));
        await c.query('ROLLBACK');
      }
    } finally {
      c.release();
    }
    await assert.rejects(
      owner.query(
        'UPDATE "BusinessEvidenceVersion" SET state=\'READY\' WHERE id=$1',
        [initial.manifestId],
      ),
    );
    assert.equal(
      (
        await owner.query<{ coverage: { qty: string } }>(
          'SELECT "coverageJson" coverage FROM "BusinessEvidenceVersion" WHERE id=$1',
          [initial.manifestId],
        )
      ).rows[0]!.coverage.qty,
      '4',
    );
  });
  await check(
    'B06-unavailable-current-frozen-state-and-authenticated-history',
    async () => {
      await owner.query(
        'UPDATE "TEST_C05_Media" SET available=false WHERE "photoId"=$1',
        [photoIds[0]],
      );
      assert.equal((await httpRead()).evidence?.state, 'MISSING');
      assert.equal((await httpRead(readerToken)).evidence?.state, 'PARTIAL');
      assert.deepEqual(await store.write(identity, first), initial); // Authorization still valid; unavailable media cannot undo a receipt.
      await owner.query(
        'UPDATE "TEST_C05_Media" SET permitted=false WHERE "photoId"=$1',
        [photoIds[0]],
      );
      await rejectCode(service.read(identity, target), 'FORBIDDEN');
      await rejectCode(
        service.read({ tenantId, objectId: readerObject }, target),
        'FORBIDDEN',
      );
      await owner.query(
        'UPDATE "TEST_C05_Media" SET available=true,permitted=true WHERE "photoId"=$1',
        [photoIds[0]],
      );
    },
  );
  await check('B03-TEST-review-gate-order-and-basis-staleness', async () => {
    const held = await holdGate();
    try {
      const pending = store.write(
        identity,
        bind(latest.basis, photoIds[3]!, '6'),
      );
      pending.catch(() => undefined);
      await waitForWaiter();
      await held.query('INSERT INTO "TEST_C05_Review" VALUES($1,$2,$3)', [
        orgA,
        latest.basis.linkSetId,
        latest.basis.version,
      ]);
      await held.query('COMMIT');
      latest = await pending;
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    const review = (
      await owner.query<{ setId: string; version: number }>(
        'SELECT "setId",version FROM "TEST_C05_Review"',
      )
    ).rows[0]!;
    const currentEvidence = (await httpRead()).evidence;
    assert.equal(
      evidenceNeedsReview(
        currentEvidence ? { ...currentEvidence, orgId: orgA } : null,
        {
          target,
          basis: { linkSetId: review.setId, version: review.version },
        },
      ),
      true,
    );
  });
  await check(
    'B03-source-head-under-gate-and-replay-before-fresh-CAS',
    async () => {
      const held = await holdGate();
      try {
        const pending = store.write(
          identity,
          bind(latest.basis, photoIds[2]!, '6'),
        );
        pending.catch(() => undefined);
        await waitForWaiter();
        await held.query(
          'UPDATE "ForemanReport" SET "currentN"=2 WHERE id=$1',
          [report],
        );
        const nextSeq = (
          await held.query<{ seq: string }>(
            'UPDATE "FieldDay" SET "lastSeq"="lastSeq"+1 WHERE "projectId"=$1 RETURNING "lastSeq"::text seq',
            [project],
          )
        ).rows[0]!.seq;
        await held.query(
          'INSERT INTO "ForemanReportRevision"(id,"orgId","projectId","reportId",n,rows,note,"byPersonId","byDeviceId","occurredAt","receivedAt","siteTimezone","daySeq") VALUES($1,$2,$3,$4,2,$5,\'TEST next immutable source\',$6,$7,now(),now(),\'Europe/Belgrade\',$8)',
          [
            randomUUID(),
            orgA,
            project,
            report,
            JSON.stringify(rows),
            person,
            device,
            nextSeq,
          ],
        );
        await held.query('COMMIT');
        await rejectCode(pending, 'REVISION_CONFLICT');
      } finally {
        await held.query('ROLLBACK');
        held.release();
      }
      assert.deepEqual(await store.write(identity, first), initial);
      assert.equal((await httpRead()).canBind, false);
      assert.equal((await httpRead()).declaration.qty, '10');
    },
  );
  await check(
    'B01-nonempty-RLS-project-foreign-key-and-connection-isolation',
    async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.org_id',$1,true)", [orgB]);
        assert.equal(
          (await client.query('SELECT * FROM "BusinessEvidenceVersion"'))
            .rowCount,
          0,
        );
        await assert.rejects(
          client.query(
            'INSERT INTO "BusinessEvidenceSet" VALUES($1,$2,$3,$4::date,$5,$6,$7,$8)',
            [randomUUID(), orgB, project, date, crew, revision, 'TEST_WORK'],
          ),
        );
        await client.query('ROLLBACK');
        assert.equal(
          (await client.query('SELECT * FROM "BusinessEvidenceSet"')).rowCount,
          0,
        );
      } finally {
        client.release();
      }
      await assert.rejects(
        owner.query(
          'INSERT INTO "BusinessEvidenceSet" VALUES($1,$2,$3,$4::date,$5,$6,$7,$8)',
          [randomUUID(), orgA, otherProject, date, crew, revision, 'TEST_WORK'],
        ),
      );
      await assert.rejects(
        owner.query(
          'INSERT INTO "BusinessEvidenceSet" VALUES($1,$2,$3,$4::date,$5,$6,$7,$8)',
          [
            randomUUID(),
            orgA,
            project,
            date,
            crew,
            revision,
            'TEST_MISSING_ITEM',
          ],
        ),
      );
      const source = (
        await owner.query<{ rows: unknown }>(
          'SELECT rows FROM "ForemanReportRevision" WHERE id=$1',
          [revision],
        )
      ).rows[0]!.rows;
      assert.deepEqual(source, rows);
    },
  );
  runtime.integration = 'PASS_PROTOCOL_WITH_EXPLICIT_TEST_PORTS';
  await record();
  console.log(
    JSON.stringify({
      status: runtime.integration,
      groups: results.length,
      apiPort: runtime.api.port,
      notRun: 'Real parent/media/browser/review integration',
    }),
  );
} catch (error) {
  runtime.integration = 'FAIL';
  results.push({
    id: activeGroup,
    status: error instanceof Error ? error.message.slice(0, 300) : 'UNKNOWN',
  });
  await record();
  throw error;
} finally {
  if (app) {
    await app.close();
    if (runtime.api) runtime.api.status = 'CLOSED';
  }
  await pool.end();
  await owner.end();
  await writeFile(runtimePath, JSON.stringify(runtime, null, 2) + '\n');
}
