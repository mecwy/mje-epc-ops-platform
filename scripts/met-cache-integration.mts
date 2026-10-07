/** Actual local PostgreSQL only. Synthetic TEST DB/login are uniquely named and cleaned up.
 * DATABASE_URL is never logged. MET_CACHE_TEST_DOMAIN_DIR selects a compiled adapter for
 * a controlled regression check; it defaults to the repository's built domain module.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { assertLocalDatabase } from './local-db.mjs';
import { assertApplicationLogin } from '../apps/api/dist/runtime-env.js';

const dir = resolve(
  process.env['MET_CACHE_TEST_DOMAIN_DIR'] ?? 'packages/domain/dist',
);
const adapter = (await import(
  pathToFileURL(resolve(dir, 'met-forecast-cache.js')).href
)) as typeof import('../packages/domain/dist/met-forecast-cache.js');
const now = () => new Date().toISOString();
const signal = () => new AbortController().signal;
const hash = () => randomBytes(32).toString('hex');
const entry = (body: unknown = { TEST: true, zero: 0 }) => ({
  body,
  fetchedAt: now(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  lastModified: 'Wed, 07 Oct 2026 00:00:00 GMT',
});
async function scoped<T>(
  pool: Pool,
  org: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.org_id',$1,true)", [org]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const code = (error: unknown): string | undefined =>
  (error as { code?: string } | null)?.code;
async function rejection(work: () => Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => code(error) === expected);
}
const leased = (
  taken: Awaited<
    ReturnType<ReturnType<typeof adapter.createMetForecastCacheGate>['take']>
  >,
) => {
  assert.equal(taken.state, 'leased');
  if (taken.state !== 'leased') throw new Error('TEST_LEASE_REQUIRED');
  return taken.lease;
};

if (process.argv.includes('--fresh-child')) {
  const raw = process.env['MET_CACHE_TEST_CHILD_APP_URL'];
  assert.ok(raw, 'TEST child connection required');
  const url = assertLocalDatabase(raw);
  assert.match(url.pathname, /^\/mje_met_cache_test_[a-f0-9]+$/);
  const org = process.env['MET_CACHE_TEST_CHILD_ORG'],
    key = process.env['MET_CACHE_TEST_CHILD_KEY'];
  assert.ok(org && key);
  const child = new Pool({ connectionString: url.toString() });
  try {
    const value = await adapter
      .createMetForecastCacheGate(child, org)
      .take(key, now(), signal());
    assert.equal(value.state, 'fresh');
    if (value.state === 'fresh')
      assert.deepEqual(value.entry.body, { TEST: true, zero: 0 });
    console.log('PASS actual new process durable fresh cache');
  } finally {
    await child.end();
  }
} else {
  const raw = process.env['DATABASE_URL'];
  assert.ok(raw, 'TEST requires local DATABASE_URL');
  const source = assertLocalDatabase(raw),
    suffix = randomBytes(6).toString('hex');
  const database = `mje_met_cache_test_${suffix}`,
    login = `mje_met_cache_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const url = new URL(source);
  url.pathname = `/${database}`;
  const orgA = randomUUID(),
    orgB = randomUUID();
  const admin = new Pool({ connectionString: source.toString(), max: 2 });
  let owner: Pool | undefined,
    first: Pool | undefined,
    second: Pool | undefined;
  let databaseCreated = false,
    roleCreated = false,
    stage = 'setup';
  const checks: string[] = [];
  const pass = (name: string) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  try {
    const version = (
      await admin.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      )
    ).rows[0]!.version;
    assert.ok(
      Number(version) >= 170000,
      'TEST PostgreSQL17+ required for transaction_timeout',
    );
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    execFileSync(
      process.execPath,
      [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 180000,
      },
    );
    owner = new Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(
      `CREATE ROLE "${login}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
    );
    roleCreated = true;
    await owner.query(`GRANT mje_alpha_app TO "${login}"`);
    const appUrl = new URL(url);
    appUrl.username = login;
    appUrl.password = password;
    first = new Pool({ connectionString: appUrl.toString(), max: 4 });
    second = new Pool({ connectionString: appUrl.toString(), max: 4 });
    await owner.query(
      'INSERT INTO "Organization"(id,name,"updatedAt","updatedBy") VALUES($1,$3,now(),$4),($2,$3,now(),$4)',
      [orgA, orgB, 'TEST MET cache isolation', randomUUID()],
    );
    const gateA = adapter.createMetForecastCacheGate(first, orgA),
      gateOtherPool = adapter.createMetForecastCacheGate(second, orgA),
      gateB = adapter.createMetForecastCacheGate(second, orgB);
    stage = 'nonowner/RLS catalog';
    const role = (
      await first.query<{ superuser: boolean; bypass: boolean }>(
        'SELECT rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0]!;
    assert.deepEqual(role, { superuser: false, bypass: false });
    const tables = (
      await first.query<{
        name: string;
        rls: boolean;
        force: boolean;
        select: boolean;
        insert: boolean;
        update: boolean;
        delete: boolean;
        truncate: boolean;
      }>(
        `SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force,has_table_privilege(current_user,c.oid,'SELECT') AS select,has_table_privilege(current_user,c.oid,'INSERT') AS insert,has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS delete,has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate FROM pg_class c WHERE c.relname IN ('MetForecastCache','MetForecastCooldown') ORDER BY c.relname`,
      )
    ).rows;
    assert.equal(tables.length, 2);
    for (const t of tables)
      assert.deepEqual(
        { ...t, name: undefined },
        {
          name: undefined,
          rls: true,
          force: true,
          select: true,
          insert: true,
          update: true,
          delete: false,
          truncate: false,
        },
      );
    pass(stage);

    stage = 'formal boot guard rejects WeatherReportReference-only table owner';
    await assertApplicationLogin(first);
    const ownerName = (
      await owner.query<{ name: string }>('SELECT current_user AS name')
    ).rows[0]!.name;
    const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    await owner.query(
      `ALTER TABLE "WeatherReportReference" OWNER TO ${identifier(login)}`,
    );
    try {
      await assert.rejects(
        assertApplicationLogin(first),
        /UNSAFE_DATABASE_LOGIN/,
      );
    } finally {
      await owner.query(
        `ALTER TABLE "WeatherReportReference" OWNER TO ${identifier(ownerName)}`,
      );
    }
    await assertApplicationLogin(first);
    pass(stage);

    stage = 'canonical exact boundary and terminal invalid payload';
    const positive = { data: 'x'.repeat(2097152 - 12) },
      above = { data: 'x'.repeat(2097152 - 11) };
    const bytes = (
      await owner.query<{ positive: number; above: number }>(
        'SELECT octet_length($1::jsonb::text) AS positive,octet_length($2::jsonb::text) AS above',
        [JSON.stringify(positive), JSON.stringify(above)],
      )
    ).rows[0]!;
    assert.deepEqual(bytes, { positive: 2097152, above: 2097153 });
    assert.equal(Buffer.byteLength(JSON.stringify(above)), 2097152);
    const positiveLease = leased(await gateA.take(hash(), now(), signal()));
    assert.equal(
      await gateA.commit(positiveLease, entry(positive), now()),
      true,
    );
    const invalidLease = leased(await gateA.take(hash(), now(), signal()));
    await rejection(
      () => gateA.commit(invalidLease, entry(above), now()),
      'INVALID_PAYLOAD',
    );
    await gateA.release(invalidLease);
    const unicodeLease = leased(await gateA.take(hash(), now(), signal()));
    await rejection(
      () => gateA.commit(unicodeLease, entry({ data: '\u0000' }), now()),
      'INVALID_PAYLOAD',
    );
    await gateA.release(unicodeLease);
    const leaseState = await scoped(first, orgA, (c) =>
      c.query(
        `SELECT "leaseToken","leasedUntil",body FROM "MetForecastCache" WHERE "orgId"=$1 AND "pointHash"=$2`,
        [orgA, invalidLease.key],
      ),
    );
    assert.deepEqual(leaseState.rows[0], {
      leaseToken: null,
      leasedUntil: null,
      body: null,
    });
    pass(stage);

    stage = 'two independent gates one lease and durable process reuse';
    const point = hash();
    const competing = await Promise.all([
      gateA.take(point, now(), signal()),
      gateOtherPool.take(point, now(), signal()),
    ]);
    assert.deepEqual(competing.map((v) => v.state).sort(), ['busy', 'leased']);
    const claimed = competing.find((v) => v.state === 'leased')!;
    assert.equal(await gateA.commit(leased(claimed), entry(), now()), true);
    const fresh = await gateOtherPool.take(point, now(), signal());
    assert.equal(fresh.state, 'fresh');
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), '--fresh-child'],
      {
        env: {
          ...process.env,
          MET_CACHE_TEST_CHILD_APP_URL: appUrl.toString(),
          MET_CACHE_TEST_CHILD_ORG: orgA,
          MET_CACHE_TEST_CHILD_KEY: point,
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(child.status, 0, 'TEST child failed');
    assert.match(child.stdout, /PASS actual new process/);
    pass(stage);

    stage = 'expiry replacement and stale-token commit/release fencing';
    await owner.query(
      `UPDATE "MetForecastCache" SET "fetchedAt"=clock_timestamp()-interval '2 seconds',"expiresAt"=clock_timestamp()-interval '1 second' WHERE "orgId"=$1 AND "pointHash"=$2`,
      [orgA, point],
    );
    const oldLease = leased(await gateA.take(point, now(), signal()));
    await owner.query(
      `UPDATE "MetForecastCache" SET "leasedUntil"=clock_timestamp()-interval '1 second' WHERE "orgId"=$1 AND "pointHash"=$2`,
      [orgA, point],
    );
    const newLease = leased(await gateOtherPool.take(point, now(), signal()));
    assert.notEqual(newLease.token, oldLease.token);
    assert.equal(await gateA.commit(oldLease, entry(), now()), false);
    await gateA.release(oldLease);
    const fenced = await scoped(first, orgA, (c) =>
      c.query(
        'SELECT "leaseToken" FROM "MetForecastCache" WHERE "orgId"=$1 AND "pointHash"=$2',
        [orgA, point],
      ),
    );
    assert.equal(fenced.rows[0]?.leaseToken, newLease.token);
    assert.equal(await gateOtherPool.commit(newLease, entry(), now()), true);
    pass(stage);

    stage =
      'fresh cache before cooldown; expired/missing blocked; monotonic org scope';
    const throttleLease = leased(await gateA.take(hash(), now(), signal()));
    await gateA.throttle(
      throttleLease,
      new Date(Date.now() + 120000).toISOString(),
    );
    const long = await scoped(first, orgA, (c) =>
      c.query<{ until: Date }>(
        'SELECT "until" FROM "MetForecastCooldown" WHERE "orgId"=$1',
        [orgA],
      ),
    );
    await gateA.throttle(
      throttleLease,
      new Date(Date.now() + 30000).toISOString(),
    );
    await gateA.release(throttleLease);
    const short = await scoped(first, orgA, (c) =>
      c.query<{ until: Date }>(
        'SELECT "until" FROM "MetForecastCooldown" WHERE "orgId"=$1',
        [orgA],
      ),
    );
    assert.equal(short.rows[0]!.until.getTime(), long.rows[0]!.until.getTime());
    assert.equal((await gateA.take(point, now(), signal())).state, 'fresh');
    assert.equal((await gateA.take(hash(), now(), signal())).state, 'busy');
    await owner.query(
      `UPDATE "MetForecastCache" SET "fetchedAt"=clock_timestamp()-interval '2 seconds',"expiresAt"=clock_timestamp()-interval '1 second' WHERE "orgId"=$1 AND "pointHash"=$2`,
      [orgA, point],
    );
    assert.equal((await gateA.take(point, now(), signal())).state, 'busy');
    const unaffected = leased(await gateB.take(point, now(), signal()));
    await gateB.release(unaffected);
    pass(stage);

    stage = 'real cross-org RLS on both tables and no delete';
    for (const table of ['MetForecastCache', 'MetForecastCooldown']) {
      const hidden: { rowCount: number | null } = await scoped(
        first,
        orgA,
        (c) => c.query(`SELECT * FROM "${table}" WHERE "orgId"=$1`, [orgB]),
      );
      assert.equal(hidden.rowCount, 0);
      const columns = table === 'MetForecastCache' ? ',"pointHash"' : '',
        values = table === 'MetForecastCache' ? ',$2' : '';
      await rejection(
        () =>
          scoped(first!, orgA, (c) =>
            c.query(
              `INSERT INTO "${table}"("orgId",provider${columns}) VALUES($1,'met-norway'${values})`,
              table === 'MetForecastCache' ? [orgB, hash()] : [orgB],
            ),
          ),
        '42501',
      );
      await rejection(
        () =>
          scoped(first!, orgA, (c) =>
            c.query(`UPDATE "${table}" SET "orgId"=$1 WHERE "orgId"=$2`, [
              orgB,
              orgA,
            ]),
          ),
        '42501',
      );
      await rejection(
        () =>
          scoped(first!, orgA, (c) =>
            c.query(`DELETE FROM "${table}" WHERE "orgId"=$1`, [orgA]),
          ),
        '42501',
      );
      assert.equal((await first.query(`SELECT * FROM "${table}"`)).rowCount, 0);
    }
    pass(stage);
  } catch (error) {
    // SQL/CLI/assertion messages can include connection strings or raw values. Report
    // only the bounded stage/code, never captured migration output or supplied bodies.
    console.error(
      JSON.stringify({
        status: 'MET_CACHE_TEST_FAILED',
        stage,
        code: code(error) ?? 'ASSERTION_OR_SETUP',
      }),
    );
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([first?.end(), second?.end(), owner?.end()]);
    try {
      if (databaseCreated)
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE "${login}"`);
    } catch {
      console.error('MET_CACHE_TEST_OWN_RESOURCE_CLEANUP_FAILED');
      process.exitCode = 1;
    } finally {
      await admin.end();
    }
  }
  if (!process.exitCode)
    console.log(
      JSON.stringify({
        status: 'PASS_ACTUAL_POSTGRES_NONOWNER',
        checks: checks.length,
        ownTestDatabaseAndRoleRemoved: true,
        externalProviderRequests: 0,
      }),
    );
}
