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
    introducedBy: 'DG05-1a (contract direction implemented)',
    note: 'Legacy entries declare direction n/a; contract.direction is enforced by the contract reader and tested in its real database suite, not counted by the legacy TEST interpreter',
  },
  {
    dimension: 'contract share',
    notApplicableIn: ['report', 'issue', 'photo', 'field', 'project-status'],
    introducedBy: 'DG05-1b (version-pinned project shares)',
    note: 'DG05-1b implements version-pinned shares and current-project projection in the real contract HTTP/database suite. The legacy interpreter has no contract-share objects and does not count these dimensions',
  },
];
