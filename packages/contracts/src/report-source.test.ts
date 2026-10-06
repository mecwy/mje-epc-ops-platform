import { describe, expect, it } from 'vitest';
import { InvalidReportInput } from './parse.js';
import { parseSourceReport, type SourceReportV1 } from './report-source.js';

function source(): SourceReportV1 {
  return {
    schemaVersion: 1,
    documents: {
      testDoc: { sha256: 'a'.repeat(64), label: 'TEST source', format: 'docx' },
    },
    peopleTotal: {
      raw: ' 7 ',
      state: 'value',
      at: {
        document: 'testDoc',
        table: 0,
        row: 1,
        cell: 2,
        gridSpan: 2,
        verticalMerge: 'restart',
      },
    },
    workPercent: {},
    materials: {},
  };
}
describe('strict source declarations', () => {
  it('copies raw bytes, explicit states and physical coordinates without normalizing', () => {
    const s = source();
    s.workPercent = { testWork: { ...s.peopleTotal!, raw: ' 25% ' } };
    s.materials = {
      testMaterial: {
        cumulative: { ...s.peopleTotal!, raw: '0' },
        percent: { ...s.peopleTotal!, raw: ' ? ', state: 'unknown' },
        note: { ...s.peopleTotal!, raw: ' \n ', state: 'blank' },
        unit: { ...s.peopleTotal!, raw: ' N/A ', state: 'na' },
      },
    };
    expect(parseSourceReport(s)).toEqual(s);
    const parsed = parseSourceReport(s);
    s.peopleTotal!.raw = '999';
    s.peopleTotal!.at.row = 42;
    expect(parsed.peopleTotal!.raw).toBe(' 7 ');
    expect(parsed.peopleTotal!.at.row).toBe(1);
  });
  it.each([
    null,
    [],
    {},
    { ...source(), schemaVersion: 2 },
    { ...source(), documents: {} },
    { ...source(), workPercent: [] },
    { ...source(), materials: { empty: {} } },
    { ...source(), peopleTotal: undefined },
    { ...source(), peopleTotal: null },
    {
      schemaVersion: 1,
      documents: source().documents,
      workPercent: {},
      materials: {},
    },
  ])('rejects malformed or empty source %j', (value) => {
    expect(() => parseSourceReport(value)).toThrow(InvalidReportInput);
  });
  it.each(['extra', 'rawCells', 'url', 'orgId'])(
    'refuses undocumented %s without echoing untrusted text',
    (key) => {
      expect(() => parseSourceReport({ ...source(), [key]: 'TEST' })).toThrow(
        'facts.sourceReport.extra',
      );
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: { ...source().peopleTotal, [key]: 'TEST' },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it.each(['value', 'blank'] as const)(
    'checks raw/state consistency for %s',
    (state) => {
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: {
            ...source().peopleTotal,
            raw: state === 'blank' ? '0' : '  ',
            state,
          },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it.each([-1, 1.5, 10001, '0', null])(
    'refuses invalid coordinate %j',
    (row) => {
      const s = source();
      expect(() =>
        parseSourceReport({
          ...s,
          peopleTotal: { ...s.peopleTotal, at: { ...s.peopleTotal!.at, row } },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it('rejects missing document references, extra coordinate fields and invalid merge metadata', () => {
    for (const at of [
      { ...source().peopleTotal!.at, document: 'constructor' },
      { ...source().peopleTotal!.at, url: 'https://example.invalid' },
      { ...source().peopleTotal!.at, gridSpan: 0 },
      { ...source().peopleTotal!.at, gridSpan: 1001 },
      { ...source().peopleTotal!.at, verticalMerge: 'other' },
    ])
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: { ...source().peopleTotal, at },
        }),
      ).toThrow(InvalidReportInput);
  });
  it.each([
    '/private/TEST.docx',
    'C:\\TEST.docx',
    'https://example.invalid/TEST',
    'TEST\nsecret',
    '',
  ])('rejects a path, URL or control character in a label: %j', (label) => {
    expect(() =>
      parseSourceReport({
        ...source(),
        documents: { testDoc: { ...source().documents['testDoc'], label } },
      }),
    ).toThrow(InvalidReportInput);
  });
  it('bounds maps, total cells, raw text, labels and hashes', () => {
    const s = source();
    const cells = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`test${i}`, s.peopleTotal!]),
      );
    expect(() => parseSourceReport({ ...s, workPercent: cells(101) })).toThrow(
      InvalidReportInput,
    );
    expect(() =>
      parseSourceReport({
        ...s,
        documents: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `d${i}`,
            s.documents['testDoc'],
          ]),
        ),
      }),
    ).toThrow(InvalidReportInput);
    expect(() =>
      parseSourceReport({
        ...s,
        peopleTotal: { ...s.peopleTotal, raw: 'x'.repeat(501) },
      }),
    ).toThrow(InvalidReportInput);
    for (const change of [
      { label: 'x'.repeat(201) },
      { sha256: 'A'.repeat(64) },
      { format: 'html' },
    ])
      expect(() =>
        parseSourceReport({
          ...s,
          documents: { testDoc: { ...s.documents['testDoc'], ...change } },
        }),
      ).toThrow(InvalidReportInput);
    const full = {
      ...s,
      workPercent: cells(100),
      materials: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `test${i}`,
          {
            cumulative: s.peopleTotal!,
            percent: s.peopleTotal!,
            unit: s.peopleTotal!,
            note: s.peopleTotal!,
          },
        ]),
      ),
    };
    expect(() => parseSourceReport(full)).toThrow(InvalidReportInput); // 501 cells
    delete full.peopleTotal;
    expect(parseSourceReport(full).workPercent).toEqual(cells(100)); // 500 cells
  });
  it('reports hostile map keys by position without leaking them', () => {
    const hostile = 'TEST\n' + 'z'.repeat(1000);
    expect(() =>
      parseSourceReport({
        ...source(),
        workPercent: { [hostile]: source().peopleTotal },
      }),
    ).toThrow('facts.sourceReport.workPercent[0]');
  });
});
