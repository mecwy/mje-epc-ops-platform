/**
 * A7-0e: real PostgreSQL gates for report submission vs PM check-in and photo upload.
 * Synthetic TEST only, unique isolated database/app login; no cloud/real identities.
 * LOOKUP_TEST_CASE selects all (CI default), concurrency, or visibility for diagnosis.
 * LOOKUP_TEST_DOMAIN_DIR can select an isolated compiled mutation for private evidence.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type QueryResult } from 'pg';
import { testJpeg } from '../packages/testing/dist/index.js';
import { assertLocalDatabase } from './local-db.mjs';

const raw = process.env['DATABASE_URL'];
assert.ok(raw, 'TEST requires a local DATABASE_URL');
const source = assertLocalDatabase(raw);
const mode = process.env['LOOKUP_TEST_CASE'] ?? 'all';
assert.ok(
  ['all', 'concurrency', 'visibility'].includes(mode),
  'unknown TEST case',
);
const dir = resolve(
  process.env['LOOKUP_TEST_DOMAIN_DIR'] ?? 'packages/domain/dist',
);
const domain = (await import(
  pathToFileURL(resolve(dir, 'index.js')).href
)) as typeof import('../packages/domain/dist/index.js');
const lookups =
  mode === 'concurrency'
    ? null
    : ((await import(
        pathToFileURL(resolve(dir, 'report-lookups.js')).href
      )) as typeof import('../packages/domain/dist/report-lookups.js'));
const suffix = randomBytes(6).toString('hex');
const database = `mje_lookup_test_${suffix}`;
const username = `mje_lookup_${suffix}`;
const password = randomBytes(24).toString('hex');
const isolated = new URL(source);
isolated.pathname = `/${database}`;
const closing = new WeakSet<Pool>();
const protect = (pool: Pool): Pool => {
  pool.on('error', (e: Error & { code?: string }) => {
    if (closing.has(pool) && e.code === '57P01') return;
    throw e;
  });
  return pool;
};
const admin = protect(new Pool({ connectionString: source.toString() }));
let owner: Pool | undefined;
let app: Pool | undefined;
let created = false;
let roleCreated = false;
let checks = 0;
let gate: { hit: () => void; opened: Promise<void> } | null = null;
const openGates: (() => void)[] = [];
const pending: Promise<unknown>[] = [];
const track = <T,>(p: Promise<T>): Promise<T> => {
  pending.push(p);
  void p.catch(() => undefined);
  return p;
};
const pass = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};
const bounded = async <T,>(p: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`TEST gate timed out: ${label}`)),
          4000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const pauseSubmission = () => {
  let hit!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => {
    hit = r;
  });
  const opened = new Promise<void>((r) => {
    open = r;
  });
  gate = { hit, opened };
  openGates.push(open);
  return { reached, open };
};
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  execFileSync('pnpm', ['db:migrate'], {
    env: { ...process.env, DATABASE_URL: isolated.toString() },
    stdio: 'pipe',
    timeout: 180000,
  });
  owner = protect(new Pool({ connectionString: isolated.toString() }));
  await admin.query(
    `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  );
  roleCreated = true;
  await owner.query(`GRANT mje_alpha_app TO "${username}"`);
  const appUrl = new URL(isolated);
  appUrl.username = username;
  appUrl.password = password;
  app = protect(new Pool({ connectionString: appUrl.toString(), max: 8 }));
  // Only transaction clients are wrapped; background pool queries keep their original binding.
  const admitted = new Proxy(app, {
    get(target, key) {
      if (key === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(c, property) {
              if (property === 'query')
                return async (
                  text: string,
                  values?: unknown[],
                ): Promise<QueryResult> => {
                  const result = await c.query(text, values);
                  const g = gate;
                  if (g && text.includes('SELECT "lastSeq" FROM "FieldDay"')) {
                    gate = null;
                    g.hit();
                    await g.opened;
                  }
                  return result;
                };
              const value: unknown = Reflect.get(c, property);
              return typeof value === 'function' ? value.bind(c) : value;
            },
          });
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const orgId = randomUUID(),
    projectId = randomUUID(),
    accountId = randomUUID();
  const personId = randomUUID(),
    firstPerson = randomUUID(),
    secondPerson = randomUUID();
  const crewId = randomUUID(),
    seed = randomUUID();
  const identity = { tenantId: randomUUID(), objectId: randomUUID() };
  await owner.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST lookup organization\',now(),$2)',
    [orgId, seed],
  );
  for (const id of [personId, firstPerson, secondPerson])
    await owner.query(
      'INSERT INTO "Person"(id,"orgId","updatedAt","updatedBy","displayName") VALUES($1,$2,now(),$3,\'TEST lookup person\')',
      [id, orgId, seed],
    );
  await owner.query(
    'INSERT INTO "Project"(id,"orgId","updatedAt","updatedBy",code,name,timezone,status) VALUES($1,$2,now(),$3,\'TEST-LOOKUP\',\'TEST lookup project\',\'UTC\',\'ACTIVE\')',
    [projectId, orgId, seed],
  );
  await owner.query(
    'INSERT INTO "LoginAccount"(id,"orgId","updatedAt","updatedBy","entraTenantId","entraObjectId","personId") VALUES($1,$2,now(),$3,$4,$5,$6)',
    [accountId, orgId, seed, identity.tenantId, identity.objectId, personId],
  );
  await owner.query(
    'INSERT INTO "Membership"(id,"orgId","updatedAt","updatedBy",role,"activeFrom","accountId","projectId") VALUES($1,$2,now(),$3,\'PROJECT_MANAGER\',now()-interval \'1 hour\',$4,$5)',
    [randomUUID(), orgId, seed, accountId, projectId],
  );
  await owner.query(
    'INSERT INTO "Crew"(id,"orgId","projectId",code,name,"createdBy") VALUES($1,$2,$3,\'TEST-CREW\',\'TEST lookup crew\',$4)',
    [crewId, orgId, projectId, accountId],
  );
  for (const id of [firstPerson, secondPerson])
    await owner.query(
      'INSERT INTO "CrewAssignment"(id,"orgId","projectId","crewId","personId",role,"validFrom","createdBy") VALUES($1,$2,$3,$4,$5,\'MEMBER\',now(),$6)',
      [randomUUID(), orgId, projectId, crewId, id, accountId],
    );
  const dates = await owner.query<{ today: string; yesterday: string }>(
    "SELECT (now() AT TIME ZONE 'UTC')::date::text AS today, ((now() AT TIME ZONE 'UTC')::date-1)::text AS yesterday",
  );
  const { today, yesterday } = dates.rows[0]!;
  const reports = new domain.ReportStore(admitted);
  const checkins = new domain.CheckInStore(admitted, null, {
    housekeeping: false,
  });
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const photos = new domain.PhotoStore(admitted, {
    put: async (key, bytes, contentType) => {
      objects.set(key, { bytes, contentType });
    },
    get: async (key) => objects.get(key) ?? null,
  });
  const submit = (businessDate: string) =>
    track(
      reports.submit(identity, {
        projectId,
        businessDate,
        expectedVersion: 0,
        clientMutationId: randomUUID(),
      }),
    );
  const proxy = (id: string) =>
    track(
      checkins.pmProxy(identity, {
        projectId,
        personId: id,
        businessDate: today,
        clientMutationId: randomUUID(),
        occurredAt: null,
        source: 'OTHER',
        reason: 'TEST observed claim',
        actorFix: null,
      }),
    );
  const waiter = async () => {
    const limit = performance.now() + 3500;
    do {
      const q = await owner!.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
        [database],
      );
      if (q.rows[0]!.n > 0) return;
      await delay(5);
    } while (performance.now() < limit);
    throw new Error(
      'TEST transaction did not wait on the report-day advisory lock',
    );
  };
  if (mode !== 'visibility') {
    const first = await proxy(firstPerson);
    assert.equal(first.afterSubmission, false);
    const firstSeq = Number(
      (
        await owner.query<{ daySeq: string }>(
          'SELECT "daySeq" FROM "WorkerCheckIn" WHERE "orgId"=$1 AND id=$2',
          [orgId, first.checkInId],
        )
      ).rows[0]!.daySeq,
    );
    const paused = pauseSubmission();
    const submitting = submit(today);
    await bounded(paused.reached, 'submit froze field boundary');
    const later = proxy(secondPerson);
    await waiter();
    paused.open();
    await submitting;
    const second = await later;
    assert.equal(
      second.afterSubmission,
      true,
      'a check-in queued behind submission must read its committed boundary',
    );
    const secondSeq = Number(
      (
        await owner.query<{ daySeq: string }>(
          'SELECT "daySeq" FROM "WorkerCheckIn" WHERE "orgId"=$1 AND id=$2',
          [orgId, second.checkInId],
        )
      ).rows[0]!.daySeq,
    );
    assert.ok(secondSeq > firstSeq);
    const frozen = await owner.query<{
      snapshot: {
        field: { seqBoundary: number; checkIns: { checkInId: string }[] };
      };
    }>(
      'SELECT snapshot FROM "Revision" WHERE "orgId"=$1 AND "dailyCloseId" IN (SELECT id FROM "DailyClose" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date)',
      [orgId, projectId, today],
    );
    const field = frozen.rows[0]!.snapshot.field;
    assert.equal(field.seqBoundary, firstSeq);
    assert.ok(field.checkIns.some((x) => x.checkInId === first.checkInId));
    assert.ok(!field.checkIns.some((x) => x.checkInId === second.checkInId));
    pass(
      'check-in waits behind submission: first frozen, later afterSubmission, exact sequence boundary',
    );
    const photoPaused = pauseSubmission();
    const photoSubmit = submit(yesterday);
    await bounded(photoPaused.reached, 'photo submission holds day lock');
    const uploading = track(
      photos.upload(identity, {
        command: {
          projectId,
          businessDate: yesterday,
          clientMutationId: randomUUID(),
          source: 'album',
          capture: null,
          takenAt: null,
          link: null,
        },
        photo: {
          bytes: testJpeg({ tag: 'TEST-lookup' }),
          mediaType: 'image/jpeg',
        },
        thumbnail: null,
      }),
    );
    await waiter();
    photoPaused.open();
    await photoSubmit;
    await assert.rejects(
      uploading,
      (e: unknown) => e instanceof domain.ReportError && e.code === 'LOCKED',
      'upload after submission must read state after the day lock',
    );
    assert.equal(objects.size, 0, 'refused upload wrote no Blob');
    const stored = await owner.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "PhotoEvidence" WHERE "orgId"=$1',
      [orgId],
    );
    assert.equal(stored.rows[0]!.n, 0);
    pass('upload waits behind submission: LOCKED, no photo or Blob write');
  }
  if (mode !== 'concurrency') {
    assert.ok(lookups);
    if (mode === 'visibility') await submit(today);
    const c = await owner.connect();
    const foreign = await owner.connect();
    try {
      // A private wrong-client mutation replaces this helper's client with this other session.
      Object.assign(globalThis, { __TEST_FOREIGN_LOOKUP_CLIENT: foreign });
      await c.query('BEGIN');
      await c.query(
        'UPDATE "DailyClose" SET "correctionReason"=$4 WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date',
        [orgId, projectId, today, 'TEST uncommitted correction'],
      );
      const state = await lookups.reportUploadDayState(
        c,
        orgId,
        projectId,
        today,
      );
      assert.equal(
        state?.correctionReason,
        'TEST uncommitted correction',
        'exit must see caller uncommitted writes, not a different transaction',
      );
      assert.equal(
        (await lookups.reportUploadDayState(foreign, orgId, projectId, today))
          ?.correctionReason,
        null,
      );
      assert.equal(
        await lookups.reportSubmittedBoundary(
          c,
          orgId,
          projectId,
          '1999-01-01',
        ),
        null,
      );
      assert.equal(
        await lookups.reportSubmittedBoundary(
          c,
          orgId,
          projectId,
          mode === 'all' ? yesterday : today,
        ),
        0,
      );
      pass(
        'caller-client visibility preserved; another transaction sees committed state; no submission null differs from submitted zero',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
      foreign.release();
      Reflect.deleteProperty(globalThis, '__TEST_FOREIGN_LOOKUP_CLIENT');
    }
  }
  console.log(
    `Report lookup DB integration: ${checks} checks passed (${mode}); synthetic TEST only.`,
  );
} finally {
  for (const open of openGates) open();
  await Promise.allSettled(pending);
  if (app) {
    closing.add(app);
    await app.end();
  }
  if (owner) {
    closing.add(owner);
    await owner.end();
  }
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await admin.query(`DROP ROLE "${username}"`);
  closing.add(admin);
  await admin.end();
}
