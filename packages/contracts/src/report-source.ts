/** Source declarations, not verified evidence. Raw cells never feed operational totals. */
import { InvalidReportInput, KEY, date, obj, oneOf, str } from './parse.js';

export interface SourceCell {
  raw: string;
  state: 'value' | 'blank' | 'unknown' | 'na';
  at: {
    document: string;
    table: number;
    row: number;
    cell: number;
    gridSpan?: number;
    verticalMerge?: 'restart' | 'continue';
  };
}
export interface SourceReportV1 {
  schemaVersion: 1;
  documents: Record<string, { sha256: string; label: string; format: 'docx' }>;
  peopleTotal?: SourceCell;
  workPercent: Record<string, SourceCell>;
  materials: Record<
    string,
    {
      cumulative?: SourceCell;
      percent?: SourceCell;
      note?: SourceCell;
      unit?: SourceCell;
    }
  >;
}

/** A reported target is not an approved plan. Version 1 remains a distinct contract. */
export interface SourceReportV2 extends Omit<SourceReportV1, 'schemaVersion'> {
  schemaVersion: 2;
  reportedNextPlan: {
    targetBusinessDate: string;
    quantities: Record<string, SourceCell>;
  };
}
/** Original milestone declarations retain physical source cells, not approved dates. */
export interface SourceReportV3 extends Omit<SourceReportV1, 'schemaVersion'> {
  schemaVersion: 3;
  reportedNextPlan?: SourceReportV2['reportedNextPlan'];
  milestones: Record<
    string,
    {
      plannedFinish?: SourceCell;
      actualFinish?: SourceCell;
      reportedDelayDays?: SourceCell;
      note?: SourceCell;
    }
  >;
}
export type SourceReport = SourceReportV1 | SourceReportV2 | SourceReportV3;

/** Unknown keys are rejected without reflecting user-controlled key names in errors. */
export function reportObject(
  v: unknown,
  keys: readonly string[],
  field: string,
) {
  const o = obj(v, field);
  if (Object.keys(o).some((key) => !keys.includes(key)))
    throw new InvalidReportInput(`${field}.extra`);
  return o;
}
function entries(v: unknown, max: number, field: string) {
  const rows = Object.entries(obj(v, field));
  if (rows.length > max) throw new InvalidReportInput(field);
  rows.forEach(([key], index) => {
    if (!KEY.test(key)) throw new InvalidReportInput(`${field}[${index}]`);
  });
  return rows;
}
function integer(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new InvalidReportInput(field);
  return v;
}

export function parseSourceReport(v: unknown): SourceReport {
  const path = 'facts.sourceReport';
  const schemaVersion = obj(v, path)['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3)
    throw new InvalidReportInput(`${path}.schemaVersion`);
  const o = reportObject(
    v,
    [
      'schemaVersion',
      'documents',
      'peopleTotal',
      'workPercent',
      'materials',
      ...(schemaVersion !== 1 ? ['reportedNextPlan'] : []),
      ...(schemaVersion === 3 ? ['milestones'] : []),
    ],
    path,
  );
  const documents: SourceReportV1['documents'] = Object.fromEntries(
    entries(o['documents'], 4, `${path}.documents`).map(([key, v], index) => {
      const field = `${path}.documents[${index}]`;
      const d = reportObject(v, ['sha256', 'label', 'format'], field);
      const sha256 = str(d['sha256'], `${field}.sha256`, 64);
      if (!/^[a-f0-9]{64}$/.test(sha256))
        throw new InvalidReportInput(`${field}.sha256`);
      const label = str(d['label'], `${field}.label`, 200);
      if (
        !label.trim() ||
        /[\\/]/.test(label) ||
        Array.from(label).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      )
        throw new InvalidReportInput(`${field}.label`);
      return [
        key,
        {
          sha256,
          label,
          format: oneOf(d['format'], ['docx'] as const, `${field}.format`),
        },
      ];
    }),
  );
  if (!Object.keys(documents).length)
    throw new InvalidReportInput(`${path}.documents`);
  let count = 0;
  const cell = (v: unknown, field: string): SourceCell => {
    if (++count > 500) throw new InvalidReportInput(path);
    const c = reportObject(v, ['raw', 'state', 'at'], field);
    const raw = str(c['raw'], `${field}.raw`, 500);
    const state = oneOf(
      c['state'],
      ['value', 'blank', 'unknown', 'na'] as const,
      `${field}.state`,
    );
    if (
      (state === 'blank' && raw.trim() !== '') ||
      (state === 'value' && !raw.trim())
    )
      throw new InvalidReportInput(`${field}.raw`);
    const a = reportObject(
      c['at'],
      ['document', 'table', 'row', 'cell', 'gridSpan', 'verticalMerge'],
      `${field}.at`,
    );
    const document = str(a['document'], `${field}.at.document`, 64);
    if (!Object.hasOwn(documents, document))
      throw new InvalidReportInput(`${field}.at.document`);
    return {
      raw,
      state,
      at: {
        document,
        table: integer(a['table'], 0, 10000, `${field}.at.table`),
        row: integer(a['row'], 0, 10000, `${field}.at.row`),
        cell: integer(a['cell'], 0, 10000, `${field}.at.cell`),
        ...(Object.hasOwn(a, 'gridSpan')
          ? {
              gridSpan: integer(a['gridSpan'], 1, 1000, `${field}.at.gridSpan`),
            }
          : {}),
        ...(Object.hasOwn(a, 'verticalMerge')
          ? {
              verticalMerge: oneOf(
                a['verticalMerge'],
                ['restart', 'continue'] as const,
                `${field}.at.verticalMerge`,
              ),
            }
          : {}),
      },
    };
  };
  const peopleTotal = Object.hasOwn(o, 'peopleTotal')
    ? cell(o['peopleTotal'], `${path}.peopleTotal`)
    : undefined;
  const workPercent = Object.fromEntries(
    entries(o['workPercent'], 100, `${path}.workPercent`).map(([key, v], i) => [
      key,
      cell(v, `${path}.workPercent[${i}]`),
    ]),
  );
  const materials = Object.fromEntries(
    entries(o['materials'], 100, `${path}.materials`).map(([key, v], i) => {
      const field = `${path}.materials[${i}]`;
      const m = reportObject(
        v,
        ['cumulative', 'percent', 'note', 'unit'],
        field,
      );
      if (!Object.keys(m).length) throw new InvalidReportInput(field);
      return [
        key,
        Object.fromEntries(
          Object.entries(m).map(([k, v]) => [k, cell(v, `${field}.${k}`)]),
        ),
      ];
    }),
  );
  const common = {
    documents,
    ...(peopleTotal ? { peopleTotal } : {}),
    workPercent,
    materials,
  };
  let reportedNextPlan: SourceReportV2['reportedNextPlan'] | undefined;
  if (
    schemaVersion === 2 ||
    (schemaVersion === 3 && Object.hasOwn(o, 'reportedNextPlan'))
  ) {
    const field = `${path}.reportedNextPlan`;
    const plan = reportObject(
      o['reportedNextPlan'],
      ['targetBusinessDate', 'quantities'],
      field,
    );
    const targetBusinessDate = date(
      plan['targetBusinessDate'],
      `${field}.targetBusinessDate`,
    );
    const quantities = Object.fromEntries(
      entries(plan['quantities'], 100, `${field}.quantities`).map(
        ([key, v], i) => [key, cell(v, `${field}.quantities[${i}]`)],
      ),
    );
    if (!Object.keys(quantities).length)
      throw new InvalidReportInput(`${field}.quantities`);
    reportedNextPlan = { targetBusinessDate, quantities };
  }
  if (schemaVersion === 3) {
    const milestones = Object.fromEntries(
      entries(o['milestones'], 100, `${path}.milestones`).map(
        ([key, value], i) => {
          const field = `${path}.milestones[${i}]`;
          const row = reportObject(
            value,
            ['plannedFinish', 'actualFinish', 'reportedDelayDays', 'note'],
            field,
          );
          if (!Object.keys(row).length) throw new InvalidReportInput(field);
          return [
            key,
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                cell(v, `${field}.${k}`),
              ]),
            ),
          ];
        },
      ),
    );
    if (!Object.keys(milestones).length)
      throw new InvalidReportInput(`${path}.milestones`);
    return {
      ...common,
      schemaVersion: 3,
      milestones,
      ...(reportedNextPlan ? { reportedNextPlan } : {}),
    };
  }
  if (schemaVersion === 2 && reportedNextPlan)
    return { ...common, schemaVersion: 2, reportedNextPlan };
  if (count === 0) throw new InvalidReportInput(path);
  return { ...common, schemaVersion: 1 };
}
