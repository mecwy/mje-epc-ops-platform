import type { Pool } from 'pg';
import type {
  ProjectAttentionDto,
  ProjectHomeDto,
  ProjectHomeQuery,
  ProjectOverviewDto,
} from '@mje/contracts';
import { ProjectStatusError } from '../project-status/rules.js';
import type { Identity } from '../alpha-store.js';
import { inTransaction } from '../store-kit.js';
import { withReportReadContext } from '../report-read-context.js';
import { reportReader as reports } from '../report-reader.js';
import { issueReader, withIssueReadContext } from '../issue-reader.js';
import { projectStatusReader } from '../project-status/reader.js';
import { withProjectStatusReadContext } from '../project-status/context.js';
import {
  aggregateProjectAttention,
  aggregateProjectHome,
  aggregateProjectOverview,
} from './aggregate.js';

export const PROJECT_HOME_PROJECTORS = [
  'project-home.home',
  'project-home.attention',
  'project-home.overview',
] as const;
let observer:
  ((name: (typeof PROJECT_HOME_PROJECTORS)[number]) => void) | null = null;
export function observeProjectHomeProjections(next: typeof observer) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('test-only observer');
  observer = next;
}
function projected<T>(
  name: (typeof PROJECT_HOME_PROJECTORS)[number],
  value: T,
): T {
  try {
    observer?.(name);
  } catch {
    /* Observers cannot change a response. */
  }
  return value;
}

export class ProjectHomeReader {
  constructor(private readonly pool: Pool) {}

  private async collect(identity: Identity) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const report = await withReportReadContext(client, actor, (ctx) =>
        reports.forContext(ctx).homeData(),
      );
      const issues = await withIssueReadContext(client, actor, (ctx) =>
        issueReader.forContext(ctx).homeData(),
      );
      const statuses = await withProjectStatusReadContext(
        client,
        actor,
        async (ctx) => {
          const view = projectStatusReader.forContext(ctx);
          const home = await view.homeData();
          const managers = await view.managerProjections();
          return { home, managers };
        },
      );
      return {
        report,
        issues,
        statuses: statuses.home,
        managers: statuses.managers,
      };
    });
  }

  async home(
    identity: Identity,
    query: ProjectHomeQuery,
  ): Promise<ProjectHomeDto> {
    const data = await this.collect(identity);
    return projected(
      'project-home.home',
      aggregateProjectHome({ ...data, query }),
    );
  }

  async attention(identity: Identity): Promise<ProjectAttentionDto> {
    const data = await this.collect(identity);
    return projected('project-home.attention', aggregateProjectAttention(data));
  }

  async overview(
    identity: Identity,
    projectId: string,
    historyPage = 1,
  ): Promise<ProjectOverviewDto> {
    const value = await inTransaction(
      this.pool,
      identity,
      async (client, actor) => {
        const report = await withReportReadContext(client, actor, (ctx) =>
          reports.forContext(ctx).homeData(),
        );
        const issues = await withIssueReadContext(client, actor, (ctx) =>
          issueReader.forContext(ctx).homeData(),
        );
        const history = await withProjectStatusReadContext(
          client,
          actor,
          (ctx) =>
            projectStatusReader.forContext(ctx).history(projectId, historyPage),
        );
        const project = report.projects.find(
          (candidate) => candidate.id === projectId,
        );
        const issue = issues.projects.find(
          (candidate) => candidate.projectId === projectId,
        );
        if (!project || !issue) throw new ProjectStatusError('NOT_FOUND');
        return aggregateProjectOverview({
          report: project,
          history,
          issues: issue.issues,
        });
      },
    );
    return projected('project-home.overview', value);
  }
}
