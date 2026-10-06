import {
  obj,
  str,
  id,
  date,
  oneOf,
  version,
  InvalidReportInput,
} from './parse.js';
import {
  OPPORTUNITY_STATES,
  OPPORTUNITY_PARTY_ROLES,
  type OpportunityValue,
  type OpportunityScale,
  type OpportunityFacts,
  type OpportunityOccurrence,
  type OpportunitySource,
  type OpportunityNextStepChange,
  type OpportunityFieldChange,
  type CreateOpportunityCommand,
  type UpdateOpportunityCommand,
  type RequestOpportunityDecisionCommand,
  type RecordOpportunityDecisionCommand,
  type OpportunityDecisionState,
} from './opportunity.js';
function exact(v: unknown, f: string, fields: readonly string[]) {
  const o = obj(v, f);
  if (
    Object.keys(o).some((k) => !fields.includes(k)) ||
    fields.some((k) => !Object.hasOwn(o, k))
  )
    throw new InvalidReportInput(f);
  return o;
}
function text(v: unknown, f: string, max = 4000) {
  const s = str(v, f, max);
  if (!s.trim()) throw new InvalidReportInput(f);
  return s;
}
function nullableText(v: unknown, f: string, max = 4000) {
  return v === null ? null : str(v, f, max);
}
function nullableId(v: unknown, f: string) {
  return v === null ? null : id(v, f);
}
function list(v: unknown, f: string, max = 100): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new InvalidReportInput(f);
  return v;
}
function unique<T>(rows: T[], key: (x: T) => string, f: string): T[] {
  if (new Set(rows.map(key)).size !== rows.length)
    throw new InvalidReportInput(f);
  return rows;
}
function bool(v: unknown, f: string) {
  if (typeof v !== 'boolean') throw new InvalidReportInput(f);
  return v;
}
function value(
  v: unknown,
  f: string,
  kind: 'text' | 'date' | 'quantity' = 'text',
): OpportunityValue {
  const o = exact(v, f, ['state', 'value']),
    state = oneOf(o['state'], OPPORTUNITY_STATES, f);
  if (state !== 'VALUE') {
    if (o['value'] !== null) throw new InvalidReportInput(f);
    return { state, value: null };
  }
  const raw =
    kind === 'date'
      ? date(o['value'], f)
      : text(o['value'], f, kind === 'quantity' ? 32 : 4000);
  if (kind === 'quantity' && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(raw))
    throw new InvalidReportInput(f);
  return { state, value: raw };
}
function scale(v: unknown, f: string): OpportunityScale {
  const o = exact(v, f, ['value', 'unitRaw', 'basis']);
  const s = {
    value: value(o['value'], f + '.value', 'quantity'),
    unitRaw: nullableText(o['unitRaw'], f + '.unit', 80),
    basis: value(o['basis'], f + '.basis'),
  };
  if (s.value.state === 'VALUE' && !s.unitRaw?.trim())
    throw new InvalidReportInput(f + '.unit');
  return s;
}
function occurrence(v: unknown): OpportunityOccurrence {
  const f = 'occurrence',
    o = exact(v, f, ['occurredAt', 'timezone', 'businessDate']);
  const at = nullableText(o['occurredAt'], f, 40),
    zone = nullableText(o['timezone'], f, 80),
    day = o['businessDate'] === null ? null : date(o['businessDate'], f);
  if (
    at !== null &&
    (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(at) ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString().slice(0, 19) !== at.slice(0, 19))
  )
    throw new InvalidReportInput(f);
  if (zone !== null) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw new InvalidReportInput(f);
    }
  }
  if (at !== null && !zone) throw new InvalidReportInput(f);
  return { occurredAt: at, timezone: zone, businessDate: day };
}
function sources(v: unknown): OpportunitySource[] {
  return unique(
    list(v, 'sources').map((v) => {
      const o = exact(v, 'source', [
        'sourceDocumentId',
        'reference',
        'location',
      ]);
      return {
        sourceDocumentId: nullableId(o['sourceDocumentId'], 'source.id'),
        reference: text(o['reference'], 'source.reference', 1000),
        location: text(o['location'], 'source.location', 1000),
      };
    }),
    (s) => (s.sourceDocumentId ?? '') + '\0' + s.reference + '\0' + s.location,
    'sources',
  );
}
const factsKeys = [
  'name',
  'businessLine',
  'customerGroup',
  'informationOwnerPersonId',
  'assistantPersonIds',
  'parties',
  'ownerProject',
  'proposedScopes',
  'dates',
  'stageRaw',
  'probabilityRaw',
  'mustWinRaw',
  'internalNote',
] as const;
function field<K extends keyof OpportunityFacts>(
  k: K,
  v: unknown,
): OpportunityFacts[K] {
  const f = 'facts.' + k;
  let out: OpportunityFacts[keyof OpportunityFacts];
  switch (k) {
    case 'name':
      out = text(v, f, 300);
      break;
    case 'informationOwnerPersonId':
      out = nullableId(v, f);
      break;
    case 'assistantPersonIds':
      out = unique(
        list(v, f, 30).map((x) => id(x, f)),
        (x) => x,
        f,
      );
      break;
    case 'parties':
      out = unique(
        list(v, f).map((x) => {
          const o = exact(x, f, ['id', 'role', 'rawName', 'companyId']);
          return {
            id: id(o['id'], f),
            role: oneOf(o['role'], OPPORTUNITY_PARTY_ROLES, f),
            rawName: value(o['rawName'], f),
            companyId: nullableId(o['companyId'], f),
          };
        }),
        (x) => x.id,
        f,
      );
      break;
    case 'ownerProject': {
      const o = exact(v, f, [
        'projectType',
        'country',
        'city',
        'reportedScale',
        'conditions',
      ]);
      out = {
        projectType: value(o['projectType'], f),
        country: value(o['country'], f),
        city: value(o['city'], f),
        reportedScale: scale(o['reportedScale'], f),
        conditions: unique(
          list(o['conditions'], f).map((x) => {
            const c = exact(x, f, [
              'id',
              'summary',
              'responsibleRaw',
              'status',
              'basis',
            ]);
            return {
              id: id(c['id'], f),
              summary: text(c['summary'], f, 1000),
              responsibleRaw: value(c['responsibleRaw'], f),
              status: oneOf(
                c['status'],
                ['UNMET', 'MET', 'NA', 'UNKNOWN', 'NOT_STATED'] as const,
                f,
              ),
              basis: nullableText(c['basis'], f),
            };
          }),
          (x) => x.id,
          f,
        ),
      };
      break;
    }
    case 'proposedScopes':
      out = unique(
        list(v, f).map((x) => {
          const o = exact(x, f, ['id', 'roleRaw', 'summary', 'scale']);
          return {
            id: id(o['id'], f),
            roleRaw: value(o['roleRaw'], f),
            summary: value(o['summary'], f),
            scale: scale(o['scale'], f),
          };
        }),
        (x) => x.id,
        f,
      );
      break;
    case 'dates': {
      const o = exact(v, f, [
        'tender',
        'expectedSigning',
        'expectedStart',
        'expectedCompletion',
      ]);
      out = {
        tender: value(o['tender'], f, 'date'),
        expectedSigning: value(o['expectedSigning'], f, 'date'),
        expectedStart: value(o['expectedStart'], f, 'date'),
        expectedCompletion: value(o['expectedCompletion'], f, 'date'),
      };
      break;
    }
    default:
      out = value(v, f);
      if (
        k === 'customerGroup' &&
        out.state === 'VALUE' &&
        !['INTERNAL', 'EXTERNAL'].includes(out.value!)
      )
        throw new InvalidReportInput(f);
      if (k === 'businessLine' && out.value !== null && out.value.length > 80)
        throw new InvalidReportInput(f);
      break;
  }
  return out as OpportunityFacts[K];
}
export function parseOpportunityFacts(v: unknown): OpportunityFacts {
  const o = exact(v, 'facts', factsKeys);
  return {
    name: field('name', o['name']),
    businessLine: field('businessLine', o['businessLine']),
    customerGroup: field('customerGroup', o['customerGroup']),
    informationOwnerPersonId: field(
      'informationOwnerPersonId',
      o['informationOwnerPersonId'],
    ),
    assistantPersonIds: field('assistantPersonIds', o['assistantPersonIds']),
    parties: field('parties', o['parties']),
    ownerProject: field('ownerProject', o['ownerProject']),
    proposedScopes: field('proposedScopes', o['proposedScopes']),
    dates: field('dates', o['dates']),
    stageRaw: field('stageRaw', o['stageRaw']),
    probabilityRaw: field('probabilityRaw', o['probabilityRaw']),
    mustWinRaw: field('mustWinRaw', o['mustWinRaw']),
    internalNote: field('internalNote', o['internalNote']),
  };
}
export function blankOpportunityFacts(name: string): OpportunityFacts {
  const blank = (): OpportunityValue => ({ state: 'BLANK', value: null }),
    unknown = (): OpportunityValue => ({ state: 'UNKNOWN', value: null });
  return {
    name,
    businessLine: blank(),
    customerGroup: blank(),
    informationOwnerPersonId: null,
    assistantPersonIds: [],
    parties: [],
    ownerProject: {
      projectType: blank(),
      country: blank(),
      city: blank(),
      reportedScale: { value: unknown(), unitRaw: null, basis: blank() },
      conditions: [],
    },
    proposedScopes: [],
    dates: {
      tender: unknown(),
      expectedSigning: unknown(),
      expectedStart: unknown(),
      expectedCompletion: unknown(),
    },
    stageRaw: blank(),
    probabilityRaw: blank(),
    mustWinRaw: blank(),
    internalNote: blank(),
  };
}
function nextStep(v: unknown): OpportunityNextStepChange {
  const f = 'nextStep',
    raw = obj(v, f),
    mode = oneOf(
      raw['mode'],
      ['KEEP', 'REPLACE', 'COMPLETE_AND_ADD'] as const,
      f,
    );
  if (mode === 'KEEP') {
    exact(raw, f, ['mode']);
    return { mode };
  }
  const o = exact(raw, f, ['mode', 'baseStepId', 'next']),
    n = exact(o['next'], f, ['id', 'action', 'ownerPersonId', 'dueOn']);
  return {
    mode,
    baseStepId: nullableId(o['baseStepId'], f),
    next: {
      id: id(n['id'], f),
      action: text(n['action'], f, 1000),
      ownerPersonId: nullableId(n['ownerPersonId'], f),
      dueOn: value(n['dueOn'], f, 'date'),
    },
  };
}
export function parseCreateOpportunity(v: unknown): CreateOpportunityCommand {
  const o = exact(v, 'create', [
    'opportunityId',
    'clientMutationId',
    'expectedVersion',
    'code',
    'facts',
    'sources',
  ]);
  if (version(o['expectedVersion'], 'expectedVersion') !== 0)
    throw new InvalidReportInput('expectedVersion');
  const code = nullableText(o['code'], 'code', 80);
  if (code !== null && !code.trim()) throw new InvalidReportInput('code');
  return {
    opportunityId: id(o['opportunityId'], 'opportunityId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedVersion: 0,
    code,
    facts: parseOpportunityFacts(o['facts']),
    sources: sources(o['sources']),
  };
}
export function parseUpdateOpportunity(v: unknown): UpdateOpportunityCommand {
  const o = exact(v, 'update', [
    'opportunityId',
    'clientMutationId',
    'expectedVersion',
    'newFact',
    'noMaterialChange',
    'evidence',
    'obstacle',
    'occurrence',
    'sources',
    'changes',
    'nextStep',
  ]);
  const newFact = o['newFact'] === null ? null : text(o['newFact'], 'newFact'),
    noMaterialChange = bool(o['noMaterialChange'], 'noMaterialChange');
  if ((newFact !== null) === noMaterialChange)
    throw new InvalidReportInput('newFact');
  const changes = unique(
    list(o['changes'], 'changes', factsKeys.length).map((x) => {
      const c = exact(x, 'change', [
          'field',
          'before',
          'after',
          'reason',
          'basis',
        ]),
        key = oneOf(c['field'], factsKeys, 'change.field');
      return {
        field: key,
        before: field(key, c['before']),
        after: field(key, c['after']),
        reason: str(c['reason'], 'change.reason'),
        basis: nullableText(c['basis'], 'change.basis'),
      } as OpportunityFieldChange;
    }),
    (x) => x.field,
    'changes',
  );
  const expectedVersion =
    o['expectedVersion'] === null
      ? null
      : version(o['expectedVersion'], 'expectedVersion');
  if (changes.length && expectedVersion === null)
    throw new InvalidReportInput('expectedVersion');
  return {
    opportunityId: id(o['opportunityId'], 'opportunityId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedVersion,
    newFact,
    noMaterialChange,
    evidence: nullableText(o['evidence'], 'evidence'),
    obstacle: nullableText(o['obstacle'], 'obstacle'),
    occurrence: occurrence(o['occurrence']),
    sources: sources(o['sources']),
    changes,
    nextStep: nextStep(o['nextStep']),
  };
}
export function parseRequestOpportunityDecision(
  v: unknown,
): RequestOpportunityDecisionCommand {
  const o = exact(v, 'request', [
    'opportunityId',
    'clientMutationId',
    'expectedRequestId',
    'requestId',
    'requestedPersonId',
    'explanation',
    'dueOn',
    'sources',
  ]);
  return {
    opportunityId: id(o['opportunityId'], 'opportunityId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedRequestId: nullableId(o['expectedRequestId'], 'expectedRequestId'),
    requestId: id(o['requestId'], 'requestId'),
    requestedPersonId: nullableId(o['requestedPersonId'], 'requestedPersonId'),
    explanation: text(o['explanation'], 'explanation'),
    dueOn: value(o['dueOn'], 'dueOn', 'date'),
    sources: sources(o['sources']),
  };
}
export function parseOpportunityDecisionState(
  v: unknown,
): OpportunityDecisionState {
  const o = exact(v, 'decision', [
      'kind',
      'resumeCondition',
      'reviewOn',
      'exitReason',
      'reentryCondition',
    ]),
    kind = oneOf(
      o['kind'],
      ['CONTINUE', 'PAUSE', 'EXIT'] as const,
      'decision.kind',
    );
  const result = {
    kind,
    resumeCondition: nullableText(o['resumeCondition'], 'resumeCondition'),
    reviewOn: value(o['reviewOn'], 'reviewOn', 'date'),
    exitReason: nullableText(o['exitReason'], 'exitReason'),
    reentryCondition: nullableText(o['reentryCondition'], 'reentryCondition'),
  };
  if (
    kind === 'CONTINUE' &&
    (result.resumeCondition !== null ||
      result.exitReason !== null ||
      result.reentryCondition !== null ||
      result.reviewOn.state === 'VALUE')
  )
    throw new InvalidReportInput('decision');
  if (
    kind === 'PAUSE' &&
    (result.exitReason !== null || result.reentryCondition !== null)
  )
    throw new InvalidReportInput('decision');
  if (
    kind === 'EXIT' &&
    (!result.exitReason?.trim() ||
      result.resumeCondition !== null ||
      result.reviewOn.state === 'VALUE')
  )
    throw new InvalidReportInput('decision');
  return result;
}
export function parseRecordOpportunityDecision(
  v: unknown,
): RecordOpportunityDecisionCommand {
  const o = exact(v, 'decisionRecord', [
    'opportunityId',
    'clientMutationId',
    'expectedDecisionVersion',
    'expectedRequestId',
    'actualDecisionPersonId',
    'decision',
    'recordText',
    'basis',
    'occurrence',
    'proxy',
    'sources',
  ]);
  const p =
    o['proxy'] === null
      ? null
      : exact(o['proxy'], 'proxy', ['basis', 'from', 'until']);
  const proxy = p
    ? {
        basis: text(p['basis'], 'proxy.basis'),
        from: value(p['from'], 'proxy.from', 'date'),
        until: value(p['until'], 'proxy.until', 'date'),
      }
    : null;
  if (
    proxy?.from.value &&
    proxy.until.value &&
    proxy.from.value > proxy.until.value
  )
    throw new InvalidReportInput('proxy.period');
  return {
    opportunityId: id(o['opportunityId'], 'opportunityId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedDecisionVersion: version(
      o['expectedDecisionVersion'],
      'expectedDecisionVersion',
    ),
    expectedRequestId: nullableId(o['expectedRequestId'], 'expectedRequestId'),
    actualDecisionPersonId: id(
      o['actualDecisionPersonId'],
      'actualDecisionPersonId',
    ),
    decision: parseOpportunityDecisionState(o['decision']),
    recordText: text(o['recordText'], 'recordText'),
    basis: text(o['basis'], 'basis'),
    occurrence: occurrence(o['occurrence']),
    proxy,
    sources: sources(o['sources']),
  };
}
