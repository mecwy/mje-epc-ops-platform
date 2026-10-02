import type { PoolClient } from 'pg';
import type { EscalationCategory } from './report-rules.js';
import { CLOSED_STATES, ISSUE_KIND } from './issue-store.js';
import { READ_ROLES, WRITE_ROLES, type Actor } from './store-kit.js';

declare const issueReadBrand: unique symbol;
export interface IssueReadContext {
  readonly [issueReadBrand]: 'IssueReadContext';
}
const issueReadContexts = new WeakMap<
  object,
  { client: PoolClient; actor: Actor }
>();
export async function withIssueReadContext<T>(
  client: PoolClient,
  actor: Actor,
  use: (ctx: IssueReadContext) => Promise<T>,
): Promise<T> {
  const ctx = Object.freeze(Object.create(null)) as IssueReadContext;
  const guarded = Object.create(client, {
    query: {
      value: (...args: Parameters<PoolClient['query']>) => {
        if (!issueReadContexts.has(ctx))
          throw new Error('ISSUE_READ_CONTEXT_CLOSED');
        return Reflect.apply(client.query, client, args);
      },
    },
  }) as PoolClient;
  issueReadContexts.set(ctx, { client: guarded, actor });
  try {
    return await use(ctx);
  } finally {
    issueReadContexts.delete(ctx);
  }
}

export interface IssueHomeItemDto {
  id: string;
  title: string;
  category: EscalationCategory | '';
  createdOn: string;
  dueOn: string | null;
  state: string;
  workItemKey: string | null;
}
export interface IssueHomeProjectDto {
  projectId: string;
  issues: IssueHomeItemDto[];
  lagOpenKeys: string[];
  lagDismissedKeys: string[];
}
export interface IssueHomeDto {
  projects: IssueHomeProjectDto[];
}
let issueHomeObserver: (() => void) | null = null;
export function observeIssueHomeProjection(next: typeof issueHomeObserver) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('test-only observer');
  issueHomeObserver = next;
}
export const issueReader = {
  forContext(ctx: IssueReadContext) {
    return {
      async homeData(): Promise<IssueHomeDto> {
        const state =
          typeof ctx === 'object' && ctx !== null
            ? issueReadContexts.get(ctx)
            : undefined;
        if (!state) throw new Error('ISSUE_READ_CONTEXT_CLOSED');
        const { client, actor } = state;
        const rows = await client.query<IssueHomeProjectDto>(
          `SELECT p.id AS "projectId", COALESCE((SELECT jsonb_agg(DISTINCT l."workItemKey")
            FROM "Issue" l WHERE l."orgId"=p."orgId" AND l."projectId"=p.id
              AND l.kind=$4 AND l.category='progressLag' AND l."workItemKey" IS NOT NULL
              AND l.state::text <> ALL($5::text[])), '[]'::jsonb) AS "lagOpenKeys",
            COALESCE((SELECT jsonb_agg(d."workItemKey") FROM "LagDismissal" d
              WHERE d."orgId"=p."orgId" AND d."projectId"=p.id
                AND d."businessDate"=($7::timestamptz AT TIME ZONE p.timezone)::date
                AND d."workItemKey" IS NOT NULL), '[]'::jsonb) AS "lagDismissedKeys",
            COALESCE(jsonb_agg(jsonb_build_object(
            'id',i.id,'title',i.summary,'category',COALESCE(i.category,''),
            'createdOn',i."createdOn"::text,'dueOn',i."dueOn"::text,'state',i.state::text,
            'workItemKey',i."workItemKey")
            ORDER BY i."createdOn",i.seq) FILTER (WHERE i.id IS NOT NULL),'[]'::jsonb) AS issues
          FROM "Project" p JOIN "Membership" m ON m."orgId"=p."orgId"
            AND (m."projectId"=p.id OR (m."projectId" IS NULL AND m.role=ANY($3::text[])))
          LEFT JOIN "Issue" i ON i."orgId"=p."orgId" AND i."projectId"=p.id
            AND i.kind=$4 AND i.escalate AND i.state::text <> ALL($5::text[])
          WHERE p."orgId"=$1 AND m."accountId"=$2 AND m.role=ANY($6::text[])
            AND m."activeFrom"<=$7::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">$7::timestamptz)
          GROUP BY p.id`,
          [
            actor.orgId,
            actor.accountId,
            [...READ_ROLES],
            ISSUE_KIND,
            CLOSED_STATES,
            [...WRITE_ROLES, ...READ_ROLES],
            actor.decidedAt,
          ],
        );
        try {
          issueHomeObserver?.();
        } catch {
          /* Test observers cannot change a response. */
        }
        return { projects: rows.rows };
      },
    };
  },
};
