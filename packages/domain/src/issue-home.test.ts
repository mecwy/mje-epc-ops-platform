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
            createdAt: '2030-01-01T10:00:00.000Z',
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
