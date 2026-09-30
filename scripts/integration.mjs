// Synthetic TEST fixtures only; no source-document regression is executed here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const org = randomUUID(),
  otherOrg = randomUUID(),
  actor = randomUUID();
let checks = 0;
async function rejects(sql, args, code) {
  await db.query('SAVEPOINT negative_case');
  try {
    await db.query(sql, args);
    assert.fail('Expected database rejection');
  } catch (e) {
    assert.equal(e.code, code);
    checks++;
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT negative_case');
  }
}
try {
  await db.query('BEGIN');
  for (const id of [org, otherOrg])
    await db.query(
      `INSERT INTO "Organization" (id,name,"updatedAt","updatedBy") VALUES ($1,'TEST_PHASE0',now(),$2)`,
      [id, actor],
    );
  const person = randomUUID();
  await db.query(
    `INSERT INTO "Person" (id,"orgId","displayName","updatedAt","updatedBy") VALUES ($1,$2,'TEST_PERSON_NOT_REAL',now(),$3)`,
    [person, org, actor],
  );
  await rejects(
    `INSERT INTO "LoginAccount" (id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES ($1,$2,$3,'TEST','TEST',now(),$4)`,
    [randomUUID(), otherOrg, person, actor],
    '23503',
  );
  const insertLabor = `INSERT INTO "LaborEntry" (id,"orgId","personId","businessDate","siteTimezone","startAt","endAt","netMinutes",precision,"laborKind","payTimeKind","acceptedLedger","updatedAt","updatedBy") VALUES ($1,$2,$3,'2030-01-15','Europe/Belgrade',$4,$5,60,'INTERVAL','DIRECT','UNKNOWN',$6,now(),$7)`;
  await db.query(insertLabor, [
    randomUUID(),
    org,
    person,
    '2030-01-15T08:00Z',
    '2030-01-15T09:00Z',
    true,
    actor,
  ]);
  await rejects(
    insertLabor,
    [
      randomUUID(),
      org,
      person,
      '2030-01-15T08:30Z',
      '2030-01-15T09:30Z',
      true,
      actor,
    ],
    '23P01',
  );
  await db.query(insertLabor, [
    randomUUID(),
    org,
    person,
    '2030-01-15T08:30Z',
    '2030-01-15T09:30Z',
    false,
    actor,
  ]);
  checks++;
  await db.query(insertLabor, [
    randomUUID(),
    org,
    person,
    '2030-01-15T09:00Z',
    '2030-01-15T10:00Z',
    true,
    actor,
  ]);
  checks++;
  const changed = await db.query(
    `UPDATE "Person" SET version=version+1,"updatedAt"=now() WHERE id=$1 AND "orgId"=$2 AND version=1`,
    [person, org],
  );
  const stale = await db.query(
    `UPDATE "Person" SET version=version+1 WHERE id=$1 AND "orgId"=$2 AND version=1`,
    [person, org],
  );
  assert.equal(changed.rowCount, 1);
  assert.equal(stale.rowCount, 0);
  checks++;
  const idem = `INSERT INTO "IdempotencyRecord" (id,"orgId","actorId",route,key,"requestHash",status,"updatedAt","updatedBy") VALUES ($1,$2,$3,'TEST_ROUTE','TEST_KEY',$4,'COMPLETED',now(),$3)`;
  await db.query(idem, [randomUUID(), org, actor, 'a'.repeat(64)]);
  await rejects(idem, [randomUUID(), org, actor, 'b'.repeat(64)], '23505');
  const audit = randomUUID();
  await db.query(
    `INSERT INTO "AuditLog" (id,"orgId","actorKind","entityType","entityId","entityVersion",action,reason,"correlationId","updatedAt","updatedBy") VALUES ($1,$2,'TEST','Person',$3,1,'CREATE','Phase 0 test','TEST',now(),$4)`,
    [audit, org, person, actor],
  );
  await rejects(
    `UPDATE "AuditLog" SET reason='overwrite' WHERE id=$1`,
    [audit],
    'P0001',
  );
  const project = randomUUID(),
    close = randomUUID(),
    revision = randomUUID();
  await db.query(
    `INSERT INTO "Project" (id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES ($1,$2,'TEST','TEST','Europe/Belgrade','TEST',now(),$3)`,
    [project, org, actor],
  );
  await db.query(
    `INSERT INTO "DailyClose" (id,"orgId","projectId","businessDate","siteTimezone","scopeKey","expectedReason","updatedAt","updatedBy") VALUES ($1,$2,$3,'2030-01-15','Europe/Belgrade','TEST','TEST',now(),$4)`,
    [close, org, project, actor],
  );
  await db.query(
    `INSERT INTO "Revision" (id,"orgId","dailyCloseId","revisionNumber",state,reason,snapshot,"updatedAt","updatedBy") VALUES ($1,$2,$3,1,'SUBMITTED','TEST','{"rawTotal":4}',now(),$4)`,
    [revision, org, close, actor],
  );
  await rejects(
    `UPDATE "Revision" SET snapshot='{"rawTotal":7}' WHERE id=$1`,
    [revision],
    'P0001',
  );
  await rejects(`DELETE FROM "Revision" WHERE id=$1`, [revision], 'P0001');
  // Every function in the public schema pins one of the two approved search_paths exactly
  // (pg_catalog first, pg_temp last), so a caller's
  // temporary table can never shadow a public table inside a trigger or helper (a later
  // function added without a pinned path fails here).
  {
    const unpinned = (
      await db.query(
        `SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          -- functions owned by an extension (btree_gist's C support functions) are not ours
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND d.objid = p.oid AND d.deptype = 'e')
          AND NOT (coalesce(p.proconfig, '{}') && ARRAY['search_path=pg_catalog, public, pg_temp', 'search_path=pg_catalog, pg_temp']::text[])
        ORDER BY 1`,
      )
    ).rows.map((r) => r.proname);
    assert.deepEqual(
      unpinned,
      [],
      `functions without a pinned search_path: ${unpinned.join(', ')}`,
    );
    checks++;
    console.info(
      'Functions: every public function pins search_path (pg_temp last)',
    );
  }
  console.info(
    `PostgreSQL: ${checks} foundation assertions passed; business AT/LR not executed`,
  );
} finally {
  await db.query('ROLLBACK');
  await db.end();
}

const blob = BlobServiceClient.fromConnectionString(
  process.env.BLOB_CONNECTION_STRING,
);
const container = blob.getContainerClient('phase0-test-' + randomUUID());
await container.create();
try {
  const item = container.getBlockBlobClient('test-evidence.txt');
  await item.uploadData(Buffer.from('TEST_ONLY_NO_PERSONAL_DATA'));
  assert.equal(
    (await item.downloadToBuffer()).toString(),
    'TEST_ONLY_NO_PERSONAL_DATA',
  );
  const anonymous = await fetch(item.url);
  assert.notEqual(anonymous.status, 200);
  console.info('Azurite: private blob round-trip and anonymous denial passed');
} finally {
  await container.delete();
}
