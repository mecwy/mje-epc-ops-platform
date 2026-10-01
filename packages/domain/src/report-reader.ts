/**
 * The report module exit (ADR-0003 D2): every read of report data — the report read routes and
 * other modules (issue lag) — goes through `reportReader`, which checks the project and applies
 * the projection for the caller's access. Raw rows stay inside the report module
 * (report-store.ts). A read-only account (EXECUTIVE_READER) only ever gets content frozen in a
 * submitted revision and confirmed plans (OD18): a day still being written, a correction in
 * progress, a plan draft and photos not frozen in a submitted revision are never served to it,
 * and its day list does not change when a draft is started or edited. It never gets a photo's
 * coordinates (OD20, reader-view.ts). Writers (PROJECT_MANAGER) are not affected.
 */
import type {
  ForemanDayDto,
  PhotoAsOfDto,
  PlanRowDto,
  ReportItemDto,
} from '@mje/contracts';
import {
  blankFacts,
  planRows,
  shiftDate,
  planStatus,
  type CarriedCumulative,
  type Coverage,
  type DayFacts,
  type LagDay,
  type MaterialCumulative,
  type PlanState,
  type PlanStatus,
  type Reported,
} from './report-rules.js';
import {
  READ_ROLES,
  REPORT_SCOPE,
  ReportError,
  WRITE_ROLES,
  projectAccess,
  type Access,
  type Actor,
  type ReportProjectRow,
} from './store-kit.js';
import type { IssueAsOf } from './issue-store.js';
import { rosterLock } from './field-kit.js';
import { frozenPhotos } from './photo-store.js';
import { frozenPhotoFields } from './reader-view.js';
import {
  openReportReadContext,
  type ReportReadContext,
} from './report-read-context.js';
import {
  dayRow,
  dayState,
  daySnapshot,
  draftFacts,
  itemRows,
  planStateOf,
  publicItem,
  revisionRows,
  type DayRow,
  type DayState,
} from './report-store.js';

export type { ReportReadContext };

/**
 * The projection functions of the exit, by name (authz/surface.ts names them per read entry).
 * Each read records the projector that produced its response for the consumer-path check
 * (ADR-0003 D2.2); nothing is recorded unless a test installed an observer.
 */
export const REPORT_PROJECTORS = [
  'report.projects',
  'report.days.writer',
  'report.days.reader',
  'report.day.writer',
  'report.day.reader',
  'report.revision.writer',
  'report.revision.reader',
  'report.plan.writer',
  'report.plan.reader',
  'report.items',
  'report.lagHistory',
] as const;
export type ReportProjector = (typeof REPORT_PROJECTORS)[number];
let observer: ((projector: ReportProjector) => void) | null = null;
/**
 * Test hook only: observes which projector served each read; null removes it. Installing one
 * outside a test process (NODE_ENV=test, as vitest and the TEST integration runners set) throws,
 * and an observer can never fail or alter a read: its errors are ignored.
 */
export function observeReportProjections(
  next: ((projector: ReportProjector) => void) | null,
) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('observeReportProjections is test-only (NODE_ENV=test)');
  observer = next;
}
function projected<T>(projector: ReportProjector, value: T): T {
  if (observer)
    try {
      observer(projector);
    } catch {
      // A test observer never affects the read.
    }
  return value;
}

/**
 * A day in a reader's day list: only submitted days, shown as submitted also while a correction
 * is open. Any other day is left out entirely (null), so a reader cannot tell a draft from no
 * record at all, or when one was started.
 */
export function readerDayState(state: DayState): 'submitted' | null {
  return state === 'submitted' || state === 'correcting' ? 'submitted' : null;
}

/** Confirmed plan versions stay visible to readers; the draft does not exist for them. */
export function readerPlan(state: PlanState): PlanState {
  return { versions: state.versions, draft: null };
}

/** The fields of a submitted revision snapshot a day view is built from. */
interface SubmittedSnapshot {
  facts: DayFacts;
  items: ReportItemDto[];
  baseline: { n: number; rows: PlanRowDto[] } | null;
  nextPlan: {
    status: PlanStatus['status'];
    n: number | null;
    rows: PlanRowDto[];
  };
  previousSubmittedDate?: string | null;
  cumulativeBase?: Record<string, CarriedCumulative>;
  materialsCumulative?: Record<string, MaterialCumulative>;
  coverage: Coverage;
  /** Absent in revisions submitted before issues existed. */
  issues?: IssueAsOf[];
  /** Absent in revisions submitted before photos existed. */
  photos?: PhotoAsOfDto[];
}
export interface ReaderContent {
  state: 'empty' | 'submitted';
  facts: DayFacts;
  items: ReportItemDto[];
  planStatus: PlanStatus;
  baseline: SubmittedSnapshot['baseline'];
  nextPlan: SubmittedSnapshot['nextPlan'];
  previousSubmittedDate: string | null;
  cumulativeBase: Record<string, CarriedCumulative>;
  materialsCumulative: Record<string, MaterialCumulative>;
  coverage: Coverage;
  issues: IssueAsOf[];
  /** The photos the revision froze, with the link each had then. */
  frozenPhotos: PhotoAsOfDto[];
}

/**
 * The reader's day content: the latest submitted revision's snapshot, or nothing of the day
 * when none exists. `masterItems` (project master data, readable anyway) only fill the item
 * list of a day without a submission; a submitted day shows the items as frozen.
 */
export function readerContent(
  snapshot: Record<string, unknown> | null,
  masterItems: ReportItemDto[],
): ReaderContent {
  if (!snapshot)
    return {
      state: 'empty',
      facts: blankFacts(),
      items: masterItems,
      planStatus: { status: 'none', n: null },
      baseline: null,
      nextPlan: { status: 'none', n: null, rows: [] },
      previousSubmittedDate: null,
      cumulativeBase: {},
      materialsCumulative: {},
      coverage: { missing: [], invalid: [] },
      issues: [],
      frozenPhotos: [],
    };
  const s = snapshot as unknown as SubmittedSnapshot;
  const baseline = s.baseline ?? null;
  return {
    state: 'submitted',
    facts: s.facts,
    items: s.items,
    // The day's plan status as the submission saw it: its frozen baseline, never a draft.
    planStatus: baseline
      ? { status: 'confirmed', n: baseline.n }
      : { status: 'none', n: null },
    baseline,
    nextPlan: s.nextPlan,
    previousSubmittedDate: s.previousSubmittedDate ?? null,
    cumulativeBase: s.cumulativeBase ?? {},
    materialsCumulative: s.materialsCumulative ?? {},
    coverage: s.coverage,
    issues: s.issues ?? [],
    frozenPhotos: s.photos ?? [],
  };
}

/**
 * A submitted revision's snapshot as a reader is served it (OD20): its photos carry only the
 * frozen fields (position kind and accuracy, times, link), so no coordinates can reach a reader
 * whatever a snapshot holds. A projection on read; the stored revision is never changed.
 */
export function readerSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  // Check-ins, foreman reports and adoptions are writer data (A6.0): a reader never gets them,
  // frozen or live.
  let rest = snapshot;
  if ('field' in snapshot || 'foreman' in snapshot) {
    rest = { ...snapshot };
    delete rest['field'];
    delete rest['foreman'];
  }
  const photos = rest['photos'];
  if (!Array.isArray(photos)) return rest;
  return {
    ...rest,
    photos: (photos as PhotoAsOfDto[]).map(frozenPhotoFields),
  };
}

// ---------- reads ----------
type Opened = ReturnType<typeof openReportReadContext>;

async function projects({ client, actor }: Opened) {
  const result = await client.query<ReportProjectRow & { access: Access }>(
    `SELECT p.id, p.name, p.code, p.timezone,
      CASE WHEN bool_or(m.role = ANY($3::text[])) THEN 'write' ELSE 'read' END AS access
    FROM "Project" p JOIN "Membership" m ON m."orgId"=p."orgId" AND (m."projectId"=p.id OR (m."projectId" IS NULL AND m.role = ANY($4::text[])))
    WHERE p."orgId"=$1 AND m."accountId"=$2 AND m.role = ANY($5::text[])
      AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now())
    GROUP BY p.id, p.name, p.code, p.timezone ORDER BY p.code`,
    [
      actor.orgId,
      actor.accountId,
      [...WRITE_ROLES],
      [...READ_ROLES],
      [...WRITE_ROLES, ...READ_ROLES],
    ],
  );
  return projected('report.projects', {
    accountId: actor.accountId,
    personId: actor.personId,
    projects: result.rows,
  });
}

/** Day rows in a date range (at most 62 days). Reading never creates a row (rule 3). */
async function days(
  { client, actor }: Opened,
  projectId: string,
  from: string,
  to: string,
) {
  const { access } = await projectAccess(client, actor, projectId);
  const result = await client.query<{
    businessDate: string;
    state: string;
    currentRevisionNumber: number;
    correcting: boolean;
    hasFacts: boolean;
  }>(
    `SELECT d."businessDate"::text AS "businessDate", d.state, d."currentRevisionNumber",
      d."correctionReason" IS NOT NULL AS correcting, r.facts IS NOT NULL AS "hasFacts"
    FROM "DailyClose" d LEFT JOIN "DailyReportDraft" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3 AND d."businessDate" BETWEEN $4::date AND $5::date
      AND $5::date - $4::date BETWEEN 0 AND 61
    ORDER BY d."businessDate"`,
    [actor.orgId, projectId, REPORT_SCOPE, from, to],
  );
  const rows = result.rows.map((r) => {
    const state: DayState =
      r.state === 'SUBMITTED'
        ? r.correcting
          ? 'correcting'
          : 'submitted'
        : r.hasFacts
          ? 'draft'
          : 'empty';
    return {
      businessDate: r.businessDate,
      state,
      revision: r.currentRevisionNumber,
    };
  });
  if (access === 'write') return projected('report.days.writer', rows);
  // OD18: a reader gets submitted days only; a draft day is not listed at all, so the
  // response does not change when one is started or edited.
  return projected(
    'report.days.reader',
    rows.flatMap((r) => {
      const state = readerDayState(r.state);
      return state ? [{ ...r, state }] : [];
    }),
  );
}

async function day(
  { client, actor }: Opened,
  projectId: string,
  businessDate: string,
) {
  const { project, access } = await projectAccess(client, actor, projectId);
  const day = await dayRow(client, actor.orgId, projectId, businessDate);
  if (access === 'read')
    return projected(
      'report.day.reader',
      await readerDay(client, actor, project, businessDate, day),
    );
  return projected(
    'report.day.writer',
    await writerDay(client, actor, project, access, businessDate, day),
  );
}
/** A writer's live day: draft facts, live plan, photos, issues and the foreman claims. */
async function writerDay(
  client: Opened['client'],
  actor: Actor,
  project: ReportProjectRow,
  access: Access,
  businessDate: string,
  day: DayRow | null,
) {
  const projectId = project.id;
  // Level 0 shared (design §5): the expected crew set and its roster version are read
  // while no roster write can commit in between.
  await rosterLock(client, actor.orgId, projectId, true);
  const facts = day ? await draftFacts(client, actor.orgId, day.id) : null;
  const items = await itemRows(client, actor.orgId, projectId);
  const revisions = day ? await revisionRows(client, actor.orgId, day.id) : [];
  const {
    snapshot,
    coverage: cov,
    photos,
    unlinkedPhotos,
  } = await daySnapshot(
    client,
    actor,
    project,
    businessDate,
    facts ?? blankFacts(),
    items,
  );
  const today = await planStateOf(client, actor.orgId, projectId, businessDate);
  return {
    access,
    projectId,
    businessDate,
    siteTimezone: project.timezone,
    state: dayState(day, facts),
    version: day?.version ?? 0,
    currentRevisionNumber: day?.currentRevisionNumber ?? 0,
    correctionReason: day?.correctionReason ?? null,
    facts: facts ?? blankFacts(),
    items: snapshot.items,
    planStatus: planStatus(today.state),
    baseline: snapshot.baseline,
    nextPlan: snapshot.nextPlan,
    previousSubmittedDate: snapshot.previousSubmittedDate,
    cumulativeBase: snapshot.cumulativeBase,
    materialsCumulative: snapshot.materialsCumulative,
    issues: snapshot.issues,
    photos,
    /** Photos a submission would leave out (no valid current link); prompt before submit. */
    unlinkedPhotos,
    coverage: cov,
    revisions: revisions.map((r) => ({
      n: r.revisionNumber,
      at: r.submittedAt.toISOString(),
      by: r.updatedBy,
      reason: r.reason,
    })),
    foreman: foremanView(
      snapshot.foreman,
      revisions.find((r) => r.revisionNumber === day?.currentRevisionNumber)
        ?.snapshot ?? null,
    ),
  };
}

/**
 * The live foreman view for a writer. Revisions and adoptions numbered after the latest
 * submission's boundary are marked `afterSubmission` (they enter only through a correction),
 * and the live expected crew set is compared with the one that submission froze (a roster
 * change after submission never alters the revision). Null marks: never submitted.
 */
function foremanView(
  live: ForemanDayDto,
  submitted: Record<string, unknown> | null,
) {
  const frozen = submitted?.['foreman'] as ForemanDayDto | undefined;
  const field = submitted?.['field'] as { seqBoundary?: number } | undefined;
  // A revision from before field sequences existed froze none (0).
  const boundary = submitted ? (field?.seqBoundary ?? 0) : null;
  const after = (daySeq: number) => boundary !== null && daySeq > boundary;
  const ids = (d: ForemanDayDto) => d.expectedCrews.map((c) => c.crewId).sort();
  return {
    ...live,
    revisions: live.revisions.map((r) => ({
      ...r,
      afterSubmission: after(r.daySeq),
    })),
    adoptions: live.adoptions.map((a) => ({
      ...a,
      afterSubmission: after(a.daySeq),
    })),
    submittedExpectedCrews: frozen ? ids(frozen) : null,
    expectedCrewsChanged: frozen
      ? ids(frozen).join(',') !== ids(live).join(',')
      : null,
  };
}

/**
 * OD18: a reader's day is the latest submitted revision, built from its snapshot only (also
 * while a correction is open); before any submission, nothing of the day. Never the draft
 * facts, a plan draft, live issues or photos that were not frozen. Read-only, so version 0.
 */
async function readerDay(
  client: Opened['client'],
  actor: Actor,
  project: ReportProjectRow,
  businessDate: string,
  day: DayRow | null,
) {
  const revisions = day ? await revisionRows(client, actor.orgId, day.id) : [];
  const latest =
    revisions.find((r) => r.revisionNumber === day?.currentRevisionNumber) ??
    null;
  const content = readerContent(
    latest?.snapshot ?? null,
    latest
      ? []
      : (await itemRows(client, actor.orgId, project.id)).map(publicItem),
  );
  return {
    access: 'read' as Access,
    projectId: project.id,
    businessDate,
    siteTimezone: project.timezone,
    state: content.state as DayState,
    version: 0,
    currentRevisionNumber: latest ? latest.revisionNumber : 0,
    correctionReason: null,
    facts: content.facts,
    items: content.items,
    planStatus: content.planStatus,
    baseline: content.baseline,
    nextPlan: content.nextPlan,
    previousSubmittedDate: content.previousSubmittedDate,
    cumulativeBase: content.cumulativeBase,
    materialsCumulative: content.materialsCumulative,
    issues: content.issues,
    photos: await frozenPhotos(
      client,
      actor.orgId,
      project.id,
      content.frozenPhotos,
    ),
    unlinkedPhotos: 0,
    coverage: content.coverage,
    revisions: latest
      ? revisions.map((r) => ({
          n: r.revisionNumber,
          at: r.submittedAt.toISOString(),
          by: r.updatedBy,
          reason: r.reason,
        }))
      : [],
  };
}

async function revision(
  { client, actor }: Opened,
  projectId: string,
  businessDate: string,
  revisionNumber: number,
) {
  const { access } = await projectAccess(client, actor, projectId);
  const day = await dayRow(client, actor.orgId, projectId, businessDate);
  if (!day) throw new ReportError('NOT_FOUND');
  const r = (await revisionRows(client, actor.orgId, day.id)).find(
    (x) => x.revisionNumber === revisionNumber,
  );
  if (!r) throw new ReportError('NOT_FOUND');
  const head = {
    n: r.revisionNumber,
    at: r.submittedAt.toISOString(),
    by: r.updatedBy,
    reason: r.reason,
  };
  // OD20: a reader gets the frozen photo fields only (no coordinates); stored as is.
  return access === 'read'
    ? projected('report.revision.reader', {
        ...head,
        snapshot: readerSnapshot(r.snapshot),
      })
    : projected('report.revision.writer', { ...head, snapshot: r.snapshot });
}

async function plan(
  { client, actor }: Opened,
  projectId: string,
  target: string,
) {
  const { access } = await projectAccess(client, actor, projectId);
  const plan = await planStateOf(client, actor.orgId, projectId, target);
  const previous = await planStateOf(
    client,
    actor.orgId,
    projectId,
    shiftDate(target, -1),
  );
  // OD18: a reader sees confirmed versions only; the draft does not exist for it.
  const shown = (s: PlanState) => (access === 'read' ? readerPlan(s) : s);
  return projected(
    access === 'read' ? 'report.plan.reader' : 'report.plan.writer',
    {
      targetBusinessDate: target,
      status: planStatus(shown(plan.state)),
      rows: planRows(shown(plan.state), shown(previous.state)),
      draft: shown(plan.state).draft,
      versions: plan.versions.map((v) => ({
        n: v.number,
        rows: v.rows,
        at: v.confirmedAt.toISOString(),
        by: v.confirmedBy,
      })),
    },
  );
}

async function items({ client, actor }: Opened, projectId: string) {
  await projectAccess(client, actor, projectId);
  return projected(
    'report.items',
    (await itemRows(client, actor.orgId, projectId)).map(publicItem),
  );
}

/**
 * Submitted history for the progress-lag reminder (rule 10), for the issue module: each
 * submitted day in [from, to] with its current revision's quantities, and the day's baseline
 * (latest confirmed plan version). Submitted content and confirmed plans only, so the same for
 * a writer and a reader: no draft reaches it (OD18).
 */
async function lagHistory(
  { client, actor }: Opened,
  projectId: string,
  from: string,
  to: string,
): Promise<LagDay[]> {
  await projectAccess(client, actor, projectId);
  const days = await client.query<{
    businessDate: string;
    qty: Record<string, Reported> | null;
  }>(
    `SELECT d."businessDate"::text AS "businessDate", r.snapshot->'facts'->'qty' AS qty FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3 AND d.state='SUBMITTED'
      AND d."businessDate" BETWEEN $4::date AND $5::date`,
    [actor.orgId, projectId, REPORT_SCOPE, from, to],
  );
  const plans = await client.query<{
    target: string;
    number: number;
    rows: PlanRowDto[];
    confirmedAt: Date;
  }>(
    `SELECT DISTINCT ON ("targetBusinessDate") "targetBusinessDate"::text AS target, number, rows, "confirmedAt"
    FROM "PlanVersion" WHERE "orgId"=$1 AND "projectId"=$2 AND "targetBusinessDate" BETWEEN $3::date AND $4::date
    ORDER BY "targetBusinessDate", number DESC`,
    [actor.orgId, projectId, from, to],
  );
  const baselines = new Map(
    plans.rows.map((p) => [
      p.target,
      { n: p.number, rows: p.rows, at: p.confirmedAt.toISOString() },
    ]),
  );
  return projected(
    'report.lagHistory',
    days.rows.map((d) => ({
      businessDate: d.businessDate,
      baseline: baselines.get(d.businessDate) ?? null,
      qty: d.qty ?? {},
    })),
  );
}

/**
 * The report module exit. `forContext(ctx)` is every report read route's only way to the data;
 * `lagHistory` is the issue module's (ADR-0003 D8 table, replacing IssueStore.lag's direct read).
 */
export const reportReader = {
  /** Every call re-checks that `ctx` is still live (its transaction has not completed). */
  forContext(ctx: ReportReadContext) {
    const open = () => openReportReadContext(ctx);
    return {
      projects: async () => projects(open()),
      days: async (projectId: string, from: string, to: string) =>
        days(open(), projectId, from, to),
      day: async (projectId: string, businessDate: string) =>
        day(open(), projectId, businessDate),
      revision: async (projectId: string, businessDate: string, n: number) =>
        revision(open(), projectId, businessDate, n),
      plan: async (projectId: string, targetBusinessDate: string) =>
        plan(open(), projectId, targetBusinessDate),
      items: async (projectId: string) => items(open(), projectId),
    };
  },
  /**
   * The issue module's lag history. It is the lag request's one project check (moved here from
   * IssueStore.lag, which no longer checks itself), then the history reads.
   */
  async lagHistory(
    ctx: ReportReadContext,
    projectId: string,
    from: string,
    to: string,
  ) {
    return lagHistory(openReportReadContext(ctx), projectId, from, to);
  },
};
export type ReportReadView = ReturnType<typeof reportReader.forContext>;

/** The DTOs the exit's projectors produce (authz/fields.ts layers each field). */
export type ReportProjectsDto = Awaited<ReturnType<typeof projects>>;
export type ReportDayRowDto = Awaited<ReturnType<typeof days>>[number];
export type ReportDayWriterDto = Awaited<ReturnType<typeof writerDay>>;
export type ReportDayReaderDto = Awaited<ReturnType<typeof readerDay>>;
export type ReportRevisionDto = Awaited<ReturnType<typeof revision>>;
export type ReportPlanDto = Awaited<ReturnType<typeof plan>>;
export type ReportLagDayDto = LagDay;
