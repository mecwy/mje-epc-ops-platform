import type { CrewItemStatusDto, ForemanTotalStatusDto } from '@mje/contracts';
import type { ForemanDayView } from '../api.js';

export interface ForemanItemView {
  status: ForemanTotalStatusDto;
  value: string | null;
  atLeast: string | null;
  crews: {
    crewId: string;
    name: string;
    hasForeman: boolean;
    status: CrewItemStatusDto;
    qty: string | null;
  }[];
  /** The latest adoption of this item, if any. */
  adopted: { value: string; at: string; afterSubmission: boolean } | null;
}

/**
 * The foreman claims for one work item beside the PM's figure (design §4, C35, C37): the
 * total's completeness and each expected crew's status, in the crew order of the day.
 */
export function itemView(
  f: ForemanDayView,
  itemKey: string,
): ForemanItemView | null {
  const it = f.items[itemKey];
  if (!it) return null;
  const last = [...f.adoptions]
    .filter((a) => a.itemKey === itemKey)
    .sort((a, b) => b.daySeq - a.daySeq)[0];
  return {
    status: it.status,
    value: it.value,
    atLeast: it.atLeast,
    crews: f.expectedCrews.map((c) => ({
      crewId: c.crewId,
      name: c.name,
      hasForeman: c.hasForeman,
      status: it.crews[c.crewId]?.status ?? 'MISSING_REPORT',
      qty: it.crews[c.crewId]?.qty ?? null,
    })),
    adopted: last
      ? {
          value: last.value,
          at: last.at,
          afterSubmission:
            (last as { afterSubmission?: boolean }).afterSubmission ?? false,
        }
      : null,
  };
}
