import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import type { ManagerReviewScopeDto } from '@mje/contracts';
import {
  reportReader,
  readerContent,
  readerSnapshot,
  observeReportProjections,
} from './report-reader.js';
import {
  withReportReadContext,
  type ReportReadContext,
} from './report-read-context.js';
import {
  DENY_REVIEW_PORTS,
  type ReviewServerPorts,
} from './manager-review-store.js';
import { managerReviewSnapshotCut } from './manager-review-reader.js';
import { blankFacts } from './report-rules.js';
import type { Actor } from './store-kit.js';
import { inTransaction, transactionSignal } from './store-kit.js';
import { BusinessEvidenceReader } from './business-evidence-reader.js';
import { deniedBusinessEvidencePorts } from './business-evidence-store.js';
const scope: ManagerReviewScopeDto = {
  projectId: '10000000-0000-4000-8000-000000000001',
  businessDate: '2026-10-06',
  crewId: '20000000-0000-4000-8000-000000000001',
  itemKey: 'TEST_work',
};
const actor: Actor = {
  orgId: 'TEST_org',
  accountId: 'TEST_account',
  personId: 'TEST_reviewer',
  authzVersion: 1,
  decidedAt: '2026-10-06T12:00:00Z',
};
function fake(role: string | null, exists = true) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM "Membership"')
      ? role
        ? [{ role, projectId: scope.projectId }]
        : []
      : sql.includes('FROM "Project"')
        ? exists
          ? [{ id: scope.projectId, timezone: 'Europe/Belgrade' }]
          : []
        : [],
  }));
  return { query, client: { query } as unknown as PoolClient };
}
function read(client: PoolClient, ports?: ReviewServerPorts) {
  return withReportReadContext(client, actor, (ctx) =>
    reportReader.forContext(ctx).managerReview(scope, ports),
  );
}
describe('C04 parent report reader and frozen review cut', () => {
  it('the C04 evidence port receives a live C05 transaction on the guarded report client, never on a prototype copy', async () => {
    const { query } = fake('PROJECT_MANAGER');
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) =>
      sql.includes('app_account_for_identity')
        ? {
            rows: [
              {
                orgId: actor.orgId,
                id: actor.accountId,
                personId: actor.personId,
                authzVersion: actor.authzVersion,
              },
            ],
          }
        : sql.includes('clock_timestamp')
          ? { rows: [{ decidedAt: actor.decidedAt }] }
          : sql.includes('FROM "ForemanReport"')
            ? {
                rows: [
                  {
                    id: '30000000-0000-4000-8000-000000000001',
                    reportId: 'TEST_report',
                    n: 1,
                    rows: [{ itemKey: scope.itemKey, qty: '100' }],
                    byPersonId: 'TEST_reporter',
                    siteTimezone: 'Europe/Belgrade',
                    crewLabel: 'TEST crew',
                  },
                ],
              }
            : original(sql),
    );
    const raw = Object.assign(new EventEmitter(), { query, release: vi.fn() });
    const pool = { connect: async () => raw } as unknown as Pool;
    let childSignal: AbortSignal | undefined;
    await inTransaction(
      pool,
      { tenantId: 'TEST_tenant', objectId: 'TEST_object' },
      (client, a) =>
        withReportReadContext(client, a, async (ctx) => {
          const ports: ReviewServerPorts = {
            ...DENY_REVIEW_PORTS,
            resolveAuthority: async (c, who, s) => ({
              ...(await DENY_REVIEW_PORTS.resolveAuthority(c, who, s)),
              identityResolved: true,
              policyRef: 'TEST_policy',
              grants: [
                {
                  id: 'TEST_grant',
                  orgId: who.orgId,
                  projectId: s.projectId,
                  crewId: s.crewId,
                  itemKey: s.itemKey,
                  actions: ['READ_REVIEW'],
                  validFrom: '2026-10-01T00:00:00Z',
                  validUntil: null,
                },
              ],
            }),
            evidenceFor: async (guarded, who, target) => {
              childSignal = transactionSignal(guarded);
              expect(childSignal?.aborted).toBe(false);
              const calls = query.mock.calls.length;
              await expect(
                BusinessEvidenceReader.read(
                  Object.create(guarded) as PoolClient,
                  who,
                  target,
                  deniedBusinessEvidencePorts,
                ),
              ).rejects.toMatchObject({ code: 'INTEGRATION_REQUIRED' });
              expect(query.mock.calls).toHaveLength(calls);
              // The real reader now passes its lifetime check and reaches source resolution.
              await expect(
                BusinessEvidenceReader.read(
                  guarded,
                  who,
                  target,
                  deniedBusinessEvidencePorts,
                ),
              ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
              return null;
            },
          };
          await reportReader.forContext(ctx).managerReview(scope, ports);
        }),
    );
    expect(childSignal?.aborted).toBe(true);
    expect(raw.release).toHaveBeenCalledOnce();
  });
  it('refuses a forged context before any capability resolution', async () => {
    const ports = {
      ...DENY_REVIEW_PORTS,
      resolveAuthority: vi.fn(DENY_REVIEW_PORTS.resolveAuthority),
    };
    await expect(
      reportReader
        .forContext({} as ReportReadContext)
        .managerReview(scope, ports),
    ).rejects.toThrow('REPORT_READ_CONTEXT_CLOSED');
    expect(ports.resolveAuthority).not.toHaveBeenCalled();
  });
  it('checks tenant membership before even an empty review source', async () => {
    const { client, query } = fake(null);
    await expect(read(client)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM "Membership"');
  });
  it('checks tenant project existence before resolving grants', async () => {
    const { client, query } = fake('PROJECT_MANAGER', false);
    await expect(read(client)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('submitted-only readers cannot acquire live review facts from an injected grant', async () => {
    const { client, query } = fake('EXECUTIVE_READER');
    const ports = {
      ...DENY_REVIEW_PORTS,
      resolveAuthority: vi.fn(DENY_REVIEW_PORTS.resolveAuthority),
    };
    await expect(read(client, ports)).rejects.toMatchObject({
      code: 'READ_ONLY',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(ports.resolveAuthority).not.toHaveBeenCalled();
  });
  it('a project manager title supplies no review grant; admission uses the original field day gate', async () => {
    const { client, query } = fake('PROJECT_MANAGER');
    await expect(read(client)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('ForemanReport')),
    ).toBe(false);
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(
      calls.find(([sql]) => sql.includes('pg_advisory_xact_lock'))?.[1],
    ).toEqual([`${actor.orgId}:day:${scope.projectId}:${scope.businessDate}`]);
  });
  it('rejects a server authority belonging to another account before source access', async () => {
    const { client, query } = fake('PROJECT_MANAGER');
    const ports: ReviewServerPorts = {
      ...DENY_REVIEW_PORTS,
      resolveAuthority: async (c, a, s) => ({
        ...(await DENY_REVIEW_PORTS.resolveAuthority(c, a, s)),
        accountId: 'TEST_other_account',
      }),
    };
    await expect(read(client, ports)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      query.mock.calls.some(([sql]) => sql.includes('ForemanReport')),
    ).toBe(false);
  });
  it('reads an actual scoped TEST grant through the registered writer projection and immutable source port', async () => {
    const { client, query } = fake('PROJECT_MANAGER');
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string) =>
      sql.includes('FROM "ForemanReport"')
        ? {
            rows: [
              {
                id: 'TEST_revision',
                reportId: 'TEST_report',
                n: 1,
                rows: [{ itemKey: scope.itemKey, qty: '100' }],
                byPersonId: 'TEST_reporter',
                siteTimezone: 'Europe/Belgrade',
                crewLabel: 'TEST crew',
              },
            ],
          }
        : original(sql),
    );
    const sourceContextFor = vi.fn(async () => ({
      unit: 'TEST unit',
      scopeRef: 'TEST_scope',
      scopeStatus: 'CONFIRMED' as const,
      reportedIdentityResolved: true,
      changedByPersonIds: [],
    }));
    const ports: ReviewServerPorts = {
      ...DENY_REVIEW_PORTS,
      resolveAuthority: async (c, a, s) => ({
        ...(await DENY_REVIEW_PORTS.resolveAuthority(c, a, s)),
        identityResolved: true,
        policyRef: 'TEST_policy',
        grants: [
          {
            id: 'TEST_grant',
            orgId: a.orgId,
            projectId: s.projectId,
            crewId: s.crewId,
            itemKey: s.itemKey,
            actions: ['READ_REVIEW', 'RETURN'],
            validFrom: '2026-10-01T00:00:00Z',
            validUntil: null,
          },
        ],
      }),
      resolveIndependence: async () => ({
        status: 'CLEAR',
        policyRef: 'TEST_independence',
        partiesComplete: true,
        partyPersonIds: ['TEST_reporter'],
      }),
      sourceContextFor,
    };
    const seen: string[] = [];
    observeReportProjections((projector) => seen.push(projector));
    try {
      const result = await read(client, ports);
      expect(result).toMatchObject({
        target: { ...scope, foremanRevisionId: 'TEST_revision' },
        declaredQty: '100',
        unit: 'TEST unit',
        scopeRef: 'TEST_scope',
        reviewVersion: 0,
        judgment: null,
        capability: { actions: ['RETURN'] },
      });
      expect(seen).toEqual(['report.managerReview']);
      expect(sourceContextFor).toHaveBeenCalledWith(
        expect.anything(),
        actor,
        { ...scope, foremanRevisionId: 'TEST_revision' },
        'TEST_reporter',
      );
      expect(JSON.stringify(result)).not.toContain('authorityGrantId');
    } finally {
      observeReportProjections(null);
    }
  });
  it('freezes only event identities and evidence bases at the existing field sequence', async () => {
    const event = {
      eventId: 'TEST_event',
      target: {
        ...scope,
        foremanRevisionId: 'TEST_revision',
        actorPersonId: 'TEST_private',
      },
      reviewVersion: 2,
      evidenceBasis: {
        linkSetId: 'TEST_manifest',
        version: 3,
        raw: 'TEST_private',
      },
      confirmedQty: '99',
      actorAccountId: 'TEST_private',
    };
    const query = vi.fn(async () => ({ rows: [event] }));
    const client = { query } as unknown as PoolClient;
    const cut = await managerReviewSnapshotCut(
      client,
      actor.orgId,
      scope.projectId,
      scope.businessDate,
      7,
    );
    expect(cut).toEqual({
      asOfSeq: 7,
      events: [
        {
          eventId: 'TEST_event',
          target: { ...scope, foremanRevisionId: 'TEST_revision' },
          reviewVersion: 2,
          evidenceBasis: { linkSetId: 'TEST_manifest', version: 3 },
        },
      ],
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"daySeq"<=$4'),
      [actor.orgId, scope.projectId, scope.businessDate, 7],
    );
    expect(JSON.stringify(cut)).not.toContain('TEST_private');
    expect(JSON.stringify(cut)).not.toContain('confirmedQty');
    expect(event.confirmedQty).toBe('99');
  });
  it.each([-1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sequence %s without querying',
    async (seq) => {
      const query = vi.fn();
      await expect(
        managerReviewSnapshotCut(
          { query } as unknown as PoolClient,
          actor.orgId,
          scope.projectId,
          scope.businessDate,
          seq,
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_HISTORY_CONFLICT' });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('withholds writer cuts from reader projections without changing stored history', () => {
    const legacy = {
      facts: blankFacts(),
      items: [],
      baseline: null,
      nextPlan: { status: 'none', n: null, rows: [] },
      coverage: { missing: [], invalid: [] },
    };
    expect(readerContent(legacy, [])).not.toHaveProperty('managerReviewCut');
    expect(readerSnapshot(legacy)).not.toHaveProperty('managerReviewCut');
    const managerReviewCut = {
      asOfSeq: 7,
      events: [
        {
          eventId: 'TEST_event',
          target: { ...scope, foremanRevisionId: 'TEST_revision' },
          reviewVersion: 1,
          evidenceBasis: null,
        },
      ],
    };
    const snapshot = {
      ...legacy,
      managerReviewCut,
      businessEvidenceCut: { asOfSeq: 7, manifests: [{ id: 'TEST_manifest' }] },
      weatherReferences: [],
      otherExtension: { value: 'TEST_retained' },
      field: { private: 'TEST_hidden' },
    };
    const original = structuredClone(snapshot);
    expect(readerContent(snapshot, [])).not.toHaveProperty('managerReviewCut');
    expect(readerContent(snapshot, [])).not.toHaveProperty(
      'businessEvidenceCut',
    );
    expect(readerSnapshot(snapshot)).toMatchObject({
      weatherReferences: [],
      otherExtension: { value: 'TEST_retained' },
    });
    expect(readerSnapshot(snapshot)).not.toHaveProperty('field');
    expect(readerSnapshot(snapshot)).not.toHaveProperty('managerReviewCut');
    expect(readerSnapshot(snapshot)).not.toHaveProperty('businessEvidenceCut');
    expect(snapshot).toEqual(original);
  });
});
