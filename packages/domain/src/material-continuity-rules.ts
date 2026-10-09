import { dec, decText } from './report-rules.js';
import type { MaterialProjectionDto, ReportActivity } from '@mje/contracts';

/** Compare only a documented installation mapping, never quantities in unrelated units. */
export function materialUseDifference(a: ReportActivity) {
  const use = a.use;
  const quantity = use?.state === 'declared' ? dec(use.actualQuantity) : null;
  const output = dec(a.quantity);
  const comparable =
    a.outputKind === 'installation' &&
    use?.estimate?.ratio === '1' &&
    use.estimate.outputUnit === a.outputUnit &&
    use.estimate.materialUnit === use.unit;
  const expected = comparable ? output : null;
  const difference =
    quantity === null || expected === null ? null : quantity - expected;
  return {
    expectedConsumption: expected === null ? null : decText(expected),
    difference: difference === null ? null : decText(difference),
    followupRequired:
      quantity !== null &&
      !!comparable &&
      (difference === null || difference !== 0n) &&
      !use!.differenceNote.trim(),
  };
}

/** A missing submitted day is unknown, including gaps before the queried day. */
export function missingMaterialDays(
  from: string,
  to: string,
  submitted: readonly string[],
) {
  const days = Math.max(
    0,
    (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) /
      86400000 +
      1,
  );
  return days - new Set(submitted.filter((d) => d >= from && d <= to)).size;
}

export interface MaterialQuantityMovement {
  businessDate: string;
  kind: 'opening' | 'use' | 'reversal';
  quantity: string;
}
/** This slice has daily use facts, so a supported opening must precede that whole site day. */
export function isMaterialOpeningDayStart(
  cutoffAt: string,
  businessDate: string,
  timezone: string,
) {
  const instant = new Date(cutoffAt);
  if (!Number.isFinite(instant.getTime()) || instant.getUTCMilliseconds() !== 0)
    return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return (
    `${parts.year}-${parts.month}-${parts.day}` === businessDate &&
    parts.hour === '00' &&
    parts.minute === '00' &&
    parts.second === '00'
  );
}
/** Append-only reversals have the original occurrence day, not the later recording day. */
export function projectMaterialQuantities(
  scopeId: string,
  businessDate: string,
  openingKnown: boolean,
  movements: readonly MaterialQuantityMovement[],
  pendingCount: number,
  ledgerVersion = 0,
): MaterialProjectionDto {
  let opening = 0n,
    today = 0n,
    use = 0n;
  for (const m of movements) {
    if (m.businessDate > businessDate) continue;
    const absolute = dec(
      m.quantity.startsWith('-') ? m.quantity.slice(1) : m.quantity,
    );
    if (absolute === null) throw new Error('INVALID_MATERIAL_MOVEMENT');
    const quantity = m.quantity.startsWith('-') ? -absolute : absolute;
    if (m.kind === 'opening') opening += quantity;
    else {
      use -= quantity;
      if (m.businessDate < businessDate) opening += quantity;
      else today += quantity;
    }
  }
  return {
    ledgerVersion,
    scopeId,
    businessDate,
    opening: openingKnown ? decText(opening) : null,
    admittedUseToday: decText(-today),
    admittedUseCumulative: decText(use),
    balance: openingKnown ? decText(opening + today) : null,
    complete: openingKnown && pendingCount === 0,
    pendingCount,
    independentVerification: false,
  };
}
