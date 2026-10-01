/** A7-0e Alpha atomic snapshots. Isolated synthetic TEST DB; no HTTP or real identities. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { alphaRecordFact } from '../packages/domain/dist/report-lookups.js';
import { assertLocalDatabase } from './local-db.mjs';

const raw = process.env['DATABASE_URL'];
assert.ok(raw);
const source = assertLocalDatabase(raw);
const mode = process.env['ALPHA_LOOKUP_TEST_MODE'] ?? 'current';
assert.ok(['current', 'baseline', 'volatile'].includes(mode));
const suffix = randomBytes(6).toString('hex');
const database = `mje_alpha_lookup_test_${suffix}`;
const username = `mje_alpha_lookup_${suffix}`;
const password = randomBytes(24).toString('hex');
const url = new URL(source);
url.pathname = `/${database}`;
const closing = new WeakSet<Pool>();
const protect = (pool: Pool): Pool => {
  pool.on('error', (e: Error & { code?: string }) => {
    if (closing.has(pool) && e.code === '57P01') return;
    throw e;
  });
  return pool;
};
const admin = protect(new Pool({ connectionString: source.toString() }));
let owner: Pool | undefined, app: Pool | undefined;
let databaseCreated = false,
  roleCreated = false;
let reader: PoolClient | undefined, holder: PoolClient | undefined;
let pending: Promise<unknown> | undefined;
let checks = 0;
let failed = false;
let failure: unknown;
const cleanupErrors: unknown[] = [];
const pass = (name: string) => {
  checks++;
  console.log(`PASS ${name}`);
};
const org = randomUUID(),
  project = randomUUID(),
  account = randomUUID(),
  person = randomUUID();
const record = randomUUID(),
  missing = randomUUID(),
  seed = randomUUID();
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
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
  app = protect(new Pool({ connectionString: appUrl.toString() }));
  await owner.query(
    'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,\'TEST Alpha lookup\',now(),$2)',
    [org, seed],
  );
  await owner.query(
    'INSERT INTO "Person"(id,"orgId","displayName","updatedAt","updatedBy") VALUES($1,$2,\'TEST Alpha person\',now(),$3)',
    [person, org, seed],
  );
  await owner.query(
    'INSERT INTO "Project"(id,"orgId",code,name,timezone,status,"updatedAt","updatedBy") VALUES($1,$2,\'TEST-ALPHA-LOOKUP\',\'TEST Alpha project\',\'UTC\',\'ACTIVE\',now(),$3)',
    [project, org, seed],
  );
  await owner.query(
    'INSERT INTO "LoginAccount"(id,"orgId","personId","entraTenantId","entraObjectId","updatedAt","updatedBy") VALUES($1,$2,$3,$4,$5,now(),$6)',
    [account, org, person, randomUUID(), randomUUID(), seed],
  );
  await owner.query(
    'INSERT INTO "DailyClose"(id,"orgId","projectId","businessDate","siteTimezone","scopeKey",version,state,"expectedReason","updatedAt","updatedBy") VALUES($1,$2,$3,\'2030-01-15\',\'UTC\',$4,1,\'DRAFT\',\'TEST Alpha declaration\',now(),$5)',
    [record, org, project, `alpha:${record}`, account],
  );
  await owner.query(
    'INSERT INTO "AlphaDraft"(id,"orgId","dailyCloseId",content,"updatedBy") VALUES($1,$2,$3,\'{"marker":1}\',$4)',
    [randomUUID(), org, record, account],
  );
  // Mutation is opt-in and changes only this uniquely named disposable TEST database.
  if (mode === 'volatile')
    await owner.query(
      'ALTER FUNCTION public.alpha_draft_content(UUID, UUID) VOLATILE',
    );
  const functions = await owner.query<{
    proname: string;
    provolatile: string;
    prosecdef: boolean;
    proconfig: string[];
    public_exec: boolean;
    app_exec: boolean;
  }>(
    `SELECT p.proname,p.provolatile,p.prosecdef,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') AS public_exec,
      has_function_privilege('mje_alpha_app',p.oid,'EXECUTE') AS app_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('alpha_draft_exists','alpha_draft_content') ORDER BY p.proname`,
  );
  assert.equal(functions.rows.length, 2);
  for (const f of functions.rows) {
    assert.equal(
      f.provolatile,
      mode === 'volatile' && f.proname === 'alpha_draft_content' ? 'v' : 's',
    );
    assert.equal(f.prosecdef, false);
    assert.equal(f.public_exec, false);
    assert.equal(f.app_exec, true);
    assert.deepEqual(f.proconfig, ['search_path=pg_catalog, public, pg_temp']);
  }
  pass(
    'function metadata: statement stability, invoker privileges, fixed path, no PUBLIC execute',
  );
  reader = await app.connect();
  await reader.query("SET statement_timeout='8s'");
  await reader.query('BEGIN');
  try {
    await reader.query("SELECT set_config('app.org_id',$1,true)", [org]);
    assert.equal((await alphaRecordFact(reader, org, record))?.version, 1);
    assert.equal(await alphaRecordFact(reader, org, missing), undefined);
    const own = await reader.query<{ present: boolean }>(
      'SELECT public.alpha_draft_exists($1,$2) AS present',
      [org, record],
    );
    assert.equal(own.rows[0]!.present, true);
    await reader.query(
      'UPDATE "AlphaDraft" SET content=\'null\'::jsonb WHERE "orgId"=$1 AND "dailyCloseId"=$2',
      [org, record],
    );
    const jsonNull = await alphaRecordFact(reader, org, record);
    assert.ok(jsonNull);
    assert.equal(jsonNull.content, null);
    await reader.query(
      'UPDATE "AlphaDraft" SET content=\'{"marker":9}\' WHERE "orgId"=$1 AND "dailyCloseId"=$2',
      [org, record],
    );
    assert.deepEqual((await alphaRecordFact(reader, org, record))?.content, {
      marker: 9,
    });
    const other = await owner.connect();
    try {
      assert.deepEqual((await alphaRecordFact(other, org, record))?.content, {
        marker: 1,
      });
    } finally {
      other.release();
    }
    await reader.query("SELECT set_config('app.org_id',$1,true)", [
      randomUUID(),
    ]);
    assert.equal(await alphaRecordFact(reader, org, record), undefined);
    const hidden = await reader.query<{ present: boolean; content: unknown }>(
      'SELECT public.alpha_draft_exists($1,$2) AS present,public.alpha_draft_content($1,$2) AS content',
      [org, record],
    );
    assert.equal(hidden.rows[0]!.present, false);
    assert.equal(hidden.rows[0]!.content, null);
  } finally {
    await reader.query('ROLLBACK');
  }
  pass(
    'app RLS, missing record vs JSON null and caller uncommitted writes preserved',
  );
  await reader.query("SELECT set_config('app.org_id',$1,false)", [org]);
  holder = await owner.connect();
  const lockKey = '73910482';
  await holder.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
  // Only the test proxy adds a gate. The production exit and SQL function are unchanged.
  const gated = new Proxy(reader, {
    get(target, key) {
      if (key === 'query')
        return async (
          text: string,
          values: unknown[] = [],
        ): Promise<QueryResult> => {
          assert.ok(text.includes('FROM "DailyClose" d'));
          const stmt = text
            .replace(
              'FROM "DailyClose" d',
              'FROM "DailyClose" d CROSS JOIN "TEST_gate"',
            )
            .replace('d.id=$2', 'd.id="TEST_gate".record_id')
            .replace(
              'public.alpha_draft_content(d."orgId", d.id)',
              'public.alpha_draft_content(d."orgId", "TEST_gate".record_id)',
            );
          return target.query(
            `WITH "TEST_gate" AS MATERIALIZED (SELECT pg_advisory_xact_lock($3::bigint),$2::uuid AS record_id) ${stmt}`,
            [...values, lockKey],
          );
        };
      const v: unknown = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const read =
    mode === 'baseline'
      ? gated
          .query(
            `SELECT d.id,d."projectId",d."businessDate"::text,d."siteTimezone",d.version,d."currentRevisionNumber",d."updatedAt",a.content FROM "DailyClose" d
    JOIN "AlphaDraft" a ON a."orgId"=d."orgId" AND a."dailyCloseId"=d.id WHERE d."orgId"=$1 AND d.id=$2`,
            [org, record],
          )
          .then((r) => r.rows[0])
      : alphaRecordFact(gated, org, record);
  pending = read;
  void read.catch(() => undefined);
  const end = Date.now() + 4000;
  let blocked = false;
  while (Date.now() < end) {
    const r = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND wait_event='advisory'",
      [database],
    );
    if (r.rows[0]!.n > 0) {
      blocked = true;
      break;
    }
    await delay(10);
  }
  assert.ok(
    blocked,
    'TEST actual record query must wait after its statement snapshot starts',
  );
  // Use one checked-out writer: a Pool query pair is not a transaction binding guarantee.
  const writer = await owner.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(
      'UPDATE "DailyClose" SET version=2 WHERE "orgId"=$1 AND id=$2',
      [org, record],
    );
    await writer.query(
      'UPDATE "AlphaDraft" SET content=\'{"marker":2}\' WHERE "orgId"=$1 AND "dailyCloseId"=$2',
      [org, record],
    );
    await writer.query('COMMIT');
  } catch (e) {
    await writer.query('ROLLBACK');
    throw e;
  } finally {
    writer.release();
  }
  await holder.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
  const facts = await read;
  assert.ok(facts);
  assert.equal(facts.version, 1);
  assert.deepEqual(
    facts.content,
    { marker: 1 },
    'one record statement must not mix old header with content from a later commit',
  );
  assert.equal((await alphaRecordFact(reader, org, record))?.version, 2);
  assert.deepEqual((await alphaRecordFact(reader, org, record))?.content, {
    marker: 2,
  });
  pass(
    'controlled concurrent commit: one statement returns old header and old content; next statement sees new pair',
  );
  console.log(
    `Alpha lookup DB integration: ${checks} checks passed (${mode}); synthetic TEST only.`,
  );
} catch (e) {
  failed = true;
  failure = e;
} finally {
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      cleanupErrors.push(e);
    }
  };
  if (holder) {
    const c = holder;
    await attempt(async () => {
      try {
        await c.query('SELECT pg_advisory_unlock_all()');
      } finally {
        c.release(true);
      }
    });
  }
  if (pending) await Promise.allSettled([pending]);
  if (reader) reader.release(true);
  for (const pool of [app, owner])
    if (pool) {
      closing.add(pool);
      await attempt(() => pool.end());
    }
  if (databaseCreated)
    await attempt(() =>
      admin.query(`DROP DATABASE "${database}" WITH (FORCE)`),
    );
  if (roleCreated) await attempt(() => admin.query(`DROP ROLE "${username}"`));
  closing.add(admin);
  await attempt(() => admin.end());
}
if (failed || cleanupErrors.length) {
  throw new AggregateError(
    [...(failed ? [failure] : []), ...cleanupErrors],
    'TEST run or cleanup failed',
  );
}
