/**
 * ADR-0003 D5 transaction protocol under a recording fake pg client (no database): the
 * statement order of an account transaction, replay re-projection, and a session the server
 * ends while the callback waits (the client is discarded, the SQLSTATE surfaces, no COMMIT).
 * The timing behaviour against PostgreSQL 17 is in scripts/tx-protocol-integration.mjs.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  accountTransaction,
  idempotent,
  inTransaction,
  sha,
} from './store-kit.js';
import { withBlobDeadline, BlobDeadlineError } from './photo-store.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const COMMAND = { c: 1 };
const identity = { tenantId: 'TEST-tenant', objectId: 'TEST-object' };
const account = {
  orgId: ORG,
  id: 'TEST-account',
  personId: 'TEST-person',
  authzVersion: 7,
};
const DECIDED = '2026-10-05 08:00:00.123456+00';

function fake(opts: {
  accounts?: unknown[];
  roles?: { role: string; projectId: string | null }[];
  stored?: unknown;
}) {
  const log: string[] = [];
  const released: unknown[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: async (text: string) => {
      log.push(text.replace(/\s+/g, ' ').trim().slice(0, 60));
      if (/app_account_for_identity/.test(text))
        return { rows: opts.accounts ?? [account] };
      if (/clock_timestamp/.test(text))
        return { rows: [{ decidedAt: DECIDED }] };
      if (/FROM "Membership"/.test(text))
        return {
          rows: opts.roles ?? [{ role: 'PROJECT_MANAGER', projectId: 'p' }],
        };
      if (/FROM "IdempotencyRecord"/.test(text))
        return {
          rows: opts.stored
            ? [{ requestHash: sha(COMMAND), responseBody: opts.stored }]
            : [],
        };
      return { rows: [] };
    },
    release: (err?: unknown) => released.push(err ?? null),
  });
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, client, log, released };
}

describe('account transaction protocol (ADR-0003 D5)', () => {
  it('BEGIN, transaction_timeout first, the other bounds, identity, the first-lock function, then the decision clock, org, memberships', async () => {
    const f = fake({});
    const actor = await inTransaction(f.pool, identity, async (_c, a) => a);
    const expected = [
      /^BEGIN$/,
      /^SET LOCAL transaction_timeout = '30s'$/,
      /^SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout /,
      /^SELECT set_config\('app.tenant_id'/,
      /FROM app_account_for_identity|^SELECT a."orgId", a.id, a."personId", a."authzVersion"/,
      /^SELECT clock_timestamp\(\)::text AS "decidedAt"$/,
      /^SELECT set_config\('app.org_id'/,
      /^SELECT role, "projectId" FROM "Membership"/,
    ];
    expect(f.log.slice(0, 8).every((l, i) => expected[i]!.test(l))).toBe(true);
    expect(f.log.at(-1)).toBe('COMMIT');
    expect(actor).toEqual({
      orgId: ORG,
      accountId: 'TEST-account',
      personId: 'TEST-person',
      authzVersion: 7,
      decidedAt: DECIDED,
    });
    expect(f.released).toEqual([null]);
  });

  it('not exactly one account row is FORBIDDEN before any membership read', async () => {
    for (const accounts of [[], [account, { ...account, id: 'TEST-other' }]]) {
      const f = fake({ accounts });
      await expect(
        inTransaction(f.pool, identity, async () => 'never'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.log.some((l) => l.includes('"Membership"'))).toBe(false);
      expect(f.log.at(-1)).toBe('ROLLBACK');
    }
  });

  it('no report role at decidedAt is FORBIDDEN', async () => {
    const f = fake({ roles: [{ role: 'ALPHA_OWNER', projectId: 'p' }] });
    await expect(
      inTransaction(f.pool, identity, async () => 'never'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a session the server ends while the callback waits: the SQLSTATE surfaces, no COMMIT, the client is discarded', async () => {
    const f = fake({});
    const pending = accountTransaction(
      f.pool,
      identity,
      { admit: () => true, forbidden: () => new Error('FORBIDDEN') },
      () => new Promise<never>(() => {}),
    );
    await new Promise((r) => setTimeout(r, 10));
    const terminated = Object.assign(
      new Error('terminating connection due to idle-in-transaction timeout'),
      { code: '25P03' },
    );
    f.client.emit('error', terminated);
    f.client.emit('error', new Error('Connection terminated unexpectedly'));
    await expect(pending).rejects.toBe(terminated);
    expect(f.log).not.toContain('COMMIT');
    expect(f.log).not.toContain('ROLLBACK');
    expect(f.released).toEqual([terminated]);
    expect(f.client.listenerCount('error')).toBe(0);
  });
});

describe('idempotent replay is re-projected for the current context', () => {
  it('a stored body passes through the projection, like a live one', async () => {
    const stored = { id: 'TEST-photo', lat: 44.8, coordinates: 'exact' };
    const project = (b: typeof stored) => ({
      ...b,
      lat: null as unknown as number,
      coordinates: 'withheld',
    });
    const f = fake({ stored });
    const client = f.client as unknown as PoolClient;
    const actor = { ...account, accountId: account.id, decidedAt: DECIDED };
    let ran = false;
    const replayed = await idempotent(
      client,
      actor,
      'TEST_ROUTE',
      'key',
      COMMAND,
      async () => {
        ran = true;
        return stored;
      },
      project,
    );
    expect(ran).toBe(false);
    expect(replayed).toEqual({
      id: 'TEST-photo',
      lat: null,
      coordinates: 'withheld',
    });
    const live = await idempotent(
      fake({}).client as unknown as PoolClient,
      actor,
      'TEST_ROUTE',
      'key2',
      COMMAND,
      async () => stored,
      project,
    );
    expect(live).toEqual(replayed);
  });
});

describe('Blob deadline', () => {
  it('a call that never settles fails at the deadline with BlobDeadlineError and sees its signal abort', async () => {
    let signal: AbortSignal | undefined;
    const started = Date.now();
    await expect(
      withBlobDeadline(50, undefined, (s) => {
        signal = s;
        return new Promise<never>(() => {});
      }),
    ).rejects.toBeInstanceOf(BlobDeadlineError);
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('an aborted transaction signal ends the call at once', async () => {
    const outer = new AbortController();
    const pending = withBlobDeadline(
      60_000,
      outer.signal,
      () => new Promise<never>(() => {}),
    );
    outer.abort(new Error('connection lost'));
    await expect(pending).rejects.toBeInstanceOf(BlobDeadlineError);
  });
});
