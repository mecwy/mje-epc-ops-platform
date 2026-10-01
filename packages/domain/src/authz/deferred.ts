/**
 * ADR-0003 D6: dimensions the rule model does not expand yet, with the slice that introduces
 * them. Listed apart from `unmodelled` gaps: these are decided and scheduled, not forgotten.
 */
export interface DeferredDimension {
  dimension: string;
  /** Modules whose entries declare it as not applicable meanwhile. */
  notApplicableIn: string[];
  introducedBy: string;
  note: string;
}

export const DEFERRED: readonly DeferredDimension[] = [
  {
    dimension: 'direction (revenue / cost / all)',
    notApplicableIn: ['report', 'issue', 'photo', 'field', 'project-status'],
    introducedBy: 'DG-05 first PR',
    note: 'every surface entry declares direction n/a; the generator does not expand it and does not count it as passed',
  },
  {
    dimension: 'contract share',
    notApplicableIn: ['report', 'issue', 'photo', 'field', 'project-status'],
    introducedBy: 'DG-05 first PR',
    note: 'explicit grant table with share, clause and amount policy arrives with the contract module',
  },
];
