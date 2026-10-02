import type { ProjectStatus } from './project-status.js';

export type ProjectHomeState = ProjectStatus | 'STALE' | 'UNDECLARED';
export type ProjectHomeGroupBy = 'region' | 'manager' | 'type';
export interface ProjectHomeQuery {
  groupBy: ProjectHomeGroupBy;
  status: ProjectHomeState | null;
  query: string;
  page: number;
  size: number;
}
export type ProjectHomeCompletion =
  | { state: 'NOT_FROZEN' | 'UNCONFIGURED' | 'NOT_COMPUTABLE' }
  | { state: 'COMPUTABLE'; percent: string; aboveDesign: boolean };
export type ProjectHomeForecast =
  | { state: 'NOT_COMPUTABLE' | 'AT_DESIGN' }
  | { state: 'ESTIMATE'; expectedDate: string; sampleDays: number };
export interface ProjectHomeHint {
  code:
    | 'MISSING_REPORT'
    | 'OPEN_ESCALATION'
    | 'FORECAST_AFTER_PLAN'
    | 'BELOW_BASELINE';
  count?: number;
  expectedDate?: string;
}
export interface ProjectHomeCard {
  id: string;
  code: string;
  name: string;
  timezone: string;
  region: string | null;
  projectType: string | null;
  managers: { personId: string; displayName: string }[];
  status: {
    value: ProjectStatus | 'STALE' | 'UNDECLARED';
    declaredStatus: ProjectStatus | null;
    declaredAt: string | null;
    businessDate: string | null;
    staleDays: number | null;
  };
  completion: ProjectHomeCompletion;
  forecast: ProjectHomeForecast;
  hints: ProjectHomeHint[];
  reportsLast7: { businessDate: string; submitted: boolean }[];
}
export interface ProjectHomeGroup {
  key: string;
  count: number;
  projects: ProjectHomeCard[];
}
export interface ProjectHomeDto {
  groupBy: ProjectHomeGroupBy;
  page: number;
  size: number;
  total: number;
  counts: Record<ProjectHomeState, number>;
  groups: ProjectHomeGroup[];
}
export interface ProjectAttentionItem {
  kind: 'SUPPORT' | 'ESCALATED_ISSUE' | 'STATUS_CHANGED';
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  title: string;
  at: string;
}
export interface ProjectAttentionDto {
  items: ProjectAttentionItem[];
}
export interface ProjectOverviewDto {
  projectId: string;
  projectCode: string;
  projectName: string;
  timezone: string;
  statusHistory: import('./project-status.js').ProjectStatusHistoryDto;
  cumulative: { businessDate: string; value: string | null }[];
  primaryWorkItem: {
    key: string;
    label: string;
    unit: string;
    designQty: string;
    completion: ProjectHomeCompletion;
    forecast: ProjectHomeForecast;
    plannedDate: string | null;
  } | null;
  workItems: import('./report.js').ReportItemDto[];
  milestones: {
    id: string;
    key: string;
    label: string;
    plannedDate: string | null;
    actual: string | null;
    active: boolean;
  }[];
  peopleLast7: {
    businessDate: string;
    categories: Record<string, string> | null;
  }[];
  openIssues: {
    id: string;
    title: string;
    category: string;
    createdOn: string;
    dueOn: string | null;
    state: string;
  }[];
}
