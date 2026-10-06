/** Additive service boundary; the shared export/HTTP mount is held by the integrator. */
import { date, id, itemKey } from './parse.js';
import { reportObject } from './report-source.js';
import type {
  CompletionEvidenceDto,
  CompletionReviewDecisionDto,
  CompletionReviewEventDto,
  CompletionReviewStateDto,
  CompletionReviewTargetDto,
} from './manager-review.js';
export type ManagerReviewScopeDto = Omit<
  CompletionReviewTargetDto,
  'foremanRevisionId'
>;
export interface ManagerReviewReadDto {
  actorScopeKey: string;
  target: CompletionReviewTargetDto;
  revisionNumber: number;
  reviewVersion: number;
  declaredQty: string;
  labels: { crew: string; item: string; scope: string | null };
  unit: string | null;
  scopeRef: string | null;
  capability: {
    basisRef: string | null;
    actions: readonly CompletionReviewDecisionDto[];
  };
  evidence: CompletionEvidenceDto | null;
  state: CompletionReviewStateDto;
  judgment: CompletionReviewEventDto | null;
}
export interface ManagerReviewWriteResultDto {
  eventId: string;
  reviewVersion: number;
}
export function parseManagerReviewScope(v: unknown): ManagerReviewScopeDto {
  const o = reportObject(
    v,
    ['projectId', 'businessDate', 'crewId', 'itemKey'],
    'scope',
  );
  return {
    projectId: id(o['projectId'], 'scope.projectId'),
    businessDate: date(o['businessDate'], 'scope.businessDate'),
    crewId: id(o['crewId'], 'scope.crewId'),
    itemKey: itemKey(o['itemKey'], 'scope.itemKey'),
  };
}
