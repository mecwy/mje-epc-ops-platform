import type { DeclareStatusCommand, StatusFieldName } from '@mje/contracts';
export class ProjectStatusError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'READ_ONLY'
      | 'VERSION_CONFLICT'
      | 'STATUS_FIELDS_REQUIRED'
      | 'ITEM_NOT_FOUND',
    public readonly fields: readonly StatusFieldName[] = [],
  ) {
    super(code);
  }
}
/** Fixed field names only. Original text is retained, never included in a refusal. */
export function requiredStatusFields(
  c: DeclareStatusCommand,
): StatusFieldName[] {
  const f = new Set<StatusFieldName>();
  if (c.status === 'AT_RISK' || c.status === 'OFF_TRACK') {
    if (c.areas.length === 0) f.add('areas');
    if (!c.situation.trim()) f.add('situation');
    if (!c.recovery.trim()) f.add('recovery');
  }
  if (c.status === 'PAUSED' && !c.situation.trim()) f.add('situation');
  if (
    c.status !== 'NORMAL' &&
    (c.expectedRecoveryDate === null) !== c.expectedRecoveryUnknown
  ) {
    f.add('expectedRecoveryDate');
    f.add('expectedRecoveryUnknown');
  }
  if (c.status === 'NORMAL') {
    if (c.areas.length) f.add('areas');
    if (c.expectedRecoveryDate !== null) f.add('expectedRecoveryDate');
    if (c.expectedRecoveryUnknown) f.add('expectedRecoveryUnknown');
    if (c.needsSupport) f.add('needsSupport');
  }
  if (!c.needsSupport && c.supportNote !== '') f.add('supportNote');
  return [...f];
}
