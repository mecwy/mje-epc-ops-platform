import type { Pool, PoolClient } from 'pg';
import type {
  ProjectStatusHistoryDto,
  StatusUpdateDto,
  StatusNoteDto,
  StatusCommandResultDto,
} from '@mje/contracts';
import {
  inTransaction,
  projectAccess,
  ReportError,
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
  'project-status.ack',
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
