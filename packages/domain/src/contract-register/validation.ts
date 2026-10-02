import { isDeepStrictEqual } from 'node:util';
import type {
  ContractLineInput,
  ContractLocation,
  ContractRevisionInput,
  ContractShareInput,
} from '@mje/contracts';
import { ContractRegisterError } from './rules.js';

/** Decimal(20,s) integers: never coerce quantities or money to JS numbers. */
export function scaled(value: string, scale: 4 | 6): bigint {
  if (
    !new RegExp(
      `^-?(?:0|[1-9]\\d{0,${19 - scale}})(?:\\.\\d{1,${scale}})?$`,
    ).test(value)
  )
    throw new ContractRegisterError('INVALID_VALUE');
  const negative = value.startsWith('-');
  const [whole, part = ''] = (negative ? value.slice(1) : value).split('.');
  const n = BigInt(whole! + part.padEnd(scale, '0'));
  return negative ? -n : n;
}
export function unscaled(value: bigint, scale: 4 | 6): string {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${text.slice(0, -scale)}.${text.slice(-scale)}`;
}
const same = isDeepStrictEqual;
const parties = (r: ContractRevisionInput) => [
  r.name,
  r.originalNumber,
  r.counterpartyRaw,
  r.selfPartyRaw,
  r.counterpartyCompanyId,
  r.selfCompanyId,
];
const dates = (r: ContractRevisionInput) => [
  r.signedOn,
  r.effectiveOn,
  r.registrationStatus,
];
const decimalAssertion = (v: ContractRevisionInput['total'], scale: 4 | 6) => [
  v.state,
  v.value === null ? null : scaled(v.value, scale).toString(),
];
const money = (r: ContractRevisionInput) => [
  decimalAssertion(r.total, 4),
  r.currency,
  r.taxBasis,
];
export const executionFields = (l: ContractLineInput) => [
  l.description,
  decimalAssertion(l.quantity, 6),
  l.unitRaw,
  l.unit,
  l.includes,
  l.excludes,
  l.removed,
];
const lineAssertion = (l: ContractLineInput) => [
  l.lineNo,
  ...executionFields(l),
  l.pricingType,
  l.amount,
  l.derivation,
];
export function executionChanged(
  a: ContractLineInput,
  b: ContractLineInput,
): boolean {
  return !same(executionFields(a), executionFields(b));
}

/** Source ownership is checked in the database too; this checks assertion provenance. */
export function validateRevision(
  next: ContractRevisionInput,
  previous: ContractRevisionInput | null,
): void {
  const docs = new Set(next.sources.map((s) => s.sourceDocumentId));
  if (
    !docs.size ||
    new Set(next.sources.map((s) => JSON.stringify(s))).size !==
      next.sources.length
  )
    throw new ContractRegisterError('SOURCE_INVALID');
  const bound = (loc: ContractLocation | null) => {
    if (!loc || !loc.location.trim() || !docs.has(loc.sourceDocumentId))
      throw new ContractRegisterError('SOURCE_INVALID');
  };
  for (const loc of [
    next.headLocs.parties,
    next.headLocs.dates,
    next.headLocs.total,
    ...next.lines.flatMap((l) => [l.source, l.removalSource]),
  ])
    if (loc) bound(loc);
  if (!previous) {
    bound(next.headLocs.parties);
    if (next.signedOn.state === 'VALUE' || next.effectiveOn.state === 'VALUE')
      bound(next.headLocs.dates);
    if (next.total.state === 'VALUE') bound(next.headLocs.total);
    for (const line of next.lines) {
      if (line.removed) throw new ContractRegisterError('SOURCE_INVALID');
      bound(line.source);
    }
    return;
  }
  if (previous.sources.some((s) => !docs.has(s.sourceDocumentId)))
    throw new ContractRegisterError('SOURCE_INVALID');
  for (const [oldValue, newValue, oldLoc, newLoc] of [
    [
      parties(previous),
      parties(next),
      previous.headLocs.parties,
      next.headLocs.parties,
    ],
    [
      dates(previous),
      dates(next),
      previous.headLocs.dates,
      next.headLocs.dates,
    ],
    [
      money(previous),
      money(next),
      previous.headLocs.total,
      next.headLocs.total,
    ],
  ] as const) {
    if (!same(oldValue, newValue)) bound(newLoc);
    else if (!same(oldLoc, newLoc))
      throw new ContractRegisterError('SOURCE_INVALID');
  }
  if (previous.lines.some((l) => !next.lines.some((n) => n.id === l.id)))
    throw new ContractRegisterError('LINE_MISSING');
  for (const line of next.lines) {
    const old = previous.lines.find((l) => l.id === line.id);
    if (!old || !same(lineAssertion(old), lineAssertion(line)))
      bound(line.source);
    else if (!same(old.source, line.source))
      throw new ContractRegisterError('SOURCE_INVALID');
    if (line.removed && (!old || !old.removed)) bound(line.removalSource);
    else if (
      old?.removed &&
      line.removed &&
      !same(old.removalSource, line.removalSource)
    )
      throw new ContractRegisterError('SOURCE_INVALID');
  }
}
export function needsCorrectionAttention(
  next: ContractRevisionInput,
  previous: ContractRevisionInput,
): boolean {
  if (
    !same(money(next), money(previous)) ||
    !same(parties(next).slice(2), parties(previous).slice(2))
  )
    return true;
  return next.lines.some((l) => {
    const old = previous.lines.find((o) => o.id === l.id);
    return old
      ? executionChanged(old, l) || !same(old.amount, l.amount)
      : l.amount.state === 'VALUE' || !l.removed;
  });
}
export interface StoredShare extends ContractShareInput {
  pinnedRevisionN: number;
  pinnedLine: ContractLineInput;
}
export interface Allocation {
  state: 'UNALLOCATED' | 'PARTIAL' | 'ALLOCATED' | 'UNQUANTIFIED' | 'RECONCILE';
  remaining: string | null;
}
/** Called inside the contract lock against all current shares, before any insertion. */
export function validateShares(
  line: ContractLineInput,
  current: readonly StoredShare[],
  updates: readonly ContractShareInput[],
): Allocation {
  const existing = new Map(current.map((s) => [s.scopeId, s]));
  for (const update of updates) {
    const old = existing.get(update.scopeId);
    if (
      old &&
      (old.projectId !== update.projectId ||
        old.expectedVersion !== update.expectedVersion)
    )
      throw new ContractRegisterError('VERSION_CONFLICT');
    if (!old && update.expectedVersion !== 0)
      throw new ContractRegisterError('VERSION_CONFLICT');
  }
  const active = current.filter((s) => !s.retired);
  // Atomic whole-line reconciliation on unit change, including every active old share.
  if (
    active.some(
      (s) =>
        s.pinnedLine.unit !== line.unit ||
        s.pinnedLine.unitRaw !== line.unitRaw,
    ) &&
    active.some((s) => !updates.some((u) => u.scopeId === s.scopeId))
  )
    throw new ContractRegisterError('RECONCILE_REQUIRED');
  const next = [
    ...current.filter((s) => !updates.some((u) => u.scopeId === s.scopeId)),
    ...updates,
  ].filter((s) => !s.retired);
  if (new Set(next.map((s) => s.projectId)).size !== next.length)
    throw new ContractRegisterError('SHARE_INVALID');
  if (line.removed && next.length)
    throw new ContractRegisterError('SHARE_INVALID');
  if (!next.length)
    return { state: 'UNALLOCATED', remaining: line.quantity.value };
  if (next.some((s) => s.basis === 'WHOLE')) {
    if (next.length !== 1) throw new ContractRegisterError('SHARE_INVALID');
    return { state: 'ALLOCATED', remaining: null };
  }
  const quantities = next.filter((s) => s.basis === 'QUANTITY');
  if (
    quantities.length &&
    (line.unit === null ||
      line.quantity.state !== 'VALUE' ||
      line.quantity.value === null)
  )
    throw new ContractRegisterError('SHARE_INVALID');
  const sum = quantities.reduce((n, s) => {
    const q = scaled(s.quantity ?? '', 6);
    if (q <= 0n) throw new ContractRegisterError('SHARE_INVALID');
    return n + q;
  }, 0n);
  const limit =
    line.quantity.value === null ? null : scaled(line.quantity.value, 6);
  if (limit !== null && sum > limit)
    throw new ContractRegisterError('SHARE_INVALID');
  if (
    current.some(
      (s) =>
        !s.retired &&
        !updates.some((u) => u.scopeId === s.scopeId) &&
        executionChanged(s.pinnedLine, line),
    )
  )
    return { state: 'RECONCILE', remaining: null };
  if (quantities.length !== next.length)
    return { state: 'UNQUANTIFIED', remaining: null };
  return {
    state: sum === limit ? 'ALLOCATED' : 'PARTIAL',
    remaining: unscaled(limit! - sum, 6),
  };
}
