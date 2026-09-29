import type {
  CancelCorrectionCommand,
  CloseIssueCommand,
  CreateIssueCommand,
  DismissLagCommand,
  EscalationCategory,
  NoteIssueCommand,
  ReplyIssueCommand,
  SetEscalateCommand,
  ConfirmPlanCommand,
  DayFactsDto,
  NoWorkCommand,
  PlanRowDto,
  ReportItemDto,
  SaveFactsCommand,
  SavePlanDraftCommand,
  StartCorrectionCommand,
  SubmitReportCommand,
} from '@mje/contracts';
import type { Coverage } from '@mje/domain/rules';

export interface AuthConfig {
  enabled: boolean;
  tenantId?: string;
  clientId?: string;
  scope?: string;
}
export type Access = 'write' | 'read';
export interface Project {
  id: string;
  name: string;
  code: string;
  timezone: string;
  access: Access;
}
export interface ProjectsResponse {
  accountId: string;
  personId: string;
  projects: Project[];
}
export type DayState = 'empty' | 'draft' | 'submitted' | 'correcting';
export interface PlanStatusDto {
  status: 'confirmed' | 'draft' | 'none';
  n: number | null;
}
export interface Carried {
  value: string;
  asOf: string;
}
export interface MaterialTotal {
  value: string | null;
  complete: boolean;
}
/** An issue as it stands on a business day (live) or stood at submission (snapshot). */
export interface IssueAsOf {
  id: string;
  title: string;
  category: EscalationCategory | '';
  escalate: boolean;
  controlled: boolean;
  ownerPersonId: string | null;
  dueOn: string | null;
  workItemKey: string | null;
  status: 'open' | 'closed';
  closedToday: boolean;
  last: { kind: 'note' | 'reply'; text: string; onDate: string } | null;
}
export interface IssueNote {
  id: string;
  kind: 'note' | 'reply';
  text: string;
  onDate: string;
  authorPersonId: string;
  at: string;
}
/** The editable issue of the issue list: as-of-day status plus current version and notes. */
export interface IssueItem extends IssueAsOf {
  createdOn: string;
  closedOn: string | null;
  state: string;
  version: number;
  notes: IssueNote[];
}
export interface IssueList {
  access: Access;
  projectId: string;
  businessDate: string;
  issues: IssueItem[];
}
export interface LagView {
  projectId: string;
  businessDate: string;
  suggestions: { workItemKey: string }[];
}

/** What the report screens render: a live day or a frozen revision snapshot. */
export interface ReportContent {
  businessDate: string;
  facts: DayFactsDto;
  items: ReportItemDto[];
  baseline: { n: number; rows: PlanRowDto[] } | null;
  nextPlan: {
    status: PlanStatusDto['status'];
    n: number | null;
    rows: PlanRowDto[];
  };
  previousSubmittedDate: string | null;
  cumulativeBase: Record<string, Carried>;
  materialsCumulative: Record<string, MaterialTotal>;
  coverage: Coverage;
  /** Absent only in revisions submitted before issues existed. */
  issues?: IssueAsOf[];
}
export interface RevisionMeta {
  n: number;
  at: string;
  by: string;
  reason: string;
}
export interface DayView extends ReportContent {
  access: Access;
  projectId: string;
  siteTimezone: string;
  state: DayState;
  version: number;
  currentRevisionNumber: number;
  correctionReason: string | null;
  planStatus: PlanStatusDto;
  revisions: RevisionMeta[];
}
export interface RevisionView extends RevisionMeta {
  snapshot: ReportContent & { correctionReason: string };
}
export interface PlanView {
  targetBusinessDate: string;
  status: PlanStatusDto;
  rows: PlanRowDto[];
  draft: PlanRowDto[] | null;
  versions: Array<{ n: number; rows: PlanRowDto[]; at: string; by: string }>;
}
export interface WriteResult {
  businessDate: string;
  version: number;
  state: DayState;
  revisionNumber?: number;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
type Command = { clientMutationId: string };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One request. Writes carry Idempotency-Key = clientMutationId, so a write lost to the network
 * is resent with the same key and the server returns the original result instead of a duplicate.
 */
async function request<T>(
  path: string,
  token: string,
  command?: Command,
  onRetry?: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, {
        method: command ? 'POST' : 'GET',
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(command
            ? {
                'Content-Type': 'application/json',
                'Idempotency-Key': command.clientMutationId,
              }
            : {}),
        },
        ...(command ? { body: JSON.stringify(command) } : {}),
      });
    } catch (error) {
      if (attempt >= 3) throw new ApiError('NETWORK', 0);
      onRetry?.();
      await wait(800 * 2 ** attempt);
      void error;
      continue;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
      };
      throw new ApiError(body.code ?? 'REQUEST_FAILED', response.status);
    }
    return (await response.json()) as T;
  }
}

const qs = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

export function reportApi(token: () => Promise<string>, onRetry?: () => void) {
  const get = async <T>(
    path: string,
    params: Record<string, string | number>,
  ) => request<T>(`/api/report/${path}?${qs(params)}`, await token());
  const post = async <T>(path: string, command: Command) =>
    request<T>(`/api/report/${path}`, await token(), command, onRetry);
  return {
    projects: async () =>
      request<ProjectsResponse>('/api/report/projects', await token()),
    day: (projectId: string, businessDate: string) =>
      get<DayView>('day', { projectId, businessDate }),
    revision: (projectId: string, businessDate: string, n: number) =>
      get<RevisionView>('revision', { projectId, businessDate, n }),
    plan: (projectId: string, targetBusinessDate: string) =>
      get<PlanView>('plan', { projectId, targetBusinessDate }),
    saveFacts: (c: SaveFactsCommand) => post<WriteResult>('facts', c),
    submit: (c: SubmitReportCommand) => post<WriteResult>('submit', c),
    noWork: (c: NoWorkCommand) => post<WriteResult>('no-work', c),
    startCorrection: (c: StartCorrectionCommand) =>
      post<WriteResult>('correction/start', c),
    cancelCorrection: (c: CancelCorrectionCommand) =>
      post<WriteResult>('correction/cancel', c),
    savePlanDraft: (c: SavePlanDraftCommand) =>
      post<{ targetBusinessDate: string; status: PlanStatusDto }>(
        'plan/draft',
        c,
      ),
    issues: (projectId: string, businessDate: string) =>
      get<IssueList>('issues', { projectId, businessDate }),
    lag: (projectId: string, businessDate: string) =>
      get<LagView>('issues/lag', { projectId, businessDate }),
    createIssue: (c: CreateIssueCommand) => post<unknown>('issues', c),
    noteIssue: (c: NoteIssueCommand) => post<unknown>('issues/note', c),
    escalateIssue: (c: SetEscalateCommand) =>
      post<unknown>('issues/escalate', c),
    closeIssue: (c: CloseIssueCommand) => post<unknown>('issues/close', c),
    reopenIssue: (c: CloseIssueCommand) => post<unknown>('issues/reopen', c),
    replyIssue: (c: ReplyIssueCommand) => post<unknown>('issues/reply', c),
    dismissLag: (c: DismissLagCommand) =>
      post<unknown>('issues/lag/dismiss', c),
    confirmPlan: (c: ConfirmPlanCommand) =>
      post<{ targetBusinessDate: string; n: number; rows: PlanRowDto[] }>(
        'plan/confirm',
        c,
      ),
  };
}
export type ReportApi = ReturnType<typeof reportApi>;
