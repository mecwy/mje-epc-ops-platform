import {
  InvalidReportInput,
  id,
  itemKey,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';
import { isRealTimestamp } from './report.js';

export interface ActivityEstimate {
  quantity: string;
  ruleId: string;
  ruleVersion: string;
  mappingVersion: string;
  scopeRef: string;
  outputFactId: string;
  outputQuantity: string;
  workItemKey: string;
  materialKey: string;
  specification: string;
  outputUnit: string;
  materialUnit: string;
  /** First slice supports an explicitly selected 1:1 mapping only. */
  ratio: '1';
}
export interface ActivityUse {
  id: string;
  materialKey: string | null;
  materialItemId: string | null;
  specification: string;
  unit: string;
  estimate: ActivityEstimate | null;
  actualQuantity: string;
  state: 'calculated' | 'edited' | 'pending' | 'declared';
  origin: 'calculated' | 'manual';
  differenceNote: string;
  reviewRequired: boolean;
  confirmation: { accountId: string; personId: string; at: string } | null;
}
export interface ReportActivity {
  operationId: string;
  outputFactId: string;
  workPackageId: string;
  scopeVersion: string;
  area: string;
  process: string;
  completion: string;
  workItemKey: string;
  workItemId: string;
  outputUnit: string;
  quantity: string;
  /** Process quantities remain visible but are not summed into installation output. */
  outputKind: 'installation' | 'process' | 'activity';
  use: ActivityUse | null;
}
export interface ActivityUseConfirmation {
  draftVersion: number;
  includedUseFactIds: string[];
}
/** Controlled project configuration, never inferred from an item name. */
export interface ActivityMaterialMapping {
  orgId: string;
  projectId: string;
  workItemId: string;
  materialItemId: string;
  validFrom: string;
  basisRef: string;
  workPackageId: string;
  scopeVersion: string;
  area: string;
  workItemKey: string;
  materialKey: string;
  specification: string;
  outputUnit: string;
  materialUnit: string;
  ruleId: string;
  ruleVersion: string;
  mappingVersion: string;
  ratio: '1';
}

const quantity = (v: unknown, field: string): string => {
  const s = str(v, field, 22);
  if (s !== '' && !/^\d{1,14}(\.\d{1,6})?$/.test(s))
    throw new InvalidReportInput(field);
  return s;
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== 'boolean') throw new InvalidReportInput(field);
  return v;
};
function object(v: unknown, keys: readonly string[], field: string) {
  const o = obj(v, field);
  if (Object.keys(o).some((k) => !keys.includes(k)))
    throw new InvalidReportInput(`${field}.extra`);
  return o;
}
function estimate(v: unknown, field: string): ActivityEstimate | null {
  if (v === null) return null;
  const o = object(
    v,
    [
      'quantity',
      'ruleId',
      'ruleVersion',
      'mappingVersion',
      'scopeRef',
      'outputFactId',
      'outputQuantity',
      'workItemKey',
      'materialKey',
      'specification',
      'outputUnit',
      'materialUnit',
      'ratio',
    ],
    field,
  );
  return {
    quantity: quantity(o['quantity'], field),
    ruleId: str(o['ruleId'], field, 100),
    ruleVersion: str(o['ruleVersion'], field, 100),
    mappingVersion: str(o['mappingVersion'], field, 100),
    scopeRef: str(o['scopeRef'], field, 200),
    outputFactId: id(o['outputFactId'], field),
    outputQuantity: quantity(o['outputQuantity'], field),
    workItemKey: itemKey(o['workItemKey'], field),
    materialKey: itemKey(o['materialKey'], field),
    specification: str(o['specification'], field, 200),
    outputUnit: str(o['outputUnit'], field, 40),
    materialUnit: str(o['materialUnit'], field, 40),
    ratio: oneOf(o['ratio'], ['1'] as const, field),
  };
}
function use(v: unknown, field: string): ActivityUse | null {
  if (v === null) return null;
  const o = object(
    v,
    [
      'id',
      'materialKey',
      'materialItemId',
      'specification',
      'unit',
      'estimate',
      'actualQuantity',
      'state',
      'origin',
      'differenceNote',
      'reviewRequired',
      'confirmation',
    ],
    field,
  );
  let confirmation: ActivityUse['confirmation'] = null;
  if (o['confirmation'] !== null) {
    const c = object(o['confirmation'], ['accountId', 'personId', 'at'], field);
    const at = str(c['at'], field, 40);
    if (!isRealTimestamp(at)) throw new InvalidReportInput(field);
    confirmation = {
      accountId: id(c['accountId'], field),
      personId: id(c['personId'], field),
      at,
    };
  }
  return {
    id: id(o['id'], field),
    materialKey:
      o['materialKey'] === null ? null : itemKey(o['materialKey'], field),
    materialItemId:
      o['materialItemId'] === null ? null : id(o['materialItemId'], field),
    specification: str(o['specification'], field, 200),
    unit: str(o['unit'], field, 40),
    estimate: estimate(o['estimate'], field),
    actualQuantity: quantity(o['actualQuantity'], field),
    state: oneOf(
      o['state'],
      ['calculated', 'edited', 'pending', 'declared'] as const,
      field,
    ),
    origin: oneOf(o['origin'], ['calculated', 'manual'] as const, field),
    differenceNote: str(o['differenceNote'], field, 500),
    reviewRequired: bool(o['reviewRequired'], field),
    confirmation,
  };
}
export function parseReportActivities(v: unknown): ReportActivity[] {
  if (!Array.isArray(v) || v.length > 100)
    throw new InvalidReportInput('facts.activities');
  const ids = new Set<string>();
  return v.map((row: unknown, i) => {
    const field = `facts.activities[${i}]`;
    const o = object(
      row,
      [
        'operationId',
        'outputFactId',
        'workPackageId',
        'scopeVersion',
        'area',
        'process',
        'completion',
        'workItemKey',
        'workItemId',
        'outputUnit',
        'quantity',
        'outputKind',
        'use',
      ],
      field,
    );
    const a: ReportActivity = {
      operationId: id(o['operationId'], field),
      outputFactId: id(o['outputFactId'], field),
      workPackageId: str(o['workPackageId'], field, 100),
      scopeVersion: str(o['scopeVersion'], field, 100),
      area: str(o['area'], field, 500),
      process: str(o['process'], field, 500),
      completion: str(o['completion'], field, 500),
      workItemKey: itemKey(o['workItemKey'], field),
      workItemId:
        o['workItemId'] === '' || o['workItemId'] === undefined
          ? ''
          : id(o['workItemId'], field),
      outputUnit: str(o['outputUnit'], field, 40),
      quantity: quantity(o['quantity'], field),
      outputKind: oneOf(
        o['outputKind'],
        ['installation', 'process', 'activity'] as const,
        field,
      ),
      use: use(o['use'], field),
    };
    for (const value of [
      a.operationId,
      a.outputFactId,
      ...(a.use ? [a.use.id] : []),
    ]) {
      if (ids.has(value)) throw new InvalidReportInput(field);
      ids.add(value);
    }
    return a;
  });
}
export function parseActivityUseConfirmation(
  v: unknown,
): ActivityUseConfirmation {
  const o = object(
    v,
    ['draftVersion', 'includedUseFactIds'],
    'activityUseConfirmation',
  );
  const input = o['includedUseFactIds'];
  if (!Array.isArray(input) || input.length > 100)
    throw new InvalidReportInput('activityUseConfirmation');
  const includedUseFactIds = input.map((v: unknown) =>
    id(v, 'activityUseConfirmation'),
  );
  if (new Set(includedUseFactIds).size !== includedUseFactIds.length)
    throw new InvalidReportInput('activityUseConfirmation');
  return {
    draftVersion: version(o['draftVersion'], 'activityUseConfirmation'),
    includedUseFactIds,
  };
}
