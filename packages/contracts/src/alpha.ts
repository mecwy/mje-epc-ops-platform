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

/** Exact source text for a reported cell; it is not a normalized quantity. */
export type AlphaRawCell =
  | { state: 'VALUE'; value: string }
  | { state: 'BLANK' | 'UNKNOWN' | 'NOT_APPLICABLE'; value: null };

export interface AlphaProgressRow {
  id: string;
  item: string;
  scopeCandidate: string;
  unit: string;
  today: AlphaRawCell;
  cumulative: AlphaRawCell;
  designTotal: AlphaRawCell;
  reportedPercent: AlphaRawCell;
  nextPlan: AlphaRawCell;
}
export interface AlphaWorkforceRow {
  id: string;
  category: string;
  role: string;
  count: AlphaRawCell;
  scopeCandidate: string;
}
export interface AlphaMachineRow {
  id: string;
  equipment: string;
  location: string;
  count: AlphaRawCell;
  note: string;
}
export interface AlphaMaterialRow {
  id: string;
  item: string;
  unit: string;
  today: AlphaRawCell;
  cumulative: AlphaRawCell;
  designTotal: AlphaRawCell;
  reportedPercent: AlphaRawCell;
  note: string;
  scopeCandidate: string;
}
export interface AlphaMilestoneRow {
  id: string;
  name: string;
  plannedDate: string;
  actualDate: string;
  delayDays: AlphaRawCell;
  note: string;
}
/** Manual report sections mirror the source layout while every attribution stays pending. */
export interface AlphaReportedSections {
  originalRecorder: string;
  weather: string;
  temperature: string;
  reportedDuration: string;
  sourceNote: string;
  progress: AlphaProgressRow[];
  workforce: AlphaWorkforceRow[];
  machines: AlphaMachineRow[];
  materials: AlphaMaterialRow[];
  milestones: AlphaMilestoneRow[];
  qualityText: string;
  ehsText: string;
  constructionText: string;
  photoNotes: string;
}

export interface AlphaDeclaration {
  businessDate: string;
  deviceRecordedAt: string | null;
  workItems: AlphaWorkItem[];
  reportedHeadcount: ReportedValue;
  headcountNote: string;
  issues: string;
  tomorrow: { targetBusinessDate: string; text: string };
  reportedSections?: AlphaReportedSections;
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
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidAlphaInput(field);
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
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
function rawCell(value: unknown, field: string): AlphaRawCell {
  const input = object(value, field, ['state', 'value']);
  if (input['state'] === 'VALUE') {
    const raw = text(input['value'], `${field}.value`, 100);
    if (raw.length === 0) throw new InvalidAlphaInput(field);
    return { state: 'VALUE', value: raw };
  }
  if (
    (input['state'] === 'BLANK' ||
      input['state'] === 'UNKNOWN' ||
      input['state'] === 'NOT_APPLICABLE') &&
    input['value'] === null
  )
    return { state: input['state'], value: null };
  throw new InvalidAlphaInput(field);
}
function rows<T extends { id: string }>(
  value: unknown,
  field: string,
  parse: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new InvalidAlphaInput(field);
  const result = value.map((item, index) => parse(item, `${field}.${index}`));
  if (new Set(result.map((item) => item.id)).size !== result.length)
    throw new InvalidAlphaInput(`${field}.id`);
  return result;
}
function reportedSections(
  value: unknown,
  action: SaveAlphaCommand['action'],
): AlphaReportedSections {
  const field = 'reportedSections';
  const s = object(value, field, [
    'originalRecorder',
    'weather',
    'temperature',
    'reportedDuration',
    'sourceNote',
    'progress',
    'workforce',
    'machines',
    'materials',
    'milestones',
    'qualityText',
    'ehsText',
    'constructionText',
    'photoNotes',
  ]);
  const named = (value: unknown, path: string, keys: string[]) => {
    const item = object(value, path, keys);
    return {
      item,
      id: identifier(item['id'], `${path}.id`),
      required: action === 'SAVE_VERSION',
    };
  };
  const progress = rows(s['progress'], `${field}.progress`, (value, path) => {
    const { item, id, required } = named(value, path, [
      'id',
      'item',
      'scopeCandidate',
      'unit',
      'today',
      'cumulative',
      'designTotal',
      'reportedPercent',
      'nextPlan',
    ]);
    return {
      id,
      item: text(item['item'], `${path}.item`, 200, required),
      scopeCandidate: text(
        item['scopeCandidate'],
        `${path}.scopeCandidate`,
        300,
      ),
      unit: text(item['unit'], `${path}.unit`, 100),
      today: rawCell(item['today'], `${path}.today`),
      cumulative: rawCell(item['cumulative'], `${path}.cumulative`),
      designTotal: rawCell(item['designTotal'], `${path}.designTotal`),
      reportedPercent: rawCell(
        item['reportedPercent'],
        `${path}.reportedPercent`,
      ),
      nextPlan: rawCell(item['nextPlan'], `${path}.nextPlan`),
    };
  });
  const workforce = rows(
    s['workforce'],
    `${field}.workforce`,
    (value, path) => {
      const { item, id, required } = named(value, path, [
        'id',
        'category',
        'role',
        'count',
        'scopeCandidate',
      ]);
      return {
        id,
        category: text(item['category'], `${path}.category`, 200),
        role: text(item['role'], `${path}.role`, 200, required),
        count: rawCell(item['count'], `${path}.count`),
        scopeCandidate: text(
          item['scopeCandidate'],
          `${path}.scopeCandidate`,
          300,
        ),
      };
    },
  );
  const machines = rows(s['machines'], `${field}.machines`, (value, path) => {
    const { item, id, required } = named(value, path, [
      'id',
      'equipment',
      'location',
      'count',
      'note',
    ]);
    return {
      id,
      equipment: text(item['equipment'], `${path}.equipment`, 200, required),
      location: text(item['location'], `${path}.location`, 300),
      count: rawCell(item['count'], `${path}.count`),
      note: text(item['note'], `${path}.note`, 1000),
    };
  });
  const materials = rows(
    s['materials'],
    `${field}.materials`,
    (value, path) => {
      const { item, id, required } = named(value, path, [
        'id',
        'item',
        'unit',
        'today',
        'cumulative',
        'designTotal',
        'reportedPercent',
        'note',
        'scopeCandidate',
      ]);
      return {
        id,
        item: text(item['item'], `${path}.item`, 200, required),
        unit: text(item['unit'], `${path}.unit`, 100),
        today: rawCell(item['today'], `${path}.today`),
        cumulative: rawCell(item['cumulative'], `${path}.cumulative`),
        designTotal: rawCell(item['designTotal'], `${path}.designTotal`),
        reportedPercent: rawCell(
          item['reportedPercent'],
          `${path}.reportedPercent`,
        ),
        note: text(item['note'], `${path}.note`, 1000),
        scopeCandidate: text(
          item['scopeCandidate'],
          `${path}.scopeCandidate`,
          300,
        ),
      };
    },
  );
  const milestones = rows(
    s['milestones'],
    `${field}.milestones`,
    (value, path) => {
      const { item, id, required } = named(value, path, [
        'id',
        'name',
        'plannedDate',
        'actualDate',
        'delayDays',
        'note',
      ]);
      return {
        id,
        name: text(item['name'], `${path}.name`, 200, required),
        plannedDate: text(item['plannedDate'], `${path}.plannedDate`, 100),
        actualDate: text(item['actualDate'], `${path}.actualDate`, 100),
        delayDays: rawCell(item['delayDays'], `${path}.delayDays`),
        note: text(item['note'], `${path}.note`, 1000),
      };
    },
  );
  return {
    originalRecorder: text(
      s['originalRecorder'],
      `${field}.originalRecorder`,
      200,
    ),
    weather: text(s['weather'], `${field}.weather`, 200),
    temperature: text(s['temperature'], `${field}.temperature`, 100),
    reportedDuration: text(
      s['reportedDuration'],
      `${field}.reportedDuration`,
      200,
    ),
    sourceNote: text(s['sourceNote'], `${field}.sourceNote`, 1000),
    progress,
    workforce,
    machines,
    materials,
    milestones,
    qualityText: text(s['qualityText'], `${field}.qualityText`, 4000),
    ehsText: text(s['ehsText'], `${field}.ehsText`, 4000),
    constructionText: text(
      s['constructionText'],
      `${field}.constructionText`,
      4000,
    ),
    photoNotes: text(s['photoNotes'], `${field}.photoNotes`, 2000),
  };
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
  const declaration = object(
    input['declaration'],
    'declaration',
    [
      'businessDate',
      'deviceRecordedAt',
      'workItems',
      'reportedHeadcount',
      'headcountNote',
      'issues',
      'tomorrow',
    ],
    ['reportedSections'],
  );
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
  const sections = Object.hasOwn(declaration, 'reportedSections')
    ? reportedSections(
        declaration['reportedSections'],
        input['action'] as SaveAlphaCommand['action'],
      )
    : undefined;
  if (
    !Array.isArray(works) ||
    works.length > 50 ||
    (input['action'] === 'SAVE_VERSION' &&
      works.length === 0 &&
      (!sections ||
        (sections.progress.length === 0 &&
          sections.workforce.length === 0 &&
          sections.machines.length === 0 &&
          sections.materials.length === 0 &&
          sections.milestones.length === 0 &&
          !sections.qualityText.trim() &&
          !sections.ehsText.trim() &&
          !sections.constructionText.trim())))
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
      ...(sections ? { reportedSections: sections } : {}),
    },
  };
}
