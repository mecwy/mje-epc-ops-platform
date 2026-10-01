/**
 * The report module exit under a recording fake pg pool (no database): the lag request's query
 * sequence equals the one before the exit existed (one authorization, then history), a
 * revocation committed between reads cannot meet a second authorization, and a read context
 * lives only inside its transaction (ADR-0003 D2, D5; PR #51 review 1 and 3).
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { IssueStore } from './issue-store.js';
import { ReportStore } from './report-store.js';
import {
  observeReportProjections,
  reportReader,
  type ReportReadContext,
} from './report-reader.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const identity = { tenantId: 'TEST-tenant', objectId: 'TEST-object' };

/** What each statement is about: its first quoted table, or its leading keyword. */
function label(text: string): string {
  const table = /"([A-Z]\w+)"/.exec(text)?.[1];
  if (/^\s*SELECT set_config/.test(text)) return 'set_config';
  // A7-0b: the account row and first lock come through the definer function.
  if (/app_account_for_identity/.test(text)) return 'LoginAccount';
  if (/clock_timestamp/.test(text)) return 'decidedAt';
  return table ?? text.trim().split(/\s+/).slice(0, 2).join(' ');
}
interface Fake {
  pool: Pool;
  log: string[];
  released: () => boolean;
  /** Revokes the membership: later Membership reads return no row. */
  revoke: () => void;
  /** Holds the next statement with this label until `resume()`. */
  deferNext: (label: string) => void;
  resume: () => void;
}
function fakePool(): Fake {
  const log: string[] = [];
  let revoked = false;
  let released = false;
  let deferred: string | null = null;
  let resume = () => {};
  const answer = (text: string) => {
    if (released) throw new Error('TEST: query on a released client');
    const l = label(text);
    log.push(l);
    switch (l) {
      case 'LoginAccount':
        return [
          {
            orgId: ORG,
            id: 'TEST-account',
            personId: 'TEST-person',
            authzVersion: 1,
          },
        ];
      case 'decidedAt':
        return [{ decidedAt: '2026-10-05 08:00:00.123456+00' }];
      case 'Membership':
        return revoked
          ? []
          : [{ role: 'EXECUTIVE_READER', projectId: PROJECT }];
      case 'Project':
        return [
          {
            id: PROJECT,
            name: 'TEST',
            code: 'TEST',
            timezone: 'Europe/Berlin',
          },
        ];
      case 'DailyClose':
        return ['2026-10-03', '2026-10-04', '2026-10-05'].map(
          (businessDate) => ({
            businessDate,
            qty: { support: '10' },
          }),
        );
      case 'PlanVersion':
        return ['2026-10-03', '2026-10-04', '2026-10-05'].map((target) => ({
          target,
          number: 1,
          rows: [{ item: 'support', target: '100' }],
          confirmedAt: new Date('2026-10-01T00:00:00Z'),
        }));
      case 'ReportItem':
        return [];
      default:
        return [];
    }
  };
  const client = {
    query: async (text: string) => {
      const rows = answer(text);
      if (deferred && label(text) === deferred) {
        deferred = null;
        await new Promise<void>((r) => (resume = r));
      }
      return { rows, rowCount: rows.length };
    },
    release: () => {
      released = true;
    },
    on: () => client,
    removeListener: () => client,
  };
  const pool = {
    connect: async () => {
      released = false;
      return client;
    },
  } as unknown as Pool;
  return {
    pool,
    log,
    released: () => released,
    revoke: () => (revoked = true),
    deferNext: (l) => (deferred = l),
    resume: () => resume(),
  };
}

/** The lag request as it ran before the report exit (a638003, IssueStore.lag). */
const LAG_BEFORE_EXIT = [
  'BEGIN',
  // A7-0b (ADR-0003 D5): transaction_timeout first, then the other bounds; the account row
  // through the first-lock function and the decision clock read after it; the admission membership read that the old account query
  // did inside its EXISTS. The read path after it is unchanged.
  'SET LOCAL',
  'SET LOCAL',
  'set_config',
  'LoginAccount',
  'decidedAt',
  'set_config',
  'Membership',
  'Membership',
  'Project',
  'DailyClose',
  'PlanVersion',
  'Issue',
  'LagDismissal',
  'COMMIT',
];

describe('lag through reportReader.lagHistory', () => {
  it('runs the pre-exit query sequence: one authorization, then history', async () => {
    const fake = fakePool();
    const result = await new IssueStore(fake.pool).lag(
      identity,
      PROJECT,
      '2026-10-05',
    );
    expect(fake.log).toEqual(LAG_BEFORE_EXIT);
    expect(result.suggestions).toEqual([{ workItemKey: 'support' }]);
  });
  it('a revocation committed after the authorization meets no second check (same outcome as before the exit)', async () => {
    const fake = fakePool();
    const pool = fake.pool;
    const connect = pool.connect.bind(pool);
    // Revoke as soon as the project authorization (the second membership read, after the
    // admission read of A7-0b) has read the membership.
    (pool as unknown as { connect: () => Promise<unknown> }).connect =
      async () => {
        const client = (await connect()) as {
          query: (t: string) => Promise<unknown>;
        };
        const query = client.query;
        let reads = 0;
        client.query = async (text: string) => {
          const r = await query(text);
          if (label(text) === 'Membership' && ++reads === 2) fake.revoke();
          return r;
        };
        return client;
      };
    const result = await new IssueStore(pool).lag(
      identity,
      PROJECT,
      '2026-10-05',
    );
    expect(result.suggestions).toEqual([{ workItemKey: 'support' }]);
    expect(fake.log.filter((l) => l === 'Membership')).toHaveLength(2);
  });
});

describe('report read context lives only inside its transaction', () => {
  it('a context or view captured inside read() is refused after it returns, without touching the released client', async () => {
    const fake = fakePool();
    const store = new ReportStore(fake.pool);
    let captured: ReportReadContext | undefined;
    let view: ReturnType<typeof reportReader.forContext> | undefined;
    await store.read(identity, async (ctx) => {
      captured = ctx;
      view = reportReader.forContext(ctx);
      return view.items(PROJECT);
    });
    expect(fake.released()).toBe(true);
    const queries = fake.log.length;
    await expect(view!.items(PROJECT)).rejects.toThrow(
      'REPORT_READ_CONTEXT_CLOSED',
    );
    await expect(reportReader.forContext(captured!).projects()).rejects.toThrow(
      'REPORT_READ_CONTEXT_CLOSED',
    );
    await expect(
      reportReader.lagHistory(captured!, PROJECT, '2026-10-03', '2026-10-05'),
    ).rejects.toThrow('REPORT_READ_CONTEXT_CLOSED');
    expect(fake.log.length).toBe(queries);
  });
  it('an in-flight view call never reaches the client after COMMIT: its next query is refused', async () => {
    // Design: every query through a context's client checks that the context is still live
    // (report-read-context.ts); the transaction does not wait for calls the callback left behind.
    const fake = fakePool();
    let pending: Promise<unknown> | undefined;
    await new ReportStore(fake.pool).read(identity, async (ctx) => {
      // Armed inside the read: the account transaction's own admission read (A7-0b) is done.
      fake.deferNext('Membership');
      pending = reportReader.forContext(ctx).items(PROJECT);
      pending.catch(() => {});
      return null;
    });
    expect(fake.log.at(-1)).toBe('COMMIT');
    expect(fake.released()).toBe(true);
    fake.resume();
    await expect(pending).rejects.toThrow('REPORT_READ_CONTEXT_CLOSED');
    expect(fake.log.slice(fake.log.indexOf('COMMIT') + 1)).toEqual([]);
  });
  it('a forged or copied context is refused; no client or actor is recoverable from it', async () => {
    const fake = fakePool();
    const store = new ReportStore(fake.pool);
    await store.read(identity, async (ctx) => {
      expect(Object.getOwnPropertySymbols(ctx)).toEqual([]);
      expect(Object.getOwnPropertyNames(ctx)).toEqual([]);
      const copy = { ...ctx } as ReportReadContext;
      await expect(reportReader.forContext(copy).projects()).rejects.toThrow(
        'REPORT_READ_CONTEXT_CLOSED',
      );
      return null;
    });
    const forged = {} as ReportReadContext;
    await expect(
      reportReader.forContext(forged).items(PROJECT),
    ).rejects.toThrow('REPORT_READ_CONTEXT_CLOSED');
  });
});

describe('projection observer (test hook)', () => {
  it('cannot be installed outside a test process', () => {
    const env = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => observeReportProjections(() => {})).toThrow('test-only');
    } finally {
      process.env['NODE_ENV'] = env;
    }
  });
  it('a throwing observer never fails the read', async () => {
    const fake = fakePool();
    observeReportProjections(() => {
      throw new Error('TEST observer');
    });
    try {
      const items = await new ReportStore(fake.pool).read(identity, (ctx) =>
        reportReader.forContext(ctx).items(PROJECT),
      );
      expect(items).toEqual([]);
    } finally {
      observeReportProjections(null);
    }
  });
});
