/**
 * What a read-only account (EXECUTIVE_READER) may see of a report day (OD18): only content
 * frozen in a submitted revision. A day still being written, a correction in progress, a plan
 * draft and photos not frozen in a submitted revision are never served to a reader; the web
 * shows "not submitted yet" instead. A reader also never gets a photo's exact coordinates
 * (OD20): only whether it has a position and its claimed accuracy. Writers (PROJECT_MANAGER)
 * are not affected. Pure mapping only; the stores read the rows and apply these.
 */
import type {
  PhotoAsOfDto,
  PhotoDto,
  PlanRowDto,
  ReportItemDto,
} from '@mje/contracts';
import {
  blankFacts,
  type CarriedCumulative,
  type Coverage,
  type DayFacts,
  type MaterialCumulative,
  type PlanState,
  type PlanStatus,
} from './report-rules.js';
import type { IssueAsOf } from './issue-store.js';
import type { DayState } from './report-store.js';

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
 * OD20: a read-only account sees whether a photo has a position (`location`: device fix, file
 * GPS or none) and the accuracy the device claimed, never where. The capture fix keeps its
 * accuracy and time with lat/lon null, the file GPS is null, and `coordinates` says they are
 * withheld (so a null is not read as "no position"). Every photo a reader is served passes here.
 */
export function withheldCoordinates(p: PhotoDto): PhotoDto {
  return {
    ...p,
    capture: p.capture ? { ...p.capture, lat: null, lon: null } : null,
    file: { ...p.file, gps: null },
    coordinates: 'withheld',
  };
}

/**
 * A frozen photo as a reader sees it: the stored photo with the link it had in the revision
 * (a later relink is not shown), no link version (readers never change links) and no
 * coordinates (OD20). In the revision's order; a frozen id without a row is left out.
 */
export function frozenPhotoViews(
  frozen: PhotoAsOfDto[],
  rows: PhotoDto[],
): PhotoDto[] {
  const byId = new Map(rows.map((p) => [p.id, p]));
  return frozen.flatMap((f) => {
    const photo = byId.get(f.id);
    return photo
      ? [withheldCoordinates({ ...photo, link: f.link, linkVersion: 0 })]
      : [];
  });
}

/** Exactly the fields a submission freezes of a photo (photoAsOf); nothing else is passed on. */
function frozenPhotoFields(p: PhotoAsOfDto): PhotoAsOfDto {
  return {
    id: p.id,
    source: p.source,
    location: p.location,
    accuracyM: p.accuracyM,
    deviceCapturedAt: p.deviceCapturedAt,
    fileTakenAt: p.fileTakenAt,
    fileTakenLocal: p.fileTakenLocal,
    link: p.link,
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
  // Foreman reports and adoptions are writer data (A6.0): a reader never gets them, frozen or live.
  let rest = snapshot;
  if ('foreman' in snapshot) {
    rest = { ...snapshot };
    delete rest['foreman'];
  }
  const photos = rest['photos'];
  if (!Array.isArray(photos)) return rest;
  return {
    ...rest,
    photos: (photos as PhotoAsOfDto[]).map(frozenPhotoFields),
  };
}
