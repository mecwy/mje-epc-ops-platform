import {
  InvalidReportInput,
  parseReportActivities,
  type ReportActivity,
  type ActivityUseConfirmation,
  type ActivityMaterialMapping,
  type ReportItemDto,
} from '@mje/contracts';
import { dec, decText, inRange } from './report-rules.js';

// JSONB returns object keys in its own order. Compare content, not serialization order.
const canonical = (input: unknown) =>
  JSON.stringify(input, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const invalid = (field = 'facts.activities'): never => {
  throw new InvalidReportInput(field);
};

/** Sum only installation facts for their own work item, never predecessor quantities. */
export function activityOutputQuantities(
  rows: readonly ReportActivity[],
): Record<string, string> {
  const quantities: Record<string, string> = {};
  for (const key of new Set(
    rows
      .filter((a) => a.outputKind === 'installation')
      .map((a) => a.workItemKey),
  )) {
    const output = rows.filter(
      (a) => a.outputKind === 'installation' && a.workItemKey === key,
    );
    const parsed = output.map((a) => dec(a.quantity));
    const sum = parsed.reduce<bigint>(
      (total, value) => total + (value ?? 0n),
      0n,
    );
    if (!inRange(sum)) invalid();
    quantities[key] = parsed.some((n) => n === null) ? '' : decText(sum);
  }
  return quantities;
}

export function mappingFor(
  a: ReportActivity,
  mappings: readonly ActivityMaterialMapping[],
) {
  return mappings.find(
    (m) =>
      a.use &&
      a.workPackageId === m.workPackageId &&
      a.scopeVersion === m.scopeVersion &&
      a.area === m.area &&
      a.workItemKey === m.workItemKey &&
      a.workItemId === m.workItemId &&
      a.outputUnit === m.outputUnit &&
      a.use.materialKey === m.materialKey &&
      a.use.materialItemId === m.materialItemId &&
      a.use.specification === m.specification &&
      a.use.unit === m.materialUnit,
  );
}

/** Server admission. A client cannot manufacture a declaration or replace its confirmation. */
export function admitActivities(
  input: ReportActivity[],
  before: readonly ReportActivity[],
  items: readonly (ReportItemDto & { id?: string })[],
  mappings: readonly ActivityMaterialMapping[],
): ReportActivity[] {
  const rows = parseReportActivities(input);
  for (const old of before)
    if (
      !rows.some(
        (a) =>
          a.operationId === old.operationId &&
          a.outputFactId === old.outputFactId &&
          a.use?.id === old.use?.id,
      )
    )
      invalid();
  for (const a of rows) {
    const item = items.find(
      (i) => i.kind === 'work' && i.active && i.key === a.workItemKey,
    );
    if (item?.id && !a.workItemId) a.workItemId = item.id;
    if (
      !item ||
      a.workItemId !== item.id ||
      a.outputUnit !== item.unit ||
      !a.process.trim() ||
      !a.workPackageId.trim() ||
      !a.scopeVersion.trim()
    )
      invalid();
    const old = before.find((row) => row.operationId === a.operationId);
    if (
      old &&
      (a.outputFactId !== old.outputFactId ||
        a.workItemKey !== old.workItemKey ||
        a.outputKind !== old.outputKind ||
        (old.use?.materialKey != null &&
          (a.workPackageId !== old.workPackageId ||
            a.scopeVersion !== old.scopeVersion)))
    )
      invalid();
    const u = a.use;
    if (!u) continue;
    if (u.materialKey === null) {
      if (
        u.state !== 'pending' ||
        u.actualQuantity !== '' ||
        u.estimate !== null ||
        u.confirmation !== null
      )
        invalid();
      continue;
    }
    const material = items.find(
      (i) => i.kind === 'material' && i.active && i.key === u.materialKey,
    );
    if (material?.id && !u.materialItemId) u.materialItemId = material.id;
    if (
      !material ||
      material.id !== u.materialItemId ||
      material.unit !== u.unit
    )
      invalid();
    if (
      old?.use &&
      (old.use.id !== u.id ||
        (old.use.materialKey !== null &&
          old.use.materialKey !== u.materialKey) ||
        (old.use.materialKey !== null && old.use.unit !== u.unit) ||
        (old.use.materialKey !== null &&
          old.use.specification !== u.specification))
    )
      invalid();
    if (
      u.confirmation !== null &&
      (!old?.use ||
        !equal(old.use.confirmation, u.confirmation) ||
        old.use.actualQuantity !== u.actualQuantity ||
        old.use.origin !== u.origin)
    )
      invalid('facts.activities.confirmation');
    if (
      u.state === 'declared' &&
      (old?.use?.state !== 'declared' ||
        !u.confirmation ||
        old.use.actualQuantity !== u.actualQuantity ||
        old.use.origin !== u.origin)
    )
      invalid('facts.activities.declaration');
    if (u.state !== 'declared' && u.confirmation !== null)
      invalid('facts.activities.confirmation');
    if (
      u.state === 'calculated' &&
      old?.use &&
      (old.use.origin === 'manual' || old.use.state === 'declared')
    )
      invalid();
    if (
      u.state === 'calculated' &&
      (u.origin !== 'calculated' || u.actualQuantity !== '' || !u.estimate)
    )
      invalid();
    if (
      u.state === 'edited' &&
      (u.origin !== 'manual' || dec(u.actualQuantity) === null)
    )
      invalid();
    if (u.state === 'declared' && dec(u.actualQuantity) === null) invalid();
    const e = u.estimate;
    if (e) {
      if (
        e.outputFactId !== a.outputFactId ||
        e.workItemKey !== a.workItemKey ||
        e.materialKey !== u.materialKey ||
        e.specification !== u.specification ||
        e.outputUnit !== a.outputUnit ||
        e.materialUnit !== u.unit ||
        e.scopeRef !== `${a.workPackageId}@${a.scopeVersion}` ||
        dec(e.quantity) !== dec(e.outputQuantity)
      )
        invalid('facts.activities.estimate');
      const existingBasis =
        old?.use?.estimate &&
        equal(old.use.estimate, e) &&
        (u.state !== 'calculated' || old.area === a.area);
      const m = mappingFor(a, mappings);
      if (
        !existingBasis &&
        (!m ||
          e.ruleId !== m.ruleId ||
          e.ruleVersion !== m.ruleVersion ||
          e.mappingVersion !== m.mappingVersion)
      )
        invalid('facts.activities.mapping');
      if (u.state === 'calculated' && e.outputQuantity !== a.quantity)
        invalid('facts.activities.estimate');
    }
    if (
      old?.use &&
      a.quantity !== old.quantity &&
      (old.use.state === 'edited' || old.use.state === 'declared')
    ) {
      // Output correction cannot silently substitute an entered use value.
      if (
        u.actualQuantity !== old.use.actualQuantity &&
        u.state !== 'edited' &&
        u.state !== 'pending'
      )
        invalid();
      u.reviewRequired = true;
    }
  }
  return rows;
}

export function confirmActivityUses(
  rows: readonly ReportActivity[],
  confirmation: ActivityUseConfirmation | undefined,
  draftVersion: number,
  actor: { accountId: string; personId: string },
  at: string,
): ReportActivity[] {
  if (!rows.length) {
    if (
      confirmation &&
      (confirmation.draftVersion !== draftVersion ||
        confirmation.includedUseFactIds.length)
    )
      invalid('activityUseConfirmation');
    return [];
  }
  const expected = rows
    .flatMap((a) => (a.use && a.use.state !== 'pending' ? [a.use.id] : []))
    .sort();
  if (
    !confirmation ||
    confirmation.draftVersion !== draftVersion ||
    !equal([...confirmation.includedUseFactIds].sort(), expected)
  )
    invalid('activityUseConfirmation');
  return rows.map((a) => {
    const u = a.use;
    if (!u || u.state === 'pending') return structuredClone(a);
    const actualQuantity =
      u.state === 'calculated' ? u.estimate?.quantity : u.actualQuantity;
    if (actualQuantity === undefined || dec(actualQuantity) === null)
      invalid('facts.activities.actualQuantity');
    return {
      ...structuredClone(a),
      use: {
        ...structuredClone(u),
        actualQuantity: actualQuantity!,
        state: 'declared' as const,
        reviewRequired: false,
        confirmation: {
          accountId: actor.accountId,
          personId: actor.personId,
          at,
        },
      },
    };
  });
}

/** An explicitly bounded declaration projection; arrival and inventory totals are untouched. */
export function activityDeclaredConsumption(rows: readonly ReportActivity[]) {
  const totals: Record<string, string> = {};
  for (const a of rows)
    if (a.use?.state === 'declared' && a.use.materialKey !== null) {
      const value = dec(a.use.actualQuantity);
      if (value === null) invalid();
      const sum = (dec(totals[a.use.materialKey] ?? '0') ?? 0n) + value!;
      if (!inRange(sum)) invalid();
      totals[a.use.materialKey] = decText(sum);
    }
  return totals;
}
