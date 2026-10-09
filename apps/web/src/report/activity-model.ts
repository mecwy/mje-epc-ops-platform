import type {
  ActivityMaterialMapping,
  ReportActivity,
  ReportItemDto,
  DayFactsDto,
} from '@mje/contracts';
import { dec, decText, inRange } from '@mje/domain/rules';

export function newActivity(
  work: ReportItemDto & { id?: string },
  mapping?: ActivityMaterialMapping,
  quantity = '',
): ReportActivity {
  const operationId = crypto.randomUUID();
  const outputFactId = crypto.randomUUID();
  const a: ReportActivity = {
    operationId,
    outputFactId,
    workItemId: mapping?.workItemId ?? work.id ?? '',
    workItemKey: work.key,
    workPackageId: mapping?.workPackageId ?? work.key,
    scopeVersion: mapping?.scopeVersion ?? '1',
    area: mapping?.area ?? '',
    process: work.label,
    completion: '',
    outputUnit: work.unit,
    quantity,
    outputKind: 'installation',
    use: {
      id: crypto.randomUUID(),
      materialKey: mapping?.materialKey ?? null,
      materialItemId: mapping?.materialItemId ?? null,
      specification: mapping?.specification ?? '',
      unit: mapping?.materialUnit ?? '',
      estimate: null,
      actualQuantity: '',
      state: 'pending',
      origin: 'manual',
      differenceNote: '',
      reviewRequired: false,
      confirmation: null,
    },
  };
  if (mapping && a.use) {
    a.use.estimate = {
      quantity,
      ruleId: mapping.ruleId,
      ruleVersion: mapping.ruleVersion,
      mappingVersion: mapping.mappingVersion,
      scopeRef: `${a.workPackageId}@${a.scopeVersion}`,
      outputFactId,
      outputQuantity: quantity,
      workItemKey: work.key,
      materialKey: mapping.materialKey,
      specification: mapping.specification,
      outputUnit: work.unit,
      materialUnit: mapping.materialUnit,
      ratio: '1',
    };
    a.use.state = 'calculated';
    a.use.origin = 'calculated';
  }
  return a;
}

/** An edit is semantic even if the user types the same amount as the carried value. */
export function editActivity(
  a: ReportActivity,
  field: string,
  value: string,
): ReportActivity {
  const next = structuredClone(a);
  const use = next.use;
  if (field === 'quantity') {
    next.quantity = value;
    if (use?.state === 'calculated' && use.estimate) {
      use.estimate.quantity = value;
      use.estimate.outputQuantity = value;
    } else if (
      use &&
      value !== a.quantity &&
      (use.state === 'edited' || use.state === 'declared')
    ) {
      use.reviewRequired = true;
    }
  } else if (field === 'consumption' && use) {
    use.actualQuantity = value;
    use.state = 'edited';
    use.origin = 'manual';
    use.confirmation = null;
  } else if (field === 'explanation' && use) use.differenceNote = value;
  else if (field === 'area') next.area = value;
  else if (field === 'scope') next.workPackageId = value;
  else if (field === 'process') next.process = value;
  else if (field === 'completion') next.completion = value;
  return next;
}

export function pendingActivityUse(
  a: ReportActivity,
  pending: boolean,
): ReportActivity {
  const next = structuredClone(a);
  if (!next.use) return next;
  next.use.confirmation = null;
  next.use.state = pending
    ? 'pending'
    : next.use.origin === 'manual'
      ? 'edited'
      : 'calculated';
  return next;
}

export function linkedQuantities(
  rows: readonly ReportActivity[],
): Record<string, string> {
  const qty: Record<string, string> = {};
  for (const key of new Set(
    rows
      .filter((a) => a.outputKind === 'installation')
      .map((a) => a.workItemKey),
  )) {
    const values = rows
      .filter((a) => a.outputKind === 'installation' && a.workItemKey === key)
      .map((a) => dec(a.quantity));
    const sum = values.reduce<bigint>((n, v) => n + (v ?? 0n), 0n);
    qty[key] =
      values.some((v) => v === null) || !inRange(sum) ? '' : decText(sum);
  }
  return qty;
}

export function withActivities(
  facts: DayFactsDto,
  activities: ReportActivity[],
): DayFactsDto {
  return {
    ...facts,
    activities,
    qty: { ...facts.qty, ...linkedQuantities(activities) },
  };
}

/** Never count a draft candidate or pending material as declared actual use. */
export function consumptionRows(rows: readonly ReportActivity[]) {
  return rows.flatMap((a) =>
    a.use
      ? [
          {
            operationId: a.operationId,
            process: a.process,
            area: a.area,
            ...a.use,
            displayedQuantity:
              a.use.state === 'calculated'
                ? (a.use.estimate?.quantity ?? '')
                : a.use.actualQuantity,
          },
        ]
      : [],
  );
}
