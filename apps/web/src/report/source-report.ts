import { dec, decText, pct, ROLE_KEYS, type RoleKey } from '@mje/domain/rules';

/** Presentation input only. The caller resolves citations from the selected report version.
 * This is not an HTTP DTO/parser and does not authorize or verify a source document. */
export interface ReportedCellDisplay {
  readonly raw: string;
  readonly state: 'value' | 'blank' | 'unknown' | 'na';
  readonly citation: {
    readonly label: string;
    readonly sha256: string;
    readonly table: number;
    readonly row: number;
    readonly cell: number;
    readonly gridSpan?: number;
    readonly verticalMerge?: 'restart' | 'continue';
  } | null;
}
export interface MaterialSourceDisplay {
  readonly cumulative?: ReportedCellDisplay;
  readonly percent?: ReportedCellDisplay;
  readonly note?: ReportedCellDisplay;
  readonly unit?: ReportedCellDisplay;
}
export interface MilestoneSourceDisplay {
  readonly plannedFinish?: ReportedCellDisplay;
  readonly actualFinish?: ReportedCellDisplay;
  readonly reportedDelayDays?: ReportedCellDisplay;
  readonly note?: ReportedCellDisplay;
}
export interface SourceReportDisplayInput {
  /** Absent in an older version is different from a recorded blank cell. */
  readonly source?: {
    readonly milestones?: Readonly<Record<string, MilestoneSourceDisplay>>;
    readonly peopleTotal?: ReportedCellDisplay;
    readonly workPercent: Readonly<Record<string, ReportedCellDisplay>>;
    readonly materials: Readonly<Record<string, MaterialSourceDisplay>>;
    readonly reportedNextPlan?: {
      readonly targetBusinessDate: string;
      readonly quantities: Readonly<Record<string, ReportedCellDisplay>>;
    };
  };
  readonly milestones?: readonly {
    readonly key: string;
    readonly label: string;
  }[];
  readonly people: Readonly<Partial<Record<RoleKey, string>>>;
  /** Quantities, labels and units must come from the same selected version as source. */
  readonly work: readonly {
    readonly key: string;
    readonly label: string;
    readonly unit?: string;
    readonly cumulative: string | undefined;
    readonly design: string | undefined;
  }[];
  readonly materials: readonly {
    readonly key: string;
    readonly label: string;
    readonly unit: string;
    readonly today: string | undefined;
    readonly cumulative: {
      readonly value: string | null;
      readonly complete: boolean;
    };
  }[];
}
export type Comparison =
  | { readonly state: 'equal' | 'different'; readonly difference: string }
  | {
      readonly state:
        'unavailable' | 'partial' | 'unitMismatch' | 'unitUnavailable';
    };

/** Gate dec's comma normalization: source notation must be unambiguous to compare.
 * Trimming here never changes the displayed/stored source string. */
function number(raw: string | undefined, percent = false): bigint | null {
  if (raw === undefined) return null;
  let text = raw.trim();
  if (percent && text.endsWith('%')) text = text.slice(0, -1).trim();
  return /^\d{1,14}(\.\d{1,6})?$/.test(text) ? dec(text) : null;
}
function original(cell: ReportedCellDisplay | undefined, percent = false) {
  return cell?.state === 'value' ? number(cell.raw, percent) : null;
}
function compare(
  reported: bigint | null,
  calculated: bigint | null,
): Comparison {
  if (reported === null || calculated === null) return { state: 'unavailable' };
  const delta = calculated - reported;
  return {
    state: delta === 0n ? 'equal' : 'different',
    difference: `${delta > 0n ? '+' : ''}${decText(delta)}`,
  };
}
function headcount(raw: string | undefined) {
  return raw !== undefined && /^\d{1,14}$/.test(raw.trim())
    ? number(raw)
    : null;
}
function peopleSum(people: SourceReportDisplayInput['people']) {
  const values = ROLE_KEYS.map((key) => headcount(people[key]));
  const known = values.filter((value): value is bigint => value !== null);
  return {
    complete: known.length === ROLE_KEYS.length,
    value: known.length ? known.reduce((sum, value) => sum + value, 0n) : null,
  };
}

/** Pure read model: source values never feed operational totals, forecasts or approvals. */
export function sourceReportModel(input: SourceReportDisplayInput) {
  const source = input.source;
  const sum = peopleSum(input.people);
  const peopleOriginal = source?.peopleTotal;
  return {
    recorded: source !== undefined,
    milestones: source?.milestones
      ? Object.entries(source.milestones)
          .sort(([a], [b]) => {
            const rows = input.milestones ?? [];
            const index = (key: string) => {
              const found = rows.findIndex((row) => row.key === key);
              return found < 0 ? rows.length : found;
            };
            return index(a) - index(b);
          })
          .map(([key, original]) => ({
            key,
            label:
              input.milestones?.find((row) => row.key === key)?.label ?? key,
            original,
          }))
      : null,
    nextPlan: source?.reportedNextPlan
      ? {
          targetBusinessDate: source.reportedNextPlan.targetBusinessDate,
          rows: Object.entries(source.reportedNextPlan.quantities)
            .sort(([a], [b]) => {
              const index = (key: string) => {
                const found = input.work.findIndex((row) => row.key === key);
                return found < 0 ? input.work.length : found;
              };
              return index(a) - index(b);
            })
            .map(([key, quantity]) => {
              const item = input.work.find((row) => row.key === key);
              return {
                key,
                label: item?.label ?? key,
                unit: item?.unit,
                original: quantity,
              };
            }),
        }
      : null,
    people: {
      original: peopleOriginal,
      calculated: sum.value === null ? null : decText(sum.value),
      complete: sum.complete,
      comparison: !sum.complete
        ? ({ state: 'partial' } as const)
        : compare(
            peopleOriginal?.state === 'value'
              ? headcount(peopleOriginal.raw)
              : null,
            sum.value,
          ),
    },
    work: Object.entries(source?.workPercent ?? {}).map(([key, reported]) => {
      const item = input.work.find((row) => row.key === key);
      const calculated = pct(number(item?.cumulative), number(item?.design));
      return {
        key,
        label: item?.label ?? key,
        original: reported,
        calculated,
        comparison: compare(
          original(reported, true),
          number(calculated ?? undefined),
        ),
      };
    }),
    materials: Object.entries(source?.materials ?? {}).map(
      ([key, reported]) => {
        const item = input.materials.find((row) => row.key === key);
        const calculated = item?.cumulative.value ?? null;
        let comparison: Comparison;
        if (!reported.unit || reported.unit.state !== 'value' || !item?.unit) {
          comparison = { state: 'unitUnavailable' };
        } else if (reported.unit.raw !== item.unit) {
          comparison = { state: 'unitMismatch' };
        } else if (!item.cumulative.complete) {
          comparison = { state: 'partial' };
        } else {
          comparison = compare(
            original(reported.cumulative),
            number(calculated ?? undefined),
          );
        }
        return {
          key,
          label: item?.label ?? key,
          today: item?.today,
          unit: item?.unit,
          original: reported,
          calculated,
          complete: item?.cumulative.complete ?? false,
          comparison,
        };
      },
    ),
  };
}
export type SourceReportDisplayModel = ReturnType<typeof sourceReportModel>;
