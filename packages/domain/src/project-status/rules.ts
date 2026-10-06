import type { StatusFieldName } from '@mje/contracts';
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
export { requiredStatusFields } from '@mje/contracts';
