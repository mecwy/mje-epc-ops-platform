import type {
  PeopleWindowSummaryDto,
  SafeFrozenWeatherReference,
  WeatherLocationDto,
  WeatherRequestDto,
  WeatherSnapshotDto,
  WeatherRequestCommand,
  ConfigureWeatherLocationCommand,
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
  CaptureFixDto,
  LinkPhotoCommand,
  PhotoAsOfDto,
  PhotoDto,
  PhotoLinkDto,
  PhotoSourceDto,
  UnlinkPhotoCommand,
  EntryCodeDto,
  FieldDeviceDto,
  FieldDeviceListDto,
  FieldSettingsCommand,
  FieldSettingsDto,
  PmConfirmCommand,
  PmDeviceCommand,
  RotateEntryCodeCommand,
  SiteReferenceCommand,
  CheckInListDto,
  CheckInResultDto,
  ForemanAdoptCommand,
  ForemanAdoptResultDto,
  ForemanDayDto,
  PmProxyCheckInCommand,
  RosterDto,
  ProjectHomeDto,
  ProjectOverviewDto,
  AddStatusNoteCommand,
  ProjectAttentionDto,
  ProjectStatusHistoryDto,
  StatusCommandResultDto,
  DeclareStatusCommand,
  StatusFieldName,
} from '@mje/contracts';
import { parsePeopleWindowSummary, STATUS_FIELD_NAMES } from '@mje/contracts';
import { parseFrozenWeatherReferences } from './report/weather-adapter.js';
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
  /** Frozen safe references only; draft requests and personal coordinates never enter this view. */
  weatherReferences?: SafeFrozenWeatherReference[];
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
  /** Absent on legacy revisions; never regenerated as historical data. */
  personnelSummary?: PeopleWindowSummaryDto;
  /** Absent only in revisions submitted before issues existed. */
  issues?: IssueAsOf[];
  /**
   * The photos a submission froze, with the link each had then (absent in revisions submitted
   * before photos existed). Live content carries the linked photos as they are now.
   */
  photos?: PhotoAsOfDto[];
}
export interface RevisionMeta {
  n: number;
  at: string;
  by: string;
  reason: string;
}
/** The writer's live foreman view (C37); a reader never gets it. */
export type ForemanDayView = ForemanDayDto & {
  expectedCrewsChanged: boolean | null;
};
export interface DayView extends Omit<ReportContent, 'photos'> {
  /** Writers only: the foreman claims beside the PM's facts (never merged into them). */
  foreman?: ForemanDayView;
  access: Access;
  /** The day's photos as they are now, linked or not. */
  photos: PhotoDto[];
  /** Photos a submission would leave out (no valid current link). */
  unlinkedPhotos: number;
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
  reportRevisionId?: string;
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

export interface PhotoList {
  access: Access;
  projectId: string;
  businessDate: string;
  photos: PhotoDto[];
  /** Photos a submission would leave out (no valid current link). */
  unlinkedPhotos: number;
}
/** One upload as sent: the same key, bytes, fix and link on every retry. */
export interface PhotoUpload {
  projectId: string;
  businessDate: string;
  clientMutationId: string;
  source: PhotoSourceDto;
  photo: Blob;
  mediaType: string;
  thumbnail: Blob | null;
  /** camera only: the device fix; album never sends the uploader's position. */
  fix: CaptureFixDto | null;
  /** camera only: device clock when the picture was received. */
  takenAt: string | null;
  link: PhotoLinkDto | null;
}
export type PhotoUploadResult = PhotoDto & { deduplicated: boolean };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    /** This answer came after an earlier attempt of the same request was lost (a resend). */
    public readonly afterLostAttempt = false,
    /** Sanitized fixed names; never response text or original input. */
    public readonly fields: readonly StatusFieldName[] = [],
  ) {
    super(code);
  }
}
type Command = { clientMutationId: string };

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/**
 * The error code of a failed response, and nothing else: only a well-formed code from a JSON
 * body is kept (never raw text, markup or a proxy's error page), so the screen can only show
 * a message chosen for a known code.
 */
export function responseCode(status: number, body: string): string {
  let code: unknown;
  try {
    code = (JSON.parse(body) as { code?: unknown } | null)?.code;
  } catch {
    code = undefined;
  }
  if (typeof code === 'string' && CODE.test(code)) return code;
  // A gateway in front of the API can refuse a large body without the API's JSON.
  if (status === 413) return 'PHOTO_TOO_LARGE';
  return 'REQUEST_FAILED';
}
function statusFields(body: string): StatusFieldName[] {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (
      record.code !== 'STATUS_FIELDS_REQUIRED' ||
      !Array.isArray(record.fields)
    )
      return [];
    const fields: unknown[] = record.fields;
    if (
      !fields.every(
        (field): field is StatusFieldName =>
          typeof field === 'string' &&
          STATUS_FIELD_NAMES.some((name) => name === field),
      )
    )
      return [];
    return [...new Set(fields)];
  } catch {
    return [];
  }
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const abortError = () => new DOMException('Request cancelled', 'AbortError');
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? abortError() : error);
      },
    );
  });
}
function retryWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return wait(ms);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One request. Writes carry Idempotency-Key = clientMutationId, so a write lost to the network
 * is resent with the same key and the server returns the original result instead of a duplicate.
 */
async function request<T>(
  path: string,
  token: string,
  command?: Command,
  onRetry?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    let response: Response;
    try {
      response = await abortable(
        fetch(path, {
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
          ...(signal ? { signal } : {}),
        }),
        signal,
      );
    } catch (error) {
      checkAbort(signal);
      if (
        signal &&
        error instanceof DOMException &&
        error.name === 'AbortError'
      )
        throw error;
      if (attempt >= 3) throw new ApiError('NETWORK', 0);
      onRetry?.();
      await retryWait(800 * 2 ** attempt, signal);
      void error;
      continue;
    }
    if (!response.ok) {
      const body = await abortable(
        response.text().catch(() => ''),
        signal,
      );
      throw new ApiError(
        responseCode(response.status, body),
        response.status,
        attempt > 0,
        statusFields(body),
      );
    }
    return (await abortable(response.json(), signal)) as T;
  }
}

const qs = (params: Record<string, string | number>) =>
  new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();

/** Multipart fields of an upload; empty parts are left out (the server counts every field). */
export function uploadForm(u: PhotoUpload): FormData {
  const form = new FormData();
  const fields: [string, string | null][] = [
    ['projectId', u.projectId],
    ['businessDate', u.businessDate],
    ['clientMutationId', u.clientMutationId],
    ['source', u.source],
    ['lat', u.fix?.lat ?? null],
    ['lon', u.fix?.lon ?? null],
    ['accuracyM', u.fix?.accuracyM ?? null],
    ['fixAt', u.fix?.fixAt ?? null],
    ['takenAt', u.takenAt],
    ['workItemKey', u.link?.type === 'item' ? u.link.id : null],
    ['issueId', u.link?.type === 'issue' ? u.link.id : null],
  ];
  for (const [k, v] of fields) if (v !== null) form.append(k, v);
  // Generic file names: the device's own file name is not needed and not sent.
  form.append('photo', new Blob([u.photo], { type: u.mediaType }), 'photo');
  if (u.thumbnail) form.append('thumbnail', u.thumbnail, 'thumbnail');
  return form;
}

/**
 * Upload with progress (fetch has none). Idempotency-Key = clientMutationId, so a retry of the
 * same upload returns the stored photo instead of a second one. Never retried here: the caller
 * keeps the upload and resends it unchanged when the user asks.
 */
function sendUpload(
  u: PhotoUpload,
  token: string,
  onProgress: (percent: number) => void,
): Promise<PhotoUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/report/photos');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Idempotency-Key', u.clientMutationId);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0)
        onProgress(Math.min(100, Math.floor((e.loaded * 100) / e.total)));
    };
    const lost = () => reject(new ApiError('NETWORK', 0));
    xhr.onerror = lost;
    xhr.onabort = lost;
    xhr.ontimeout = lost;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as PhotoUploadResult);
        } catch {
          // Stored or not is unknown: keep the upload for an unchanged retry.
          reject(new ApiError('NETWORK', xhr.status));
        }
        return;
      }
      reject(
        new ApiError(responseCode(xhr.status, xhr.responseText), xhr.status),
      );
    };
    xhr.send(uploadForm(u));
  });
}

/** Image bytes through the API with the bearer token (never a token or blob URL in a link). */
async function imageBytes(path: string, token: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  if (!response.ok)
    throw new ApiError(
      responseCode(response.status, await response.text().catch(() => '')),
      response.status,
    );
  return response.blob();
}

export function reportApi(token: () => Promise<string>, onRetry?: () => void) {
  const get = async <T>(
    path: string,
    params: Record<string, string | number>,
  ) => request<T>(`/api/report/${path}?${qs(params)}`, await token());
  const post = async <T>(path: string, command: Command) =>
    request<T>(`/api/report/${path}`, await token(), command, onRetry);
  const apiGet = async <T>(path: string) => request<T>(path, await token());
  const apiPost = async <T>(path: string, command: Command) =>
    request<T>(path, await token(), command, onRetry);
  const weatherRead = async <T>(path: string, signal?: AbortSignal) => {
    checkAbort(signal);
    const accessToken = await abortable(token(), signal);
    checkAbort(signal);
    return request<T>(path, accessToken, undefined, undefined, signal);
  };
  const weatherWrite = async <T>(
    path: string,
    command: Command,
    signal?: AbortSignal,
  ) => {
    checkAbort(signal);
    const accessToken = await abortable(token(), signal);
    checkAbort(signal);
    return request<T>(path, accessToken, command, onRetry, signal);
  };
  return {
    projects: async () =>
      request<ProjectsResponse>('/api/report/projects', await token()),
    projectHome: (query: {
      group: 'region' | 'manager' | 'type';
      status: string | null;
      q: string;
      page: number;
      size: number;
    }) =>
      apiGet<ProjectHomeDto>(
        `/api/projects/home?${qs({
          group: query.group,
          ...(query.status ? { status: query.status } : {}),
          q: query.q,
          page: query.page,
          size: query.size,
        })}`,
      ),
    projectAttention: () => apiGet<ProjectAttentionDto>('/api/attention'),
    projectOverview: (projectId: string, statusPage = 1) =>
      apiGet<ProjectOverviewDto>(
        `/api/projects/${encodeURIComponent(projectId)}/overview?${qs({ statusPage })}`,
      ),
    addProjectStatusNote: (command: AddStatusNoteCommand) => {
      const body = {
        clientMutationId: command.clientMutationId,
        text: command.text,
      };
      return apiPost<StatusCommandResultDto>(
        `/api/projects/${encodeURIComponent(command.projectId)}/status/${command.n}/notes`,
        body,
      );
    },
    projectStatus: (projectId: string) =>
      apiGet<ProjectStatusHistoryDto>(
        `/api/projects/${encodeURIComponent(projectId)}/status`,
      ),
    declareProjectStatus: (command: DeclareStatusCommand) => {
      const { projectId, ...body } = command;
      return apiPost<StatusCommandResultDto>(
        `/api/projects/${encodeURIComponent(projectId)}/status`,
        body,
      );
    },
    day: async (projectId: string, businessDate: string) => {
      const result = await get<DayView>('day', { projectId, businessDate });
      if (result.weatherReferences !== undefined) {
        try {
          result.weatherReferences = parseFrozenWeatherReferences(
            result.weatherReferences,
            projectId,
            businessDate,
          );
        } catch {
          throw new ApiError('INVALID_RESPONSE', 502);
        }
      }
      return result;
    },
    revision: async (projectId: string, businessDate: string, n: number) => {
      const result = await get<RevisionView>('revision', {
        projectId,
        businessDate,
        n,
      });
      if (result.snapshot.weatherReferences !== undefined) {
        try {
          result.snapshot.weatherReferences = parseFrozenWeatherReferences(
            result.snapshot.weatherReferences,
            projectId,
            businessDate,
          );
        } catch {
          throw new ApiError('INVALID_RESPONSE', 502);
        }
      }
      if (result.snapshot.personnelSummary !== undefined) {
        try {
          result.snapshot.personnelSummary = parsePeopleWindowSummary(
            result.snapshot.personnelSummary,
          );
          if (
            result.snapshot.personnelSummary.projectId !== projectId ||
            result.snapshot.personnelSummary.windowTo !== businessDate
          )
            throw new ApiError('INVALID_RESPONSE', 502);
        } catch {
          throw new ApiError('INVALID_RESPONSE', 502);
        }
      }
      return result;
    },
    peopleWindow: async (projectId: string, businessDate: string) => {
      const result = await get<unknown>('people-window', {
        projectId,
        businessDate,
      });
      try {
        return parsePeopleWindowSummary(result);
      } catch {
        throw new ApiError('INVALID_RESPONSE', 502);
      }
    },
    plan: (projectId: string, targetBusinessDate: string) =>
      get<PlanView>('plan', { projectId, targetBusinessDate }),
    saveFacts: (c: SaveFactsCommand) => post<WriteResult>('facts', c),
    weatherLocations: (projectId: string, signal?: AbortSignal) =>
      weatherRead<WeatherLocationDto[]>(
        `/api/weather/locations?${qs({ projectId })}`,
        signal,
      ),
    weatherSnapshot: (
      projectId: string,
      snapshotId: string,
      signal?: AbortSignal,
    ) =>
      weatherRead<WeatherSnapshotDto>(
        `/api/weather/snapshots?${qs({ projectId, snapshotId })}`,
        signal,
      ),
    weatherRequestStatus: (
      projectId: string,
      requestId: string,
      signal?: AbortSignal,
    ) =>
      weatherRead<WeatherRequestDto>(
        `/api/weather/requests?${qs({ projectId, requestId })}`,
        signal,
      ),
    requestWeather: (command: WeatherRequestCommand, signal?: AbortSignal) =>
      weatherWrite<WeatherRequestDto>('/api/weather/requests', command, signal),
    configureWeatherLocation: (command: ConfigureWeatherLocationCommand) =>
      apiPost<WeatherLocationDto>('/api/weather/locations', command),
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
    photos: (projectId: string, businessDate: string) =>
      get<PhotoList>('photos', { projectId, businessDate }),
    uploadPhoto: async (
      u: PhotoUpload,
      onProgress: (percent: number) => void,
    ) => sendUpload(u, await token(), onProgress),
    linkPhoto: (c: LinkPhotoCommand) => post<PhotoDto>('photos/link', c),
    unlinkPhoto: (c: UnlinkPhotoCommand) => post<PhotoDto>('photos/unlink', c),
    photoImage: async (photoId: string, which: 'photo' | 'thumbnail') =>
      imageBytes(
        `/api/report/photos/${encodeURIComponent(photoId)}${which === 'thumbnail' ? '/thumbnail' : ''}`,
        await token(),
      ),
    entryCode: (projectId: string) =>
      get<EntryCodeDto>('field/entry-code', { projectId }),
    rotateEntryCode: (c: RotateEntryCodeCommand) =>
      post<{ code: string; active: boolean }>('field/entry-code/rotate', c),
    /** Every device of the project, following the cursor (newest first). */
    devices: async (projectId: string): Promise<FieldDeviceDto[]> => {
      const all: FieldDeviceDto[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const r: FieldDeviceListDto = await get<FieldDeviceListDto>(
          'field/devices',
          cursor
            ? { projectId, cursor, limit: 500 }
            : { projectId, limit: 500 },
        );
        all.push(...r.devices);
        cursor = r.nextCursor;
        if (!cursor) return all;
      }
      throw new ApiError('REQUEST_FAILED', 0);
    },
    confirmDevice: (c: PmConfirmCommand) =>
      post<unknown>('field/devices/confirm', c),
    rejectDevice: (c: PmDeviceCommand) =>
      post<unknown>('field/devices/reject', c),
    revokeDevice: (c: PmDeviceCommand) =>
      post<unknown>('field/devices/revoke', c),
    fieldSettings: (projectId: string) =>
      get<FieldSettingsDto>('field/settings', { projectId }),
    setFieldSettings: (c: FieldSettingsCommand) =>
      post<{ n: number }>('field/settings', c),
    setSiteReference: (c: SiteReferenceCommand) =>
      post<{ n: number }>('field/site-reference', c),
    roster: (projectId: string) =>
      get<RosterDto>('field/roster', { projectId }),
    checkIns: (projectId: string, businessDate: string) =>
      get<CheckInListDto>('field/checkins', { projectId, businessDate }),
    pmProxy: (c: PmProxyCheckInCommand) =>
      post<CheckInResultDto>('field/checkins/proxy', c),
    adoptForeman: (c: ForemanAdoptCommand) =>
      post<ForemanAdoptResultDto>('foreman/adopt', c),
    confirmPlan: (c: ConfirmPlanCommand) =>
      post<{ targetBusinessDate: string; n: number; rows: PlanRowDto[] }>(
        'plan/confirm',
        c,
      ),
  };
}
export type ReportApi = ReturnType<typeof reportApi>;
