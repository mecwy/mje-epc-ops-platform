import type { Pool, PoolClient } from 'pg';
import type {
  ProjectStatusHistoryDto,
  ProjectManagerProjectionsDto,
  StatusUpdateDto,
  StatusNoteDto,
  StatusCommandResultDto,
  PrimaryWorkItemResultDto,
  ReportingExpectationResultDto,
} from '@mje/contracts';
import {
  inTransaction,
  projectAccess,
  ReportError,
  READ_ROLES,
  WRITE_ROLES,
  type Actor,
} from '../store-kit.js';
import {
  withProjectStatusReadContext,
  openProjectStatusReadContext,
  type ProjectStatusReadContext,
} from './context.js';
import { ProjectStatusError } from './rules.js';
import type { Identity } from '../alpha-store.js';

export const PROJECT_STATUS_PROJECTORS = [
  'project-status.history',
  'project-status.managers',
  'project-status.home',
  'project-status.ack',
  'project-status.primary-ack',
  'project-status.expectation-ack',
] as const;
let observer:
  ((name: (typeof PROJECT_STATUS_PROJECTORS)[number]) => void) | null = null;
export function observeProjectStatusProjections(next: typeof observer) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('test-only observer');
  observer = next;
}
function projected<T>(
  name: (typeof PROJECT_STATUS_PROJECTORS)[number],
  value: T,
): T {
  try {
    observer?.(name);
  } catch {
    /* Test observers cannot affect reads. */
  }
  return value;
}
/** Project authorization runs even when there are no status rows. */
export async function statusProject(
  client: PoolClient,
  actor: Actor,
  projectId: string,
) {
  try {
    return await projectAccess(client, actor, projectId);
  } catch (e) {
    if (
      e instanceof ReportError &&
      (e.code === 'FORBIDDEN' || e.code === 'NOT_FOUND')
    )
      throw new ProjectStatusError('NOT_FOUND');
    throw e;
  }
}
type UpdateRow = Omit<StatusUpdateDto, 'declaredAt' | 'notes'> & {
  declaredAt: Date;
  latestN: number;
};
type NoteRow = Omit<StatusNoteDto, 'at'> & { at: Date; statusUpdateId: string };
export interface ProjectStatusHomeUpdateDto {
  id: string;
  n: number;
  status: StatusUpdateDto['status'];
  previousStatus: StatusUpdateDto['status'] | null;
  needsSupport: boolean;
  supportNote: string;
  declaredAt: string;
  businessDate: string;
  siteTimezone: string;
}
export interface ProjectStatusHomeProjectDto {
  projectId: string;
  latest: ProjectStatusHomeUpdateDto | null;
  recent: ProjectStatusHomeUpdateDto[];
  previousStatus: StatusUpdateDto['status'] | null;
  expectationDueDates: { businessDate: string; cutoff: string }[];
}
export interface ProjectStatusHomeDto {
  projects: ProjectStatusHomeProjectDto[];
}
export const projectStatusReader = {
  forContext(ctx: ProjectStatusReadContext) {
    return {
      async history(
        projectId: string,
        page = 1,
      ): Promise<ProjectStatusHistoryDto> {
        const { client, actor } = openProjectStatusReadContext(ctx);
        await statusProject(client, actor, projectId);
        const rows = await client.query<UpdateRow>(
          `WITH latest AS (SELECT COALESCE(max(n),0)::int AS "latestN" FROM "ProjectStatusUpdate" WHERE "orgId"=$1 AND "projectId"=$2)
          SELECT latest."latestN",s.id,s.n,s.status,s.areas,s.situation,s.recovery,s."expectedRecoveryDate"::text,s."expectedRecoveryUnknown",s."needsSupport",s."supportNote",s."declaredAt",s."siteTimezone",s."businessDate"::text,s."declaredBy",s."declaredByPersonId"
          FROM latest LEFT JOIN LATERAL (SELECT * FROM "ProjectStatusUpdate" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY n DESC LIMIT 20 OFFSET $3) s ON true ORDER BY s.n DESC`,
          [actor.orgId, projectId, (page - 1) * 20],
        );
        const present = rows.rows.filter((r) => r.id !== null);
        const notes = present.length
          ? await client.query<NoteRow>(
              `SELECT id,"statusUpdateId",text,"byAccountId","byPersonId",at FROM "ProjectStatusNote" WHERE "orgId"=$1 AND "projectId"=$2 AND "statusUpdateId"=ANY($3::uuid[]) ORDER BY at,id`,
              [actor.orgId, projectId, present.map((r) => r.id)],
            )
          : { rows: [] };
        const updates = present.map((r) => ({
          id: r.id,
          n: r.n,
          status: r.status,
          areas: [...r.areas],
          situation: r.situation,
          recovery: r.recovery,
          expectedRecoveryDate: r.expectedRecoveryDate,
          expectedRecoveryUnknown: r.expectedRecoveryUnknown,
          needsSupport: r.needsSupport,
          supportNote: r.supportNote,
          declaredAt: r.declaredAt.toISOString(),
          siteTimezone: r.siteTimezone,
          businessDate: r.businessDate,
          declaredBy: r.declaredBy,
          declaredByPersonId: r.declaredByPersonId,
          notes: notes.rows
            .filter((n) => n.statusUpdateId === r.id)
            .map((n) => ({
              id: n.id,
              text: n.text,
              byAccountId: n.byAccountId,
              byPersonId: n.byPersonId,
              at: n.at.toISOString(),
            })),
        }));
        return projected('project-status.history', {
          projectId,
          currentN: rows.rows[0]!.latestN,
          updates,
        });
      },
      async managerProjections(): Promise<ProjectManagerProjectionsDto> {
        const { client } = openProjectStatusReadContext(ctx);
        const rows = await client.query<ProjectManagerProjectionsDto[number]>(
          'SELECT "projectId","personId","displayName" FROM project_managers_for_org() ORDER BY "projectId","displayName","personId"',
        );
        return projected('project-status.managers', rows.rows);
      },
      async homeData(): Promise<ProjectStatusHomeDto> {
        const { client, actor } = openProjectStatusReadContext(ctx);
        const rows = await client.query<ProjectStatusHomeProjectDto>(
          `SELECT p.id AS "projectId",
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'businessDate',g.day::date::text,
              'cutoff',((g.day::date+1)::timestamp AT TIME ZONE p.timezone)) ORDER BY g.day)
              FROM generate_series(((($5::timestamptz AT TIME ZONE p.timezone)::date)-14),
                (($5::timestamptz AT TIME ZONE p.timezone)::date)-1, interval '1 day') AS g(day)
              WHERE COALESCE((SELECT g.day::date>=e."fromDate"
                  AND (e."toDate" IS NULL OR g.day::date<=e."toDate")
                  AND EXTRACT(ISODOW FROM g.day)::int=ANY(e.workdays)
                FROM "ReportingExpectationVersion" e
                WHERE e."orgId"=p."orgId" AND e."projectId"=p.id
                  AND e."registeredAt"<=((g.day::date+1)::timestamp AT TIME ZONE p.timezone)
                ORDER BY e."registeredAt" DESC,e.n DESC LIMIT 1),false)), '[]'::jsonb) AS "expectationDueDates",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'n',x.n,'status',x.status,
              'previousStatus',(SELECT prev.status FROM "ProjectStatusUpdate" prev
                WHERE prev."orgId"=x."orgId" AND prev."projectId"=x."projectId" AND prev.n<x.n
                ORDER BY prev.n DESC LIMIT 1),
              'needsSupport',x."needsSupport",'supportNote',x."supportNote",
              'declaredAt',x."declaredAt",'businessDate',x."businessDate"::text,
              'siteTimezone',x."siteTimezone") ORDER BY x.n DESC)
              FROM (SELECT s."orgId",s."projectId",s.id,s.n,s.status,s."needsSupport",s."supportNote",s."declaredAt",s."businessDate",s."siteTimezone"
                FROM "ProjectStatusUpdate" s WHERE s."orgId"=p."orgId" AND s."projectId"=p.id
                  AND s."declaredAt">=$6::timestamptz - interval '7 days'
                ORDER BY s.n DESC LIMIT 50) x), '[]'::jsonb) AS recent,
            (SELECT jsonb_build_object('id',x.id,'n',x.n,'status',x.status,
              'previousStatus',(SELECT prev.status FROM "ProjectStatusUpdate" prev
                WHERE prev."orgId"=x."orgId" AND prev."projectId"=x."projectId" AND prev.n<x.n
                ORDER BY prev.n DESC LIMIT 1),
              'needsSupport',x."needsSupport",'supportNote',x."supportNote",
              'declaredAt',x."declaredAt",'businessDate',x."businessDate"::text,
              'siteTimezone',x."siteTimezone")
              FROM "ProjectStatusUpdate" x WHERE x."orgId"=p."orgId" AND x."projectId"=p.id
              ORDER BY x.n DESC LIMIT 1) AS latest,
            (SELECT x.status FROM "ProjectStatusUpdate" x WHERE x."orgId"=p."orgId" AND x."projectId"=p.id
              ORDER BY x.n DESC OFFSET 1 LIMIT 1) AS "previousStatus"
          FROM "Project" p JOIN "Membership" m ON m."orgId"=p."orgId"
            AND (m."projectId"=p.id OR (m."projectId" IS NULL AND m.role=ANY($3::text[])))
          WHERE p."orgId"=$1 AND m."accountId"=$2 AND m.role=ANY($4::text[])
            AND m."activeFrom"<=$5::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">$5::timestamptz)
          GROUP BY p.id ORDER BY p.code`,
          [
            actor.orgId,
            actor.accountId,
            [...READ_ROLES],
            [...WRITE_ROLES, ...READ_ROLES],
            actor.decidedAt,
            actor.decidedAt,
          ],
        );
        return projected('project-status.home', { projects: rows.rows });
      },
      primaryAcknowledgement(
        projectId: string,
        value: PrimaryWorkItemResultDto,
      ): PrimaryWorkItemResultDto {
        openProjectStatusReadContext(ctx);
        if (value.projectId !== projectId)
          throw new ProjectStatusError('NOT_FOUND');
        return projected('project-status.primary-ack', {
          projectId,
          key: value.key,
          version: value.version,
        });
      },
      expectationAcknowledgement(
        projectId: string,
        value: ReportingExpectationResultDto,
      ): ReportingExpectationResultDto {
        openProjectStatusReadContext(ctx);
        if (value.projectId !== projectId)
          throw new ProjectStatusError('NOT_FOUND');
        return projected('project-status.expectation-ack', {
          projectId,
          expectationId: value.expectationId,
          n: value.n,
          registeredAt: value.registeredAt,
        });
      },
      acknowledgement(
        projectId: string,
        value: StatusCommandResultDto,
      ): StatusCommandResultDto {
        openProjectStatusReadContext(ctx);
        if (value.projectId !== projectId)
          throw new ProjectStatusError('NOT_FOUND');
        return projected('project-status.ack', {
          projectId,
          n: value.n,
          statusUpdateId: value.statusUpdateId,
          ...(value.noteId ? { noteId: value.noteId } : {}),
        });
      },
    };
  },
};
/** API composition root gets the reader exit, not its SQL or a recoverable context. */
export class ProjectStatusReader {
  constructor(private readonly pool: Pool) {}
  read<T>(
    identity: Identity,
    use: (ctx: ProjectStatusReadContext) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.pool, identity, (client, actor) =>
      withProjectStatusReadContext(client, actor, use),
    );
  }
}
