import {
  InvalidReportInput,
  obj,
  str,
  id,
  oneOf,
  version,
  date,
} from './parse.js';
import type {
  ContractDirection,
  ContractValueState,
} from './contract-register.js';
export const CONTRACT_STATES = [
  'VALUE',
  'BLANK',
  'UNKNOWN',
  'NA',
  'NOT_STATED',
] as const;
export const CONTRACT_UNITS = ['pcs', 'set', 'm', 'day', 'kWp'] as const;
export const CONTRACT_PRICING = [
  'LUMP_SUM',
  'UNIT_PRICE',
  'TIME_AND_MATERIAL',
  'REIMBURSABLE',
  'UNKNOWN',
] as const;
export interface ContractValue {
  state: ContractValueState;
  value: string | null;
}
export interface ContractDate {
  state: 'VALUE' | 'UNKNOWN' | 'NOT_STATED';
  value: string | null;
}
export interface ContractLocation {
  sourceDocumentId: string;
  location: string;
}
export interface ContractLineInput {
  id: string;
  lineNo: string;
  description: string;
  quantity: ContractValue;
  unitRaw: string;
  unit: (typeof CONTRACT_UNITS)[number] | null;
  pricingType: (typeof CONTRACT_PRICING)[number];
  amount: ContractValue;
  includes: string;
  excludes: string;
  derivation: string;
  source: ContractLocation | null;
  removed: boolean;
  removalSource: ContractLocation | null;
}
export interface ContractRevisionInput {
  name: string;
  originalNumber: string | null;
  counterpartyRaw: string | null;
  selfPartyRaw: string | null;
  counterpartyCompanyId: string | null;
  selfCompanyId: string | null;
  informationOwnerPersonId: string | null;
  signedOn: ContractDate;
  effectiveOn: ContractDate;
  registrationStatus: 'SIGNED_PENDING' | 'EFFECTIVE';
  total: ContractValue;
  currency: string | null;
  taxBasis: 'INCLUSIVE' | 'EXCLUSIVE' | 'UNKNOWN';
  sources: ContractLocation[];
  headLocs: {
    parties: ContractLocation | null;
    dates: ContractLocation | null;
    total: ContractLocation | null;
  };
  lines: ContractLineInput[];
}
export interface CreateContractCommand {
  contractId: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
  expectedVersion: 0;
  clientMutationId: string;
  revision: ContractRevisionInput;
}
export interface CorrectContractCommand {
  contractId: string;
  expectedVersion: number;
  clientMutationId: string;
  reason: string;
  revision: ContractRevisionInput;
}
export interface ContractShareInput {
  scopeId: string;
  projectId: string;
  expectedVersion: number;
  basis: 'WHOLE' | 'QUANTITY' | 'AREA' | 'NOTE';
  quantity: string | null;
  area: string;
  note: string;
  retired: boolean;
  reason: string;
}
export interface SetContractSharesCommand {
  contractId: string;
  lineId: string;
  expectedVersion: number;
  clientMutationId: string;
  shares: ContractShareInput[];
}
export interface ReadContractAttentionCommand {
  contractId: string;
  attentionId: string;
  clientMutationId: string;
}
export interface ContractCommandResultDto {
  contractId: string;
  version: number;
}
export interface ContractEditorDto {
  id: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
  version: number;
  revision: ContractRevisionInput;
}
export interface ContractEditorLookupsDto {
  accountId: string;
  directions: ContractDirection[];
  maintainedProjects: { direction: ContractDirection; projectIds: string[] }[];
  projects: { id: string; code: string; name: string }[];
  people: { id: string; displayName: string }[];
  companies: { id: string; name: string }[];
  sources: { id: string; filename: string; sha256: string }[];
}
function keys(o: Record<string, unknown>, fields: string[]) {
  if (
    Object.keys(o).some((k) => !fields.includes(k)) ||
    fields.some((k) => !Object.hasOwn(o, k))
  )
    throw new InvalidReportInput('unexpected or missing field');
}
function text(v: unknown, f: string, max = 4000) {
  const s = str(v, f, max);
  if (!s.trim()) throw new InvalidReportInput(f);
  return s;
}
function nullableText(v: unknown, f: string, max = 4000) {
  return v === null ? null : str(v, f, max);
}
function nullableId(v: unknown, f: string) {
  return v === null ? null : id(v, f);
}
function bool(v: unknown, f: string) {
  if (typeof v !== 'boolean') throw new InvalidReportInput(f);
  return v;
}
function list(v: unknown, f: string, max = 200): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new InvalidReportInput(f);
  return v as unknown[];
}
function decimal(v: unknown, scale: 4 | 6, negative: boolean, f: string) {
  const s = str(v, f, 32);
  const re = new RegExp(
    `^${negative ? '-?' : ''}(?:0|[1-9]\\d{0,${19 - scale}})(?:\\.\\d{1,${scale}})?$`,
  );
  if (!re.test(s)) throw new InvalidReportInput(f);
  return s;
}
function value(
  v: unknown,
  scale: 4 | 6,
  negative: boolean,
  f: string,
): ContractValue {
  const o = obj(v, f);
  keys(o, ['state', 'value']);
  const state = oneOf(o['state'], CONTRACT_STATES, f);
  if (state !== 'VALUE' && o['value'] !== null) throw new InvalidReportInput(f);
  return {
    state,
    value: state === 'VALUE' ? decimal(o['value'], scale, negative, f) : null,
  };
}
function dateValue(v: unknown, f: string): ContractDate {
  const o = obj(v, f);
  keys(o, ['state', 'value']);
  const state = oneOf(
    o['state'],
    ['VALUE', 'UNKNOWN', 'NOT_STATED'] as const,
    f,
  );
  if (state !== 'VALUE' && o['value'] !== null) throw new InvalidReportInput(f);
  return { state, value: state === 'VALUE' ? date(o['value'], f) : null };
}
function location(v: unknown, f: string): ContractLocation | null {
  if (v === null) return null;
  const o = obj(v, f);
  keys(o, ['sourceDocumentId', 'location']);
  return {
    sourceDocumentId: id(o['sourceDocumentId'], f),
    location: text(o['location'], f),
  };
}
export function parseContractRevision(v: unknown): ContractRevisionInput {
  const o = obj(v, 'revision');
  keys(o, [
    'name',
    'originalNumber',
    'counterpartyRaw',
    'selfPartyRaw',
    'counterpartyCompanyId',
    'selfCompanyId',
    'informationOwnerPersonId',
    'signedOn',
    'effectiveOn',
    'registrationStatus',
    'total',
    'currency',
    'taxBasis',
    'sources',
    'headLocs',
    'lines',
  ]);
  const loc = obj(o['headLocs'], 'headLocs');
  keys(loc, ['parties', 'dates', 'total']);
  const currency = nullableText(o['currency'], 'currency', 3);
  if (currency !== null && !/^[A-Z]{3}$/.test(currency))
    throw new InvalidReportInput('currency');
  const total = value(o['total'], 4, false, 'total');
  if (total.state === 'VALUE' && currency === null)
    throw new InvalidReportInput('currency');
  const lines = list(o['lines'], 'lines').map((v) => {
    const l = obj(v, 'line');
    keys(l, [
      'id',
      'lineNo',
      'description',
      'quantity',
      'unitRaw',
      'unit',
      'pricingType',
      'amount',
      'includes',
      'excludes',
      'derivation',
      'source',
      'removed',
      'removalSource',
    ]);
    return {
      id: id(l['id'], 'line.id'),
      lineNo: text(l['lineNo'], 'lineNo', 100),
      description: text(l['description'], 'description'),
      quantity: value(l['quantity'], 6, false, 'quantity'),
      unitRaw: str(l['unitRaw'], 'unitRaw', 100),
      unit:
        l['unit'] === null ? null : oneOf(l['unit'], CONTRACT_UNITS, 'unit'),
      pricingType: oneOf(l['pricingType'], CONTRACT_PRICING, 'pricingType'),
      amount: value(l['amount'], 4, true, 'amount'),
      includes: str(l['includes'], 'includes'),
      excludes: str(l['excludes'], 'excludes'),
      derivation: str(l['derivation'], 'derivation'),
      source: location(l['source'], 'source'),
      removed: bool(l['removed'], 'removed'),
      removalSource: location(l['removalSource'], 'removalSource'),
    };
  });
  if (
    new Set(lines.map((l) => l.id)).size !== lines.length ||
    new Set(lines.map((l) => l.lineNo)).size !== lines.length
  )
    throw new InvalidReportInput('duplicate line');
  if (
    lines.some((l) =>
      l.removed ? l.removalSource === null : l.removalSource !== null,
    )
  )
    throw new InvalidReportInput('removalSource');
  if (lines.some((l) => l.amount.state === 'VALUE') && currency === null)
    throw new InvalidReportInput('currency');
  return {
    name: text(o['name'], 'name', 500),
    originalNumber: nullableText(o['originalNumber'], 'originalNumber', 500),
    counterpartyRaw: nullableText(o['counterpartyRaw'], 'counterpartyRaw', 500),
    selfPartyRaw: nullableText(o['selfPartyRaw'], 'selfPartyRaw', 500),
    counterpartyCompanyId: nullableId(
      o['counterpartyCompanyId'],
      'counterpartyCompanyId',
    ),
    selfCompanyId: nullableId(o['selfCompanyId'], 'selfCompanyId'),
    informationOwnerPersonId: nullableId(
      o['informationOwnerPersonId'],
      'informationOwnerPersonId',
    ),
    signedOn: dateValue(o['signedOn'], 'signedOn'),
    effectiveOn: dateValue(o['effectiveOn'], 'effectiveOn'),
    registrationStatus: oneOf(
      o['registrationStatus'],
      ['SIGNED_PENDING', 'EFFECTIVE'] as const,
      'registrationStatus',
    ),
    total,
    currency,
    taxBasis: oneOf(
      o['taxBasis'],
      ['INCLUSIVE', 'EXCLUSIVE', 'UNKNOWN'] as const,
      'taxBasis',
    ),
    sources: list(o['sources'], 'sources').map((v) => {
      const l = location(v, 'sources');
      if (!l) throw new InvalidReportInput('sources');
      return l;
    }),
    headLocs: {
      parties: location(loc['parties'], 'parties'),
      dates: location(loc['dates'], 'dates'),
      total: location(loc['total'], 'total'),
    },
    lines,
  };
}
export function parseCreateContract(v: unknown): CreateContractCommand {
  const o = obj(v, 'command');
  keys(o, [
    'contractId',
    'code',
    'direction',
    'expenditureSubtype',
    'expectedVersion',
    'clientMutationId',
    'revision',
  ]);
  if (o['expectedVersion'] !== 0)
    throw new InvalidReportInput('expectedVersion');
  const direction = oneOf(
    o['direction'],
    ['INCOME', 'EXPENDITURE'] as const,
    'direction',
  );
  const subtype =
    o['expenditureSubtype'] === null
      ? null
      : oneOf(
          o['expenditureSubtype'],
          ['SUBCONTRACT', 'PURCHASE'] as const,
          'expenditureSubtype',
        );
  if ((direction === 'INCOME') !== (subtype === null))
    throw new InvalidReportInput('expenditureSubtype');
  return {
    contractId: id(o['contractId'], 'contractId'),
    code: text(o['code'], 'code', 100),
    direction,
    expenditureSubtype: subtype,
    expectedVersion: 0,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    revision: parseContractRevision(o['revision']),
  };
}
export function parseCorrectContract(v: unknown): CorrectContractCommand {
  const o = obj(v, 'command');
  keys(o, [
    'contractId',
    'expectedVersion',
    'clientMutationId',
    'reason',
    'revision',
  ]);
  const n = version(o['expectedVersion'], 'expectedVersion');
  if (n < 1) throw new InvalidReportInput('expectedVersion');
  return {
    contractId: id(o['contractId'], 'contractId'),
    expectedVersion: n,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    reason: text(o['reason'], 'reason'),
    revision: parseContractRevision(o['revision']),
  };
}
export function parseContractShares(v: unknown): SetContractSharesCommand {
  const o = obj(v, 'command');
  keys(o, [
    'contractId',
    'lineId',
    'expectedVersion',
    'clientMutationId',
    'shares',
  ]);
  const shares = list(o['shares'], 'shares').map((v) => {
    const s = obj(v, 'share');
    keys(s, [
      'scopeId',
      'projectId',
      'expectedVersion',
      'basis',
      'quantity',
      'area',
      'note',
      'retired',
      'reason',
    ]);
    const basis = oneOf(
      s['basis'],
      ['WHOLE', 'QUANTITY', 'AREA', 'NOTE'] as const,
      'basis',
    );
    if (basis !== 'QUANTITY' && s['quantity'] !== null)
      throw new InvalidReportInput('quantity');
    const quantity =
      basis === 'QUANTITY'
        ? decimal(s['quantity'], 6, false, 'quantity')
        : null;
    if (quantity !== null && !/[1-9]/.test(quantity))
      throw new InvalidReportInput('quantity');
    const area = str(s['area'], 'area'),
      note = str(s['note'], 'note'),
      reason = str(s['reason'], 'reason'),
      retired = bool(s['retired'], 'retired');
    if (
      (basis === 'AREA' && !area.trim()) ||
      (basis === 'NOTE' && !note.trim()) ||
      (retired && !reason.trim())
    )
      throw new InvalidReportInput('share description');
    return {
      scopeId: id(s['scopeId'], 'scopeId'),
      projectId: id(s['projectId'], 'projectId'),
      expectedVersion: version(s['expectedVersion'], 'expectedVersion'),
      basis,
      quantity,
      area,
      note,
      retired,
      reason,
    };
  });
  if (
    !shares.length ||
    new Set(shares.map((s) => s.scopeId)).size !== shares.length ||
    new Set(shares.map((s) => s.projectId)).size !== shares.length
  )
    throw new InvalidReportInput('shares');
  const n = version(o['expectedVersion'], 'expectedVersion');
  if (n < 1) throw new InvalidReportInput('expectedVersion');
  return {
    contractId: id(o['contractId'], 'contractId'),
    lineId: id(o['lineId'], 'lineId'),
    expectedVersion: n,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    shares,
  };
}
export function parseContractAttentionRead(
  v: unknown,
): ReadContractAttentionCommand {
  const o = obj(v, 'command');
  keys(o, ['contractId', 'attentionId', 'clientMutationId']);
  return {
    contractId: id(o['contractId'], 'contractId'),
    attentionId: id(o['attentionId'], 'attentionId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
