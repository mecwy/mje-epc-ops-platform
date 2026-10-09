import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import type { Actor } from './store-kit.js';
import { issueReader, withIssueReadContext } from './issue-reader.js';
import type { IssueReadContext } from './issue-reader.js';

describe('issue home module exit', () => {
  it('keeps the batch projection inside its live context and returns open issues with escalation metadata', async () => {
    const projects = [
      {
        projectId: '11111111-1111-4111-8111-111111111111',
        lagOpenKeys: [],
        lagDismissedKeys: [],
        issues: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            title: 'TEST delay',
            category: 'progressLag',
            createdOn: '2030-01-01',
            dueOn: null,
            state: 'OPEN',
            workItemKey: 'module',
            escalate: false,
            attentionAt: null,
          },
        ],
      },
    ];
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: projects };
      },
    } as unknown as PoolClient;
    let view: ReturnType<typeof issueReader.forContext> | undefined;
    await withIssueReadContext(client, {} as Actor, async (ctx) => {
      view = issueReader.forContext(ctx);
      expect(await view.homeData()).toEqual({ projects });
      await expect(
        issueReader.forContext({ ...ctx } as IssueReadContext).homeData(),
      ).rejects.toThrow('ISSUE_READ_CONTEXT_CLOSED');
    });
    await expect(view!.homeData()).rejects.toThrow('ISSUE_READ_CONTEXT_CLOSED');
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("'escalate',i.escalate");
    expect(statements[0]).toContain('LEFT JOIN "Issue"');
  });
});

it('material followups use a live authorized transaction exit and shared issue locks, with no ledger deadline copy', async () => {
  const sqls: string[] = [];
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes('FROM "Membership"'))
        return { rows: [{ role: 'PROJECT_MANAGER', projectId: 'project' }] };
      if (sql.includes('FROM "Project"'))
        return { rows: [{ id: 'project', timezone: 'Europe/Belgrade' }] };
      return {
        rows: [{ id: 'issue', ownerPersonId: 'person', dueOn: '2031-01-01' }],
      };
    },
  } as unknown as PoolClient;
  let reader: ReturnType<typeof issueReader.forContext> | undefined;
  await withIssueReadContext(
    client,
    {
      orgId: 'org',
      accountId: 'account',
      decidedAt: new Date().toISOString(),
    } as Actor,
    async (ctx) => {
      reader = issueReader.forContext(ctx);
      expect(await reader.materialFollowups('project', ['issue'])).toEqual([
        { id: 'issue', ownerPersonId: 'person', dueOn: '2031-01-01' },
      ]);
      await expect(
        issueReader
          .forContext({ ...ctx } as IssueReadContext)
          .materialFollowups('project', []),
      ).rejects.toThrow('ISSUE_READ_CONTEXT_CLOSED');
    },
  );
  await expect(reader!.materialFollowups('project', [])).rejects.toThrow(
    'ISSUE_READ_CONTEXT_CLOSED',
  );
  expect(sqls.at(-1)).toContain('ORDER BY id FOR SHARE');
});
