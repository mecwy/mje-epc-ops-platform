import { describe, expect, it } from 'vitest';
import { cumulativeChart, type CumulativePoint } from './overview-chart.js';
const primary = { key: 'TEST-work', unit: 'TEST-units' };
const point = (day: number, value: string | null): CumulativePoint => ({
  businessDate: `2026-10-${String(day).padStart(2, '0')}`,
  value,
  workItemKey: primary.key,
  unit: primary.unit,
});
describe('cumulative SVG projection', () => {
  it('preserves exact values beyond JS integer precision and separates numeric neighbours', () => {
    const chart = cumulativeChart(
      [
        point(1, '9007199254740992.000001'),
        point(2, '9007199254740993.000002'),
      ],
      primary,
    );
    expect(chart.flat().map((p) => p.value)).toEqual([
      '9007199254740992.000001',
      '9007199254740993.000002',
    ]);
    expect(
      chart.flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);
  });
  it('retains explicit zero and breaks the curve for blank, unknown and not-applicable observations', () => {
    const chart = cumulativeChart(
      [
        point(1, '0'),
        point(2, null),
        point(3, '2'),
        point(4, 'unknown'),
        point(5, '3'),
        point(6, 'na'),
        point(7, '4'),
      ],
      primary,
    );
    expect(chart.map((segment) => segment.map((p) => p.value))).toEqual([
      ['0'],
      ['2'],
      ['3'],
      ['4'],
    ]);
    expect(chart[0]![0]!.y).toBe(180);
  });
  it('does not connect observations across a unit or primary item change, even if changed back', () => {
    const points = [
      point(1, '1'),
      { ...point(2, '4000'), unit: 'different' },
      point(3, '2'),
      point(4, '3'),
    ];
    expect(
      cumulativeChart(points, primary)
        .flat()
        .map((p) => p.date),
    ).toEqual(['2026-10-03', '2026-10-04']);
    points[1] = { ...point(2, '4000'), workItemKey: 'other' };
    expect(cumulativeChart(points, primary).flat()).toHaveLength(2);
  });
  it('does not invent frozen identity for old payloads or unconfigured primary items', () => {
    expect(
      cumulativeChart([{ businessDate: '2026-10-01', value: '12' }], primary),
    ).toEqual([]);
    expect(cumulativeChart([point(1, '1')], null)).toEqual([]);
  });
  it('uses business-date spacing rather than pretending missing days are adjacent observations', () => {
    const rows = cumulativeChart(
      [point(1, '1'), point(2, '2'), point(7, '3')],
      primary,
    ).flat();
    expect(rows[1]!.x - rows[0]!.x).toBeLessThan(rows[2]!.x - rows[1]!.x);
  });
});
