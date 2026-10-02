import {
  daysBetween,
  dec,
  pct,
  shiftDate,
  type Reported,
} from '../report-rules.js';

export type Completion =
  | { state: 'NOT_FROZEN' }
  | { state: 'UNCONFIGURED' }
  | { state: 'NOT_COMPUTABLE' }
  | { state: 'COMPUTABLE'; percent: string; aboveDesign: boolean };

export function completion(
  primaryWorkItemKey: string | null | undefined,
  designQty: Reported | null,
  cumulative: Reported | null,
): Completion {
  if (primaryWorkItemKey === undefined) return { state: 'NOT_FROZEN' };
  if (primaryWorkItemKey === null) return { state: 'UNCONFIGURED' };
  const design = dec(designQty);
  const done = dec(cumulative);
  if (design === null || design === 0n || done === null)
    return { state: 'NOT_COMPUTABLE' };
  const percent = pct(done, design);
  return percent === null
    ? { state: 'NOT_COMPUTABLE' }
    : { state: 'COMPUTABLE', percent, aboveDesign: done > design };
}

export function statusAge(today: string, latestBusinessDate: string | null) {
  if (!latestBusinessDate)
    return { stale: false, staleDays: null, undeclared: true };
  const staleDays = daysBetween(latestBusinessDate, today);
  return { stale: staleDays > 7, staleDays, undeclared: false };
}

export interface ForecastObservation {
  businessDate: string;
  primaryWorkItemKey: string | null;
  unit: string | null;
  qty: Reported | null;
}

export type Forecast =
  | { state: 'NOT_COMPUTABLE' }
  | { state: 'AT_DESIGN' }
  | { state: 'ESTIMATE'; expectedDate: string; sampleDays: number };

/** Forecast only a stable suffix of the last seven submitted observations. */
export function forecastCompletion(args: {
  today: string;
  primaryWorkItemKey: string | null;
  unit: string | null;
  designQty: Reported | null;
  cumulative: Reported | null;
  observations: ForecastObservation[];
}): Forecast {
  if (!args.primaryWorkItemKey) return { state: 'NOT_COMPUTABLE' };
  const design = dec(args.designQty);
  const cumulative = dec(args.cumulative);
  if (design === null || cumulative === null)
    return { state: 'NOT_COMPUTABLE' };
  const remaining = design - cumulative;
  if (remaining <= 0n) return { state: 'AT_DESIGN' };

  const recent = [...args.observations]
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate))
    .slice(-7);
  // A key/unit change invalidates all observations before the latest transition.
  let start = 0;
  for (let i = 0; i < recent.length; i++)
    if (
      recent[i]!.primaryWorkItemKey !== args.primaryWorkItemKey ||
      recent[i]!.unit !== args.unit
    )
      start = i + 1;
  const suffix = recent.slice(start).filter((day) => dec(day.qty) !== null);
  if (!suffix.length) return { state: 'NOT_COMPUTABLE' };
  const sum = suffix.reduce((total, day) => total + dec(day.qty)!, 0n);
  if (sum <= 0n) return { state: 'NOT_COMPUTABLE' };
  // ceil(remaining / mean(daily qty)); preserve fractional average exactly.
  const numerator = remaining * BigInt(suffix.length);
  const days = Number((numerator + sum - 1n) / sum);
  return {
    state: 'ESTIMATE',
    expectedDate: shiftDate(args.today, days),
    sampleDays: suffix.length,
  };
}
