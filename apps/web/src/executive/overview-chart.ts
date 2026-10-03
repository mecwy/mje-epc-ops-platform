/** Exact decimal values stay strings; bounded SVG pixel coordinates alone become numbers. */
export interface CumulativePoint {
  businessDate: string;
  value: string | null;
  workItemKey?: string | null;
  unit?: string | null;
}
export interface ChartPoint {
  date: string;
  value: string;
  x: number;
  y: number;
}
function fixed(value: string | null): bigint | null {
  if (value === null || !/^-?\d{1,20}(?:\.\d{1,6})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return BigInt(`${whole}${fraction.padEnd(6, '0')}`) * (negative ? -1n : 1n);
}
/** Show only the latest uninterrupted item/unit series; gaps stay gaps, never zeroes. */
export function cumulativeChart(
  points: readonly CumulativePoint[],
  primary: { key: string; unit: string } | null,
): ChartPoint[][] {
  if (!primary) return [];
  const cutoff = points.findLastIndex(
    (p) => p.workItemKey !== primary.key || p.unit !== primary.unit,
  );
  const series = points.slice(cutoff + 1);
  const values = series.map((p) => fixed(p.value));
  const known = values.filter((v): v is bigint => v !== null);
  if (!known.length) return [];
  const min = known.reduce((a, b) => (a < b ? a : b), 0n);
  const max = known.reduce((a, b) => (a > b ? a : b), 0n);
  const span = max - min;
  const firstDay = Date.parse(`${series[0]!.businessDate}T00:00:00Z`);
  const lastDay = Date.parse(`${series.at(-1)!.businessDate}T00:00:00Z`);
  if (!Number.isFinite(firstDay) || !Number.isFinite(lastDay)) return [];
  const segments: ChartPoint[][] = [];
  let segment: ChartPoint[] = [];
  series.forEach((point, i) => {
    const n = values[i]!,
      day = Date.parse(`${point.businessDate}T00:00:00Z`);
    if (n === null || !Number.isFinite(day)) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    // Ratio is calculated in integers, capped to one tenth of a viewBox pixel.
    const y = span === 0n ? 180 : 180 - Number(((n - min) * 1600n) / span) / 10;
    const x =
      lastDay === firstDay
        ? 300
        : 20 + ((day - firstDay) / (lastDay - firstDay)) * 560;
    segment.push({ date: point.businessDate, value: point.value!, x, y });
  });
  if (segment.length) segments.push(segment);
  return segments;
}
