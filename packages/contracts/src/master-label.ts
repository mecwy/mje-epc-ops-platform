/** Pure name contracts. Decoding persisted review metadata never grants authority. */
import { InvalidReportInput, id, obj, oneOf, str, version } from './parse.js';
import { isRealTimestamp } from './report.js';

/** `work` means an installation/work item, distinct from its material. */
export type MasterLabelKind = 'material' | 'work' | 'machinery';
export type MasterLabelLanguage = 'zh' | 'en';
export type MasterLabelProvenance =
  | { kind: 'MANUAL' }
  | { kind: 'SUPPLIER'; sourceRef: string }
  | { kind: 'CONFIRMED_GLOSSARY'; entryId: string; entryVersion: number }
  | { kind: 'AI_CANDIDATE'; candidateId: string; adapterVersion: string };

export interface OriginalMasterName {
  /** Preserved exactly as captured; never trimmed or translated. */
  name: string;
  language: MasterLabelLanguage | 'unknown';
  revision: number;
  captureStatus: 'SOURCE_CAPTURED' | 'LEGACY_CAPTURED';
  source: {
    kind: 'MANUAL' | 'SUPPLIER' | 'DOCUMENT' | 'LEGACY_REPORT';
    reference: string;
  };
}
export interface PendingMasterLabel {
  text: string;
  sourceRevision: number;
  status: 'PENDING_REVIEW';
  provenance: MasterLabelProvenance;
}
export interface ConfirmedMasterLabel {
  text: string;
  sourceRevision: number;
  status: 'CONFIRMED';
  provenance: MasterLabelProvenance;
  /** A server-authored record, not a client assertion of approval. */
  reviewedByPersonId: string;
  reviewedAt: string;
}
export interface MasterLabelDto {
  conceptId: string;
  kind: MasterLabelKind;
  original: OriginalMasterName;
  labels?: { zh?: ConfirmedMasterLabel; en?: ConfirmedMasterLabel };
  englishCandidate?: PendingMasterLabel;
}
/** Client proposal only. Server/provider-authored provenance is not accepted here. */
export interface MasterLabelProposal {
  conceptId: string;
  kind: MasterLabelKind;
  sourceRevision: number;
  language: MasterLabelLanguage;
  text: string;
  provenance: Extract<MasterLabelProvenance, { kind: 'MANUAL' | 'SUPPLIER' }>;
}

function keys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  if (Object.keys(o).some((key) => !allowed.includes(key)))
    throw new InvalidReportInput(field);
}
function text(value: unknown, field: string): string {
  const result = str(value, field);
  if (!result.trim()) throw new InvalidReportInput(field);
  return result;
}
function revision(value: unknown, field: string): number {
  const result = version(value, field);
  if (result === 0) throw new InvalidReportInput(field);
  return result;
}
function kind(value: unknown): MasterLabelKind {
  return oneOf(value, ['material', 'work', 'machinery'] as const, 'kind');
}
function provenance(value: unknown): MasterLabelProvenance {
  const o = obj(value, 'provenance');
  switch (o['kind']) {
    case 'MANUAL':
      keys(o, ['kind'], 'provenance');
      return { kind: 'MANUAL' };
    case 'SUPPLIER':
      keys(o, ['kind', 'sourceRef'], 'provenance');
      return { kind: 'SUPPLIER', sourceRef: text(o['sourceRef'], 'sourceRef') };
    case 'CONFIRMED_GLOSSARY':
      keys(o, ['kind', 'entryId', 'entryVersion'], 'provenance');
      return {
        kind: 'CONFIRMED_GLOSSARY',
        entryId: id(o['entryId'], 'entryId'),
        entryVersion: revision(o['entryVersion'], 'entryVersion'),
      };
    case 'AI_CANDIDATE':
      keys(o, ['kind', 'candidateId', 'adapterVersion'], 'provenance');
      return {
        kind: 'AI_CANDIDATE',
        candidateId: id(o['candidateId'], 'candidateId'),
        adapterVersion: text(o['adapterVersion'], 'adapterVersion'),
      };
    default:
      throw new InvalidReportInput('provenance');
  }
}
function original(value: unknown): OriginalMasterName {
  const o = obj(value, 'original');
  keys(
    o,
    ['name', 'language', 'revision', 'captureStatus', 'source'],
    'original',
  );
  const source = obj(o['source'], 'source');
  keys(source, ['kind', 'reference'], 'source');
  const sourceKind = oneOf(
    source['kind'],
    ['MANUAL', 'SUPPLIER', 'DOCUMENT', 'LEGACY_REPORT'] as const,
    'source.kind',
  );
  const captureStatus = oneOf(
    o['captureStatus'],
    ['SOURCE_CAPTURED', 'LEGACY_CAPTURED'] as const,
    'captureStatus',
  );
  if (
    (sourceKind === 'LEGACY_REPORT') !==
    (captureStatus === 'LEGACY_CAPTURED')
  )
    throw new InvalidReportInput('captureStatus');
  return {
    name: text(o['name'], 'original.name'),
    language: oneOf(
      o['language'],
      ['zh', 'en', 'unknown'] as const,
      'language',
    ),
    revision: revision(o['revision'], 'original.revision'),
    captureStatus,
    source: {
      kind: sourceKind,
      reference: text(source['reference'], 'reference'),
    },
  };
}
function localized(
  value: unknown,
  sourceRevision: number,
  confirmed: true,
): ConfirmedMasterLabel;
function localized(
  value: unknown,
  sourceRevision: number,
  confirmed: false,
): PendingMasterLabel;
function localized(
  value: unknown,
  sourceRevision: number,
  confirmed: boolean,
): ConfirmedMasterLabel | PendingMasterLabel {
  const o = obj(value, 'localizedLabel');
  keys(
    o,
    [
      'text',
      'sourceRevision',
      'status',
      'provenance',
      ...(confirmed ? ['reviewedByPersonId', 'reviewedAt'] : []),
    ],
    'localizedLabel',
  );
  if (revision(o['sourceRevision'], 'sourceRevision') !== sourceRevision)
    throw new InvalidReportInput('sourceRevision');
  const common = {
    text: text(o['text'], 'localizedLabel.text'),
    sourceRevision,
    provenance: provenance(o['provenance']),
  };
  if (!confirmed) {
    oneOf(o['status'], ['PENDING_REVIEW'] as const, 'status');
    return { ...common, status: 'PENDING_REVIEW' };
  }
  oneOf(o['status'], ['CONFIRMED'] as const, 'status');
  const reviewedAt = str(o['reviewedAt'], 'reviewedAt', 40);
  if (!isRealTimestamp(reviewedAt)) throw new InvalidReportInput('reviewedAt');
  return {
    ...common,
    status: 'CONFIRMED',
    reviewedByPersonId: id(o['reviewedByPersonId'], 'reviewedByPersonId'),
    reviewedAt,
  };
}

/** Decode a stored/read DTO, not an approval command. The server must verify provenance. */
export function parseMasterLabelDto(value: unknown): MasterLabelDto {
  const o = obj(value, 'masterLabel');
  keys(
    o,
    ['conceptId', 'kind', 'original', 'labels', 'englishCandidate'],
    'masterLabel',
  );
  const source = original(o['original']);
  const result: MasterLabelDto = {
    conceptId: id(o['conceptId'], 'conceptId'),
    kind: kind(o['kind']),
    original: source,
  };
  if (Object.hasOwn(o, 'labels')) {
    const labels = obj(o['labels'], 'labels');
    keys(labels, ['zh', 'en'], 'labels');
    result.labels = {};
    for (const language of ['zh', 'en'] as const)
      if (Object.hasOwn(labels, language))
        result.labels[language] = localized(
          labels[language],
          source.revision,
          true,
        );
  }
  if (Object.hasOwn(o, 'englishCandidate'))
    result.englishCandidate = localized(
      o['englishCandidate'],
      source.revision,
      false,
    );
  return result;
}

/** A proposal cannot supply a reviewer, approval status, AI origin or glossary approval. */
export function parseMasterLabelProposal(value: unknown): MasterLabelProposal {
  const o = obj(value, 'proposal');
  keys(
    o,
    ['conceptId', 'kind', 'sourceRevision', 'language', 'text', 'provenance'],
    'proposal',
  );
  const origin = provenance(o['provenance']);
  if (origin.kind !== 'MANUAL' && origin.kind !== 'SUPPLIER')
    throw new InvalidReportInput('provenance');
  return {
    conceptId: id(o['conceptId'], 'conceptId'),
    kind: kind(o['kind']),
    sourceRevision: revision(o['sourceRevision'], 'sourceRevision'),
    language: oneOf(o['language'], ['zh', 'en'] as const, 'language'),
    text: text(o['text'], 'text'),
    provenance: origin,
  };
}

export interface MasterLabelPresentation {
  text: string;
  language: OriginalMasterName['language'];
  status: 'CONFIRMED' | 'ORIGINAL' | 'TRANSLATION_NEEDED';
}
/** Names only: this function has no model, quantity or unit fields to translate. */
export function presentMasterLabel(
  master: MasterLabelDto,
  language: MasterLabelLanguage,
): MasterLabelPresentation {
  const label = master.labels?.[language];
  if (label) return { text: label.text, language, status: 'CONFIRMED' };
  return {
    text: master.original.name,
    language: master.original.language,
    status:
      master.original.language === language ? 'ORIGINAL' : 'TRANSLATION_NEEDED',
  };
}
