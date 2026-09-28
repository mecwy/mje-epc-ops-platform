/** Manual declarations only; these DTOs never represent verified labor or acceptance. */
export type ReportedValue =
  | { state: 'VALUE'; value: string }
  | { state: 'BLANK' | 'UNKNOWN' | 'NOT_APPLICABLE'; value: null };

export interface AlphaWorkItem {
  id: string;
  area: string;
  description: string;
  quantity: ReportedValue;
  unit: string;
}

export interface AlphaDeclaration {
  businessDate: string;
  deviceRecordedAt: string | null;
  workItems: AlphaWorkItem[];
  reportedHeadcount: ReportedValue;
  headcountNote: string;
  issues: string;
  tomorrow: { targetBusinessDate: string; text: string };
}

export interface SaveAlphaCommand {
  recordId: string;
  projectId: string;
  expectedVersion: number;
  baseRevisionNumber: number | null;
  clientMutationId: string;
  action: 'SAVE_DRAFT' | 'SAVE_VERSION';
  reason: string;
  declaration: AlphaDeclaration;
}

export class InvalidAlphaInput extends Error {
  constructor(public readonly field: string) {
    super(`Invalid field: ${field}`);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(
  value: unknown,
  field: string,
  keys: string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidAlphaInput(field);
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(result, key))
  )
    throw new InvalidAlphaInput(field);
  return result;
}
function text(
  value: unknown,
  field: string,
  max: number,
  required = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && value.trim().length === 0) ||
    value.includes('\0')
  )
    throw new InvalidAlphaInput(field);
  return value; // Preserve source spelling, units and whitespace; never silently normalize.
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new InvalidAlphaInput(field);
  return value.toLowerCase();
}
export function parseBusinessDate(
  value: unknown,
  field = 'businessDate',
): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new InvalidAlphaInput(field);
  const day = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== value
  )
    throw new InvalidAlphaInput(field);
  return value;
}
export function followingBusinessDate(value: string): string {
  const day = new Date(`${parseBusinessDate(value)}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
function reported(
  value: unknown,
  field: string,
  integer = false,
): ReportedValue {
  const input = object(value, field, ['state', 'value']);
  if (input['state'] === 'VALUE') {
    const raw = text(input['value'], `${field}.value`, 32, true);
    // Decimal(20,6); count strings are integers. No Number conversion or rounding.
    if (!(integer ? /^\d{1,7}$/ : /^\d{1,14}(?:\.\d{1,6})?$/).test(raw))
      throw new InvalidAlphaInput(field);
    return { state: 'VALUE', value: raw };
  }
  if (
    (input['state'] === 'BLANK' ||
      input['state'] === 'UNKNOWN' ||
      input['state'] === 'NOT_APPLICABLE') &&
    input['value'] === null
  ) {
    return { state: input['state'], value: null };
  }
  throw new InvalidAlphaInput(field);
}
export function parseSaveAlphaCommand(value: unknown): SaveAlphaCommand {
  const input = object(value, 'command', [
    'recordId',
    'projectId',
    'expectedVersion',
    'baseRevisionNumber',
    'clientMutationId',
    'action',
    'reason',
    'declaration',
  ]);
  if (
    !Number.isSafeInteger(input['expectedVersion']) ||
    (input['expectedVersion'] as number) < 0 ||
    (input['expectedVersion'] as number) > 2147483646
  )
    throw new InvalidAlphaInput('expectedVersion');
  if (input['action'] !== 'SAVE_DRAFT' && input['action'] !== 'SAVE_VERSION')
    throw new InvalidAlphaInput('action');
  const base = input['baseRevisionNumber'];
  if (
    base !== null &&
    (!Number.isSafeInteger(base) ||
      (base as number) < 1 ||
      (base as number) > 2147483646)
  )
    throw new InvalidAlphaInput('baseRevisionNumber');
  const declaration = object(input['declaration'], 'declaration', [
    'businessDate',
    'deviceRecordedAt',
    'workItems',
    'reportedHeadcount',
    'headcountNote',
    'issues',
    'tomorrow',
  ]);
  const businessDate = parseBusinessDate(declaration['businessDate']);
  const recorded = declaration['deviceRecordedAt'];
  if (recorded !== null) {
    if (
      typeof recorded !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        recorded,
      ) ||
      !Number.isFinite(Date.parse(recorded))
    )
      throw new InvalidAlphaInput('deviceRecordedAt');
    parseBusinessDate(recorded.slice(0, 10), 'deviceRecordedAt');
  }
  const works = declaration['workItems'];
  if (
    !Array.isArray(works) ||
    works.length > 50 ||
    (input['action'] === 'SAVE_VERSION' && works.length === 0)
  )
    throw new InvalidAlphaInput('workItems');
  const workItems: AlphaWorkItem[] = works.map((value, index) => {
    const field = `workItems.${index}`;
    const item = object(value, field, [
      'id',
      'area',
      'description',
      'quantity',
      'unit',
    ]);
    const quantity = reported(item['quantity'], `${field}.quantity`);
    return {
      id: identifier(item['id'], `${field}.id`),
      area: text(item['area'], `${field}.area`, 200),
      description: text(
        item['description'],
        `${field}.description`,
        4000,
        input['action'] === 'SAVE_VERSION',
      ),
      quantity,
      unit: text(
        item['unit'],
        `${field}.unit`,
        100,
        quantity.state === 'VALUE',
      ),
    };
  });
  if (new Set(workItems.map((item) => item.id)).size !== workItems.length)
    throw new InvalidAlphaInput('workItems.id');
  const tomorrow = object(declaration['tomorrow'], 'tomorrow', [
    'targetBusinessDate',
    'text',
  ]);
  if (
    parseBusinessDate(
      tomorrow['targetBusinessDate'],
      'tomorrow.targetBusinessDate',
    ) !== followingBusinessDate(businessDate)
  )
    throw new InvalidAlphaInput('tomorrow.targetBusinessDate');
  return {
    recordId: identifier(input['recordId'], 'recordId'),
    projectId: identifier(input['projectId'], 'projectId'),
    expectedVersion: input['expectedVersion'] as number,
    baseRevisionNumber: base as number | null,
    clientMutationId: identifier(input['clientMutationId'], 'clientMutationId'),
    action: input['action'],
    reason: text(input['reason'], 'reason', 1000),
    declaration: {
      businessDate,
      deviceRecordedAt: recorded as string | null,
      workItems,
      reportedHeadcount: reported(
        declaration['reportedHeadcount'],
        'reportedHeadcount',
        true,
      ),
      headcountNote: text(declaration['headcountNote'], 'headcountNote', 2000),
      issues: text(declaration['issues'], 'issues', 4000),
      tomorrow: {
        targetBusinessDate: tomorrow['targetBusinessDate'] as string,
        text: text(tomorrow['text'], 'tomorrow.text', 4000),
      },
    },
  };
}
