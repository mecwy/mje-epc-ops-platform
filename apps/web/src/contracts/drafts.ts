import type {
  ContractEditorDto,
  ContractShareInput,
  ContractRevisionInput,
  CreateContractCommand,
  CorrectContractCommand,
} from '@mje/contracts';
export type ContractWrite =
  | { kind: 'create'; body: CreateContractCommand }
  | { kind: 'correct'; body: CorrectContractCommand };
export interface ContractDraft {
  identity: Pick<
    CreateContractCommand,
    'contractId' | 'code' | 'direction' | 'expenditureSubtype'
  >;
  version: number;
  baseline: ContractRevisionInput | null;
  revision: ContractRevisionInput;
  reason: string;
  unresolved: ContractWrite | null;
}
export function blankDraft(
  direction: CreateContractCommand['direction'],
  uuid: () => string,
): ContractDraft {
  return {
    identity: {
      contractId: uuid(),
      code: '',
      direction,
      expenditureSubtype: direction === 'INCOME' ? null : 'SUBCONTRACT',
    },
    version: 0,
    baseline: null,
    reason: '',
    unresolved: null,
    revision: {
      name: '',
      originalNumber: null,
      counterpartyRaw: null,
      selfPartyRaw: null,
      counterpartyCompanyId: null,
      selfCompanyId: null,
      informationOwnerPersonId: null,
      signedOn: { state: 'UNKNOWN', value: null },
      effectiveOn: { state: 'UNKNOWN', value: null },
      registrationStatus: 'SIGNED_PENDING',
      total: { state: 'UNKNOWN', value: null },
      currency: null,
      taxBasis: 'UNKNOWN',
      sources: [],
      headLocs: { parties: null, dates: null, total: null },
      lines: [],
    },
  };
}
export function correctionDraft(editor: ContractEditorDto): ContractDraft {
  return {
    identity: {
      contractId: editor.id,
      code: editor.code,
      direction: editor.direction,
      expenditureSubtype: editor.expenditureSubtype,
    },
    version: editor.version,
    baseline: structuredClone(editor.revision),
    revision: structuredClone(editor.revision),
    reason: '',
    unresolved: null,
  };
}
export function freezeWrite(draft: ContractDraft, key: string): ContractWrite {
  if (draft.version === 0)
    return {
      kind: 'create',
      body: structuredClone({
        ...draft.identity,
        expectedVersion: 0,
        clientMutationId: key,
        revision: draft.revision,
      }),
    };
  return {
    kind: 'correct',
    body: structuredClone({
      contractId: draft.identity.contractId,
      expectedVersion: draft.version,
      clientMutationId: key,
      reason: draft.reason,
      revision: draft.revision,
    }),
  };
}
export interface DraftStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
/** Account identity comes only from authenticated lookups, never Person, role or project selection. */
export class ContractDrafts {
  constructor(
    private storage: DraftStorage,
    readonly accountId: string,
  ) {}
  private key(id: string) {
    return `mje-contract-draft-v1:${this.accountId}:${id}`;
  }
  save(draft: ContractDraft) {
    this.storage.setItem(
      this.key(draft.identity.contractId),
      JSON.stringify(draft),
    );
    this.storage.setItem(this.key('last'), draft.identity.contractId);
  }
  last(): ContractDraft | null {
    try {
      const id = this.storage.getItem(this.key('last'));
      if (!id) return null;
      const raw = this.storage.getItem(this.key(id));
      if (!raw) return null;
      const draft = JSON.parse(raw) as ContractDraft;
      if (
        draft?.identity?.contractId !== id ||
        !draft.revision ||
        !Array.isArray(draft.revision.lines) ||
        !Number.isInteger(draft.version) ||
        draft.version < 0
      )
        return null;
      return draft;
    } catch {
      return null;
    }
  }
  remove(id: string) {
    this.storage.removeItem(this.key(id));
    if (this.storage.getItem(this.key('last')) === id)
      this.storage.removeItem(this.key('last'));
  }
}
const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => [key, normalized(v)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
export interface MergeChoice {
  key: string;
  mine: unknown;
  latest: unknown;
}
export interface ContractMerge {
  revision: ContractRevisionInput;
  conflicts: MergeChoice[];
}
/** Unedited assertions use latest; independently added lines and sources are retained. Conflicts require field choices; mixed line assertions require an explicit source choice. */
export function mergeRevision(
  base: ContractRevisionInput,
  mine: ContractRevisionInput,
  latest: ContractRevisionInput,
  choices: Record<string, 'mine' | 'latest'> = {},
): ContractMerge {
  const revision = structuredClone(latest),
    conflicts: MergeChoice[] = [];
  function choose(key: string, b: unknown, m: unknown, l: unknown): unknown {
    if (same(m, b)) return l;
    if (same(l, b) || same(m, l)) return m;
    if (choices[key]) return choices[key] === 'mine' ? m : l;
    conflicts.push({ key, mine: m, latest: l });
    return l;
  }
  const groups = {
    parties: [
      'name',
      'originalNumber',
      'counterpartyRaw',
      'selfPartyRaw',
      'counterpartyCompanyId',
      'selfCompanyId',
    ],
    dates: ['signedOn', 'effectiveOn', 'registrationStatus'],
    total: ['total', 'currency', 'taxBasis'],
  } as const;
  const grouped = new Set<string>(Object.values(groups).flat());
  for (const section of ['parties', 'dates', 'total'] as const) {
    const pack = (r: ContractRevisionInput) =>
      Object.fromEntries([
        ...groups[section].map((key) => [key, r[key]]),
        ['location', r.headLocs[section]],
      ]);
    const selected = choose(
      'header:' + section,
      pack(base),
      pack(mine),
      pack(latest),
    ) as Record<string, unknown>;
    for (const key of groups[section])
      Object.assign(revision, { [key]: structuredClone(selected[key]) });
    revision.headLocs[section] = structuredClone(
      selected['location'],
    ) as (typeof revision.headLocs)[typeof section];
  }
  for (const key of Object.keys(latest) as (keyof ContractRevisionInput)[]) {
    if (
      key === 'lines' ||
      key === 'sources' ||
      key === 'headLocs' ||
      grouped.has(key)
    )
      continue;
    Object.assign(revision, {
      [key]: structuredClone(choose(key, base[key], mine[key], latest[key])),
    });
  }
  revision.sources = [...latest.sources, ...mine.sources].filter(
    (s, i, a) => a.findIndex((x) => same(s, x)) === i,
  );
  const ids = [
    ...new Set([
      ...latest.lines.map((l) => l.id),
      ...mine.lines.map((l) => l.id),
      ...base.lines.map((l) => l.id),
    ]),
  ];
  revision.lines = ids.flatMap((id) => {
    const b = base.lines.find((l) => l.id === id),
      m = mine.lines.find((l) => l.id === id),
      l = latest.lines.find((l) => l.id === id);
    // Absence is never a removal instruction. Removal remains an explicit sourced assertion.
    if (!m) return l ? [structuredClone(l)] : b ? [structuredClone(b)] : [];
    if (!l) return [structuredClone(m)];
    if (
      b &&
      !same(m, l) &&
      ((m.removed !== b.removed && !same(l, b)) ||
        (l.removed !== b.removed && !same(m, b)))
    )
      return [structuredClone(choose('line:' + id, b, m, l)) as typeof l];
    const merged = structuredClone(l);
    for (const key of Object.keys(l) as (keyof typeof l)[]) {
      if (key === 'id') continue;
      Object.assign(merged, {
        [key]: structuredClone(
          choose('line:' + id + ':' + key, b?.[key], m[key], l[key]),
        ),
      });
    }
    const sourceKey = 'line:' + id + ':source';
    if (b && !same(m, b) && !same(l, b) && !same(m.source, l.source)) {
      if (choices[sourceKey])
        merged.source = structuredClone(
          choices[sourceKey] === 'mine' ? m.source : l.source,
        );
      else if (!conflicts.some((c) => c.key === sourceKey))
        conflicts.push({ key: sourceKey, mine: m.source, latest: l.source });
    }
    return [merged];
  });
  return { revision, conflicts };
}

/** Only explicitly confirmed rows advance their pinned version. Displayed history is not a command. */
export function confirmedShares(
  rows: readonly ContractShareInput[],
  confirmed: ReadonlySet<string>,
): ContractShareInput[] {
  return rows
    .filter((row) => confirmed.has(row.scopeId))
    .map((row) => structuredClone(row));
}
