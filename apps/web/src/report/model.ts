import type {
  DayFactsDto,
  PhotoAsOfDto,
  PhotoDto,
  ReportItemDto,
} from '@mje/contracts';
import {
  coverage,
  dec,
  isReported,
  suggestCumulative,
  type Coverage,
  type PlanVersion,
} from '@mje/domain/rules';
import type { Carried, DayState, ReportContent } from '../api.js';

export const byKind = (items: ReportItemDto[], kind: ReportItemDto['kind']) =>
  items.filter((i) => i.kind === kind && i.active);

/** Work items shown first: planned for the day (target > 0) or already given a quantity. */
export function activeWork(
  content: Pick<ReportContent, 'items' | 'baseline' | 'facts'>,
) {
  const planned = new Set(
    (content.baseline?.rows ?? [])
      .filter((r) => (dec(r.target) ?? 0n) > 0n)
      .map((r) => r.item),
  );
  const work = byKind(content.items, 'work');
  const active = work.filter(
    (i) => planned.has(i.key) || content.facts.qty[i.key],
  );
  return { active, others: work.filter((i) => !active.includes(i)) };
}
export const target = (content: Pick<ReportContent, 'baseline'>, key: string) =>
  content.baseline?.rows.find((r) => r.item === key)?.target;

/** Suggested cumulative = last declared cumulative + today; adopted only by the user. */
export function cumulativeSuggestion(
  base: Carried | undefined,
  qty: string | undefined,
) {
  const s = suggestCumulative(base?.value, qty);
  return s && base ? { ...s, asOf: base.asOf } : null;
}

export type CumulativeCheck =
  | { item: string; kind: 'belowToday' }
  | { item: string; kind: 'notSuggested'; sum: string };
/**
 * Declared cumulatives that disagree with today's quantity. They are reminders, never a block
 * and never a silent change: a cumulative below today's quantity cannot be right; one that
 * differs from "last declared + today" may be deliberate but must be seen (for example after
 * today's quantity was corrected). Unknown or blank values are not compared.
 */
export function cumulativeChecks(
  content: Pick<ReportContent, 'items' | 'facts'>,
  base: Record<string, Carried>,
): CumulativeCheck[] {
  const out: CumulativeCheck[] = [];
  for (const it of byKind(content.items, 'work')) {
    const q = dec(content.facts.qty[it.key]);
    const cur = dec(content.facts.cumulative[it.key]);
    if (q === null || cur === null) continue;
    if (cur < q) {
      out.push({ item: it.key, kind: 'belowToday' });
      continue;
    }
    const s = cumulativeSuggestion(base[it.key], content.facts.qty[it.key]);
    if (s && dec(s.sum) !== cur)
      out.push({ item: it.key, kind: 'notSuggested', sum: s.sum });
  }
  return out;
}

/**
 * Live coverage for the form. "Quantity but no photo" is only a reminder (rule 5); while the
 * day's photos are not loaded it is left out rather than guessed either way.
 */
export function liveCoverage(
  content: Pick<ReportContent, 'items' | 'baseline' | 'facts'>,
  photographed: ReadonlySet<string> | null,
): Coverage {
  const c = coverage({
    facts: content.facts,
    itemIds: byKind(content.items, 'work').map((i) => i.key),
    machineryIds: byKind(content.items, 'machinery').map((i) => i.key),
    materialIds: byKind(content.items, 'material').map((i) => i.key),
    baseline: (content.baseline
      ? { n: content.baseline.n, rows: content.baseline.rows, at: '' }
      : null) as PlanVersion | null,
    photographedItems: new Set(photographed ?? []),
  });
  return photographed
    ? c
    : { ...c, missing: c.missing.filter((m) => m.key !== 'photo') };
}

/** A live photo in the shape a submission freezes (no coordinates). */
export function photoAsOf(p: PhotoDto): PhotoAsOfDto {
  return {
    id: p.id,
    source: p.source,
    location: p.location,
    accuracyM: p.capture?.accuracyM ?? null,
    deviceCapturedAt: p.deviceCapturedAt,
    fileTakenAt: p.file.takenAt,
    fileTakenLocal: p.file.takenLocal,
    link: p.link,
  };
}

/**
 * The photos the report shows under its work items and issues. A submitted day shows what its
 * revision froze, links as they were then (rule 1): a later link change never reaches it.
 * Otherwise the linked photos as they are now.
 */
export function reportPhotos(
  state: DayState,
  read: Pick<ReportContent, 'photos'>,
  live: PhotoDto[] | null,
): PhotoAsOfDto[] {
  if (state === 'submitted') return read.photos ?? [];
  return (live ?? []).filter((p) => p.link !== null).map(photoAsOf);
}

/** A path like "qty.support" or "narrative.quality" set immutably on the facts. */
export function setFact(
  facts: DayFactsDto,
  path: string,
  value: string,
): DayFactsDto {
  const [head, key] = path.split('.') as [
    keyof DayFactsDto,
    string | undefined,
  ];
  if (key === undefined) return { ...facts, [head]: value };
  const group = facts[head] as Record<string, string>;
  return { ...facts, [head]: { ...group, [key]: value } };
}
/** The draft can only be saved when every number is valid; invalid text stays local. */
export function savable(facts: DayFactsDto): boolean {
  const maps = [
    facts.qty,
    facts.cumulative,
    facts.people,
    facts.machinery,
    facts.materials,
  ];
  return maps.every((m) => Object.values(m).every((v) => isReported(v)));
}

/**
 * Where the report shows each photo, so that every photo it was given has a place (a reader
 * has no other way to see a submitted photo): under the work items shown (and, for a work item
 * with photos but no plan or quantity, a row of its own), under open issues and under any other
 * issue that has photos; whatever is left (a no-work day, a target not in this report) goes to
 * a separate photo card.
 */
export function photoPlacement(
  c: Pick<ReportContent, 'items' | 'baseline' | 'facts' | 'issues'>,
  photos: PhotoAsOfDto[],
) {
  const has = (type: 'item' | 'issue', id: string) =>
    photos.some((p) => p.link?.type === type && p.link.id === id);
  const noWork = c.facts.noWork !== null;
  const { active, others } = activeWork(c);
  const photoOnlyItems = noWork ? [] : others.filter((i) => has('item', i.key));
  const issues = c.issues ?? [];
  const otherIssues = issues.filter(
    (i) => i.status !== 'open' && has('issue', i.id),
  );
  const items = new Set(
    noWork ? [] : [...active, ...photoOnlyItems].map((i) => i.key),
  );
  const shownIssues = new Set(
    [...issues.filter((i) => i.status === 'open'), ...otherIssues].map(
      (i) => i.id,
    ),
  );
  const unplaced = photos.filter(
    (p) =>
      !p.link || !(p.link.type === 'item' ? items : shownIssues).has(p.link.id),
  );
  return { photoOnlyItems, otherIssues, unplaced };
}
