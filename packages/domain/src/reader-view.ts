/**
 * What a read-only account (EXECUTIVE_READER) may see of a report day (OD18): only content
 * frozen in a submitted revision. A day still being written, a correction in progress, a plan
 * draft and photos not frozen in a submitted revision are never served to a reader; the web
 * shows "not submitted yet" instead. Writers (PROJECT_MANAGER) are not affected.
 * Pure mapping only; the stores read the rows and apply these.
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

/** A draft is not a report yet (shown as empty); a correction in progress shows the last submission. */
export function readerDayState(state: DayState): 'empty' | 'submitted' {
  return state === 'submitted' || state === 'correcting'
    ? 'submitted'
    : 'empty';
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
 * A frozen photo as a reader sees it: the stored photo with the link it had in the revision
 * (a later relink is not shown) and no link version (readers never change links). In the
 * revision's order; a frozen id without a row is left out.
 */
export function frozenPhotoViews(
  frozen: PhotoAsOfDto[],
  rows: PhotoDto[],
): PhotoDto[] {
  const byId = new Map(rows.map((p) => [p.id, p]));
  return frozen.flatMap((f) => {
    const photo = byId.get(f.id);
    return photo ? [{ ...photo, link: f.link, linkVersion: 0 }] : [];
  });
}
