import type {
  ProjectAttentionDto,
  ProjectAttentionItem,
  ProjectHomeCard,
  ProjectHomeDto,
  ProjectHomeQuery,
  ProjectHomeState,
  ProjectOverviewDto,
  ProjectManagerProjectionsDto,
} from '@mje/contracts';
import type { IssueHomeDto } from '../issue-reader.js';
import type { ReportHomeDto, ReportHomeProjectDto } from '../report-reader.js';
import type { ProjectStatusHomeDto } from '../project-status/reader.js';
import type { ProjectStatusHistoryDto } from '@mje/contracts';
import { completion, forecastCompletion, statusAge } from './rules.js';
import { lagSuggestions, shiftDate } from '../report-rules.js';

function cumulativeValue(
  snapshot: ReportHomeProjectDto['snapshots'][number],
  key: string,
) {
  const value = snapshot.facts.cumulative[key];
  return value === undefined || value === ''
    ? (snapshot.facts.cumulativeCarry?.[key]?.value ?? null)
    : value;
}

function reportCard(
  report: ReportHomeProjectDto,
  status: ProjectStatusHomeDto['projects'][number],
  issue: IssueHomeDto['projects'][number],
  managers: ProjectManagerProjectionsDto,
): ProjectHomeCard {
  const latest = report.snapshots.at(-1);
  const latestItems = latest?.items ?? [];
  const frozenKey = latest
    ? Object.hasOwn(latest, 'primaryWorkItemKey')
      ? latest.primaryWorkItemKey
      : undefined
    : undefined;
  const primary =
    frozenKey && typeof frozenKey === 'string'
      ? latestItems.find(
          (item) => item.kind === 'work' && item.key === frozenKey,
        )
      : undefined;
  const cumulative =
    frozenKey && latest ? cumulativeValue(latest, frozenKey) : null;
  const derivedCompletion = completion(
    frozenKey,
    primary?.designQty ?? null,
    cumulative,
  );
  const forecast =
    frozenKey && latest
      ? forecastCompletion({
          today: report.today,
          primaryWorkItemKey: frozenKey,
          unit: primary?.unit ?? null,
          designQty: primary?.designQty ?? null,
          cumulative,
          observations: report.snapshots.map((snapshot) => {
            const key = Object.hasOwn(snapshot, 'primaryWorkItemKey')
              ? (snapshot.primaryWorkItemKey ?? null)
              : null;
            const item = snapshot.items.find(
              (candidate) => candidate.kind === 'work' && candidate.key === key,
            );
            return {
              businessDate: snapshot.businessDate,
              primaryWorkItemKey: key,
              unit: item?.unit ?? null,
              qty: snapshot.facts.qty[frozenKey] ?? null,
            };
          }),
        })
      : { state: 'NOT_COMPUTABLE' as const };
  const statusAgeResult = statusAge(
    report.today,
    status.latest?.businessDate ?? null,
  );
  const declaredStatus = status.latest?.status ?? null;
  const value: ProjectHomeState = !declaredStatus
    ? 'UNDECLARED'
    : declaredStatus === 'OFF_TRACK'
      ? 'OFF_TRACK'
      : declaredStatus === 'AT_RISK'
        ? 'AT_RISK'
        : statusAgeResult.stale
          ? 'STALE'
          : declaredStatus;
  const hints: ProjectHomeCard['hints'] = [];
  const missingDates = status.expectationDueDates.filter(
    (due) =>
      !report.snapshots.some(
        (snapshot) =>
          snapshot.businessDate === due.businessDate &&
          Date.parse(snapshot.firstSubmittedAt) <= Date.parse(due.cutoff),
      ),
  );
  if (missingDates.length)
    hints.push({ code: 'MISSING_REPORT', count: missingDates.length });
  const escalated = issue.issues.filter((item) => item.escalate);
  if (escalated.length)
    hints.push({ code: 'OPEN_ESCALATION', count: escalated.length });
  const lastSnapshot = report.snapshots.at(-1);
  if (lastSnapshot?.businessDate === report.today) {
    const belowBaseline = lagSuggestions(
      report.snapshots.slice(-3).map((snapshot) => ({
        businessDate: snapshot.businessDate,
        baseline: snapshot.baseline ? { ...snapshot.baseline, at: '' } : null,
        qty: snapshot.facts.qty,
      })),
      new Set(issue.lagOpenKeys),
      new Set(issue.lagDismissedKeys),
    );
    if (belowBaseline.length)
      hints.push({ code: 'BELOW_BASELINE', count: belowBaseline.length });
  }
  if (
    forecast.state === 'ESTIMATE' &&
    primary?.plannedDate &&
    forecast.expectedDate > primary.plannedDate
  )
    hints.push({
      code: 'FORECAST_AFTER_PLAN',
      expectedDate: forecast.expectedDate,
    });
  const projectManagers = managers
    .filter((manager) => manager.projectId === report.id)
    .filter(
      (manager, index, all) =>
        all.findIndex((other) => other.personId === manager.personId) === index,
    )
    .map(({ personId, displayName }) => ({ personId, displayName }));
  return {
    id: report.id,
    code: report.code,
    name: report.name,
    timezone: report.timezone,
    region: report.region,
    projectType: report.projectType,
    managers: projectManagers,
    status: {
      value,
      declaredStatus,
      declaredAt: status.latest?.declaredAt ?? null,
      businessDate: status.latest?.businessDate ?? null,
      staleDays: statusAgeResult.staleDays,
    },
    completion: derivedCompletion,
    forecast,
    hints,
    reportsLast7: report.reportDays,
  };
}

const priority: Record<ProjectHomeState, number> = {
  OFF_TRACK: 0,
  AT_RISK: 1,
  STALE: 2,
  PAUSED: 3,
  UNDECLARED: 4,
  NORMAL: 5,
};
function groupValues(card: ProjectHomeCard, by: ProjectHomeQuery['groupBy']) {
  if (by === 'region')
    return [
      {
        key: card.region || '__UNASSIGNED__',
        label: card.region || '__UNASSIGNED__',
      },
    ];
  if (by === 'type')
    return [
      {
        key: card.projectType || '__UNASSIGNED__',
        label: card.projectType || '__UNASSIGNED__',
      },
    ];
  return card.managers.length
    ? card.managers.map((manager) => ({
        key: manager.personId,
        label: manager.displayName,
      }))
    : [{ key: '__UNASSIGNED__', label: '__UNASSIGNED__' }];
}

const emptyCounts = (): Record<ProjectHomeState, number> => ({
  OFF_TRACK: 0,
  AT_RISK: 0,
  STALE: 0,
  PAUSED: 0,
  UNDECLARED: 0,
  NORMAL: 0,
});

export function aggregateProjectHome(input: {
  report: ReportHomeDto;
  statuses: ProjectStatusHomeDto;
  issues: IssueHomeDto;
  managers: ProjectManagerProjectionsDto;
  query: ProjectHomeQuery;
}): ProjectHomeDto {
  const statusByProject = new Map(
    input.statuses.projects.map((project) => [project.projectId, project]),
  );
  const issueByProject = new Map(
    input.issues.projects.map((project) => [project.projectId, project]),
  );
  const cards = input.report.projects.flatMap((project) => {
    const status = statusByProject.get(project.id);
    const issue = issueByProject.get(project.id);
    // The visible project set is the intersection of the three module exits.
    return status && issue
      ? [reportCard(project, status, issue, input.managers)]
      : [];
  });
  const searched = cards.filter((card) => {
    if (!input.query.query) return true;
    const needle = input.query.query.trim().toLocaleLowerCase();
    return [
      card.code,
      card.name,
      card.region ?? '',
      card.projectType ?? '',
      ...card.managers.map((manager) => manager.displayName),
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  });
  const counts = emptyCounts();
  for (const card of searched) counts[card.status.value]++;
  const filtered = searched.filter(
    (card) =>
      input.query.status === null || card.status.value === input.query.status,
  );
  const ordered = [...filtered].sort(
    (a, b) =>
      priority[a.status.value] - priority[b.status.value] ||
      a.code.localeCompare(b.code),
  );
  const offset = (input.query.page - 1) * input.query.size;
  const pageCards = ordered.slice(offset, offset + input.query.size);

  const grouped = new Map<
    string,
    { label: string; count: number; projects: ProjectHomeCard[] }
  >();
  for (const card of filtered)
    for (const group of groupValues(card, input.query.groupBy)) {
      const found = grouped.get(group.key) ?? {
        label: group.label,
        count: 0,
        projects: [],
      };
      found.count++;
      grouped.set(group.key, found);
    }
  for (const card of pageCards)
    for (const group of groupValues(card, input.query.groupBy))
      grouped.get(group.key)?.projects.push(card);
  const groups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      return {
        key,
        count: group.count,
        projects: group.projects,
      };
    })
    .filter((group) => group.projects.length > 0);
  return {
    groupBy: input.query.groupBy,
    page: input.query.page,
    size: input.query.size,
    total: filtered.length,
    counts,
    groups,
  };
}

export function aggregateProjectAttention(input: {
  report: ReportHomeDto;
  statuses: ProjectStatusHomeDto;
  issues: IssueHomeDto;
  managers: ProjectManagerProjectionsDto;
}): ProjectAttentionDto {
  const projectById = new Map(
    input.report.projects.map((project) => [project.id, project]),
  );
  const statusById = new Map(
    input.statuses.projects.map((project) => [project.projectId, project]),
  );
  const issueById = new Map(
    input.issues.projects.map((project) => [project.projectId, project]),
  );
  const make = (
    projectId: string,
    kind: ProjectAttentionItem['kind'],
    id: string,
    title: string,
    at: string | null,
  ): ProjectAttentionItem | null => {
    const project = projectById.get(projectId);
    if (!project || !statusById.has(projectId) || !issueById.has(projectId))
      return null;
    return {
      kind,
      id,
      projectId,
      projectCode: project.code,
      projectName: project.name,
      title,
      at: at === null ? null : new Date(at).toISOString(),
    };
  };
  const byKind: Record<ProjectAttentionItem['kind'], ProjectAttentionItem[]> = {
    SUPPORT: [],
    ESCALATED_ISSUE: [],
    STATUS_CHANGED: [],
  };
  for (const status of input.statuses.projects) {
    const project = projectById.get(status.projectId);
    if (!project || !issueById.has(status.projectId)) continue;
    const latest = status.latest;
    if (latest?.needsSupport) {
      const item = make(
        status.projectId,
        'SUPPORT',
        latest.id,
        latest.supportNote || latest.status,
        latest.declaredAt,
      );
      if (item) byKind.SUPPORT.push(item);
    }
    for (const update of status.recent) {
      if (
        update.previousStatus === null ||
        update.previousStatus === update.status
      )
        continue;
      const item = make(
        status.projectId,
        'STATUS_CHANGED',
        update.id,
        `${update.previousStatus} → ${update.status}`,
        update.declaredAt,
      );
      if (item) byKind.STATUS_CHANGED.push(item);
    }
  }
  for (const project of input.issues.projects)
    for (const issue of project.issues) {
      if (!issue.escalate) continue;
      const item = make(
        project.projectId,
        'ESCALATED_ISSUE',
        issue.id,
        issue.title,
        issue.attentionAt,
      );
      if (item) byKind.ESCALATED_ISSUE.push(item);
    }
  const byTimeDescending = (
    a: ProjectAttentionItem,
    b: ProjectAttentionItem,
  ) => {
    if (a.at === null) return b.at === null ? 0 : 1;
    if (b.at === null) return -1;
    return Date.parse(b.at) - Date.parse(a.at);
  };
  const items = Object.values(byKind)
    .flatMap((rows) => rows.sort(byTimeDescending).slice(0, 50))
    .sort(byTimeDescending);
  return { items };
}

export function aggregateProjectOverview(input: {
  report: ReportHomeProjectDto;
  history: ProjectStatusHistoryDto;
  issues: IssueHomeDto['projects'][number]['issues'];
}): ProjectOverviewDto {
  const latest = input.report.snapshots.at(-1);
  const frozenKey =
    latest && Object.hasOwn(latest, 'primaryWorkItemKey')
      ? latest.primaryWorkItemKey
      : undefined;
  const primary =
    typeof frozenKey === 'string'
      ? latest?.items.find(
          (item) => item.kind === 'work' && item.key === frozenKey,
        )
      : undefined;
  const cumulative = input.report.snapshots.map((snapshot) => {
    const key = Object.hasOwn(snapshot, 'primaryWorkItemKey')
      ? snapshot.primaryWorkItemKey
      : undefined;
    if (typeof key !== 'string')
      return {
        businessDate: snapshot.businessDate,
        value: null,
        workItemKey: null,
        unit: null,
      };
    const value = cumulativeValue(snapshot, key);
    return {
      businessDate: snapshot.businessDate,
      value: value === '' ? null : value,
      workItemKey: key,
      unit:
        snapshot.items.find((item) => item.kind === 'work' && item.key === key)
          ?.unit ?? null,
    };
  });
  const forecast =
    primary && typeof frozenKey === 'string'
      ? forecastCompletion({
          today: input.report.today,
          primaryWorkItemKey: frozenKey,
          unit: primary.unit,
          designQty: primary.designQty,
          cumulative: latest ? cumulativeValue(latest, frozenKey) : null,
          observations: input.report.snapshots.map((snapshot) => {
            const key = Object.hasOwn(snapshot, 'primaryWorkItemKey')
              ? (snapshot.primaryWorkItemKey ?? null)
              : null;
            const item = snapshot.items.find(
              (candidate) => candidate.kind === 'work' && candidate.key === key,
            );
            return {
              businessDate: snapshot.businessDate,
              primaryWorkItemKey: key,
              unit: item?.unit ?? null,
              qty: snapshot.facts.qty[frozenKey] ?? null,
            };
          }),
        })
      : { state: 'NOT_COMPUTABLE' as const };
  const completionValue = completion(
    typeof frozenKey === 'string' ? frozenKey : frozenKey,
    primary?.designQty ?? null,
    typeof frozenKey === 'string' && latest
      ? cumulativeValue(latest, frozenKey)
      : null,
  );
  const milestones = (latest?.milestones ?? []).flatMap((milestone) => {
    // Milestone activity is frozen only indirectly in this schema: use the same immutable
    // snapshot's items row. Never consult today's mutable master list for an old revision.
    const frozen = latest?.items.find(
      (item) => item.kind === 'milestone' && item.key === milestone.key,
    );
    if (!frozen) return [];
    const actual = latest?.facts.milestones[milestone.key]?.actual ?? null;
    return [{ ...milestone, actual, active: frozen.active }];
  });
  return {
    projectId: input.report.id,
    projectCode: input.report.code,
    projectName: input.report.name,
    timezone: input.report.timezone,
    statusHistory: input.history,
    cumulative,
    primaryWorkItem:
      primary && typeof frozenKey === 'string'
        ? {
            key: frozenKey,
            label: primary.label,
            unit: primary.unit,
            designQty: primary.designQty,
            completion: completionValue,
            forecast,
            plannedDate: primary.plannedDate ?? null,
          }
        : null,
    workItems: input.report.items.filter((item) => item.kind === 'work'),
    milestones,
    peopleLast7: Array.from({ length: 7 }, (_, index) => {
      const businessDate = shiftDate(input.report.today, index - 6);
      const snapshot = input.report.snapshots.find(
        (candidate) => candidate.businessDate === businessDate,
      );
      return { businessDate, categories: snapshot?.facts.people ?? null };
    }),
    openIssues: input.issues.map(
      ({ id, title, category, createdOn, dueOn, state }) => ({
        id,
        title,
        category,
        createdOn,
        dueOn,
        state,
      }),
    ),
  };
}
