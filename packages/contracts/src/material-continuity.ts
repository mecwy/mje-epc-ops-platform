import {
  obj,
  id,
  date,
  version,
  str,
  itemKey,
  InvalidReportInput,
} from './parse.js';

/** Quantity admission is a business record, not verification or financial posting. */
export interface MaterialScopeDto {
  id: string;
  projectId: string;
  version: number;
  materialItemId: string;
  materialKey: string;
  specification: string;
  unit: string;
  workPackageId: string;
  scopeVersion: string;
  ownership: string;
  custody: string;
  location: string;
  openingDate: string;
  openingCutoffAt: string;
  openingQuantity: string | null;
  openingBasis: string;
}
export interface MaterialProjectionDto {
  ledgerVersion: number;
  scopeId: string;
  businessDate: string;
  opening: string | null;
  admittedUseToday: string;
  admittedUseCumulative: string;
  balance: string | null;
  complete: boolean;
  pendingCount: number;
  independentVerification: false;
}
export interface MaterialSourceDto {
  sourceBusinessDate: string;
  revisionNumber: number;
  useFactId: string;
  outputFactId: string;
  workItemKey: string;
  quantity: string | null;
  outputQuantity: string | null;
  expectedConsumption: string | null;
  difference: string | null;
  note: string;
  state:
    | 'pending'
    | 'ready'
    | 'included'
    | 'correctionPending'
    | 'followupPending'
    | 'reversalPending';
  followupRequired: boolean;
  admittedQuantity: string | null;
  issueId: string | null;
  dueAt: string | null;
}
export interface MaterialFollowupDto {
  issueId: string;
  useFactId: string;
  title: string;
  ownerPersonId: string | null;
  ownerLabel: string | null;
  dueOn: string | null;
  dueAt: string | null;
  state: string;
}
export interface MaterialContinuityView {
  projectId: string;
  businessDate: string;
  access: 'read' | 'write';
  scopes: {
    scope: MaterialScopeDto;
    current: MaterialProjectionDto;
    sources: MaterialSourceDto[];
    followups: MaterialFollowupDto[];
    history: {
      ledgerVersion: number;
      recordedAt: string;
      balance: string | null;
    }[];
  }[];
  /** Null means the historical revision did not record a quantity ledger. */
  frozen: MaterialProjectionDto[] | null;
}
export interface InitializeMaterialScopeCommand {
  projectId: string;
  clientMutationId: string;
  materialItemId: string;
  materialKey: string;
  specification: string;
  unit: string;
  workPackageId: string;
  scopeVersion: string;
  ownership: string;
  custody: string;
  location: string;
  openingDate: string;
  openingCutoffAt: string;
  openingQuantity: string | null;
  openingBasis: string;
}
export interface AdmitMaterialUseCommand {
  projectId: string;
  businessDate: string;
  clientMutationId: string;
  scopeId: string;
  expectedVersion: number;
  records: {
    sourceBusinessDate: string;
    revisionNumber: number;
    useFactId: string;
    issueId: string | null;
    dueAt: string | null;
  }[];
}
function exact(v: unknown, keys: string[]) {
  const value = obj(v, 'material');
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new InvalidReportInput('material.fields');
  return value;
}
function text(v: unknown, field: string) {
  const s = str(v, field, 240).trim();
  if (!s) throw new InvalidReportInput(field);
  return s;
}
function instant(v: unknown, field: string) {
  const s = str(v, field, 40);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(
      s,
    ) ||
    !Number.isFinite(Date.parse(s))
  )
    throw new InvalidReportInput(field);
  return new Date(s).toISOString();
}
export function parseInitializeMaterialScope(
  v: unknown,
): InitializeMaterialScopeCommand {
  const o = exact(v, [
    'projectId',
    'clientMutationId',
    'materialItemId',
    'materialKey',
    'specification',
    'unit',
    'workPackageId',
    'scopeVersion',
    'ownership',
    'custody',
    'location',
    'openingDate',
    'openingCutoffAt',
    'openingQuantity',
    'openingBasis',
  ]);
  const quantity =
    o['openingQuantity'] === null
      ? null
      : str(o['openingQuantity'], 'material.openingQuantity', 21);
  if (quantity !== null && !/^\d{1,14}(?:\.\d{1,6})?$/.test(quantity))
    throw new InvalidReportInput('material.openingQuantity');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    materialItemId: id(o['materialItemId'], 'materialItemId'),
    materialKey: itemKey(o['materialKey'], 'materialKey'),
    specification: text(o['specification'], 'specification'),
    unit: text(o['unit'], 'unit'),
    workPackageId: text(o['workPackageId'], 'workPackageId'),
    scopeVersion: text(o['scopeVersion'], 'scopeVersion'),
    ownership: text(o['ownership'], 'ownership'),
    custody: text(o['custody'], 'custody'),
    location: text(o['location'], 'location'),
    openingDate: date(o['openingDate'], 'openingDate'),
    openingCutoffAt: instant(o['openingCutoffAt'], 'openingCutoffAt'),
    openingQuantity: quantity,
    openingBasis:
      quantity === null
        ? str(o['openingBasis'], 'openingBasis', 1000)
        : text(o['openingBasis'], 'openingBasis'),
  };
}
export function parseAdmitMaterialUse(v: unknown): AdmitMaterialUseCommand {
  const o = exact(v, [
    'projectId',
    'businessDate',
    'clientMutationId',
    'scopeId',
    'expectedVersion',
    'records',
  ]);
  if (
    !Array.isArray(o['records']) ||
    o['records'].length === 0 ||
    o['records'].length > 100
  )
    throw new InvalidReportInput('material.records');
  const records = o['records'].map((r) => {
    const x = exact(r, [
      'sourceBusinessDate',
      'revisionNumber',
      'useFactId',
      'issueId',
      'dueAt',
    ]);
    const n = version(x['revisionNumber'], 'revisionNumber');
    if (n === 0) throw new InvalidReportInput('revisionNumber');
    return {
      sourceBusinessDate: date(x['sourceBusinessDate'], 'sourceBusinessDate'),
      revisionNumber: n,
      useFactId: id(x['useFactId'], 'useFactId'),
      issueId: x['issueId'] === null ? null : id(x['issueId'], 'issueId'),
      dueAt: x['dueAt'] === null ? null : instant(x['dueAt'], 'dueAt'),
    };
  });
  if (new Set(records.map((r) => r.useFactId)).size !== records.length)
    throw new InvalidReportInput('material.records.identity');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    scopeId: id(o['scopeId'], 'scopeId'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    records,
  };
}
