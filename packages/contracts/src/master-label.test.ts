import { describe, expect, it } from 'vitest';
import {
  parseMasterLabelDto,
  parseMasterLabelProposal,
  presentMasterLabel,
} from './master-label.js';

const conceptId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const original = {
  name: '  TEST 支架\nTEST-M42 2.5 kg  ',
  language: 'zh',
  revision: 1,
  captureStatus: 'SOURCE_CAPTURED',
  source: { kind: 'DOCUMENT', reference: '  TEST document/table 2/cell A3  ' },
};
const master = { conceptId, kind: 'material', original };
const ai = {
  kind: 'AI_CANDIDATE',
  candidateId: otherId,
  adapterVersion: 'TEST-fake-v1',
};
const candidate = {
  text: 'TEST bracket',
  sourceRevision: 1,
  status: 'PENDING_REVIEW',
  provenance: ai,
};
const confirmed = {
  ...candidate,
  status: 'CONFIRMED',
  reviewedByPersonId: otherId,
  reviewedAt: '2030-01-02T03:04:05Z',
};
const proposal = {
  conceptId,
  kind: 'material',
  sourceRevision: 1,
  language: 'en',
  text: 'TEST bracket',
  provenance: { kind: 'MANUAL' },
};

describe('master names without a translation provider', () => {
  it('accepts Chinese-only data and keeps English fallback visibly pending', () => {
    const parsed = parseMasterLabelDto(master);
    expect(presentMasterLabel(parsed, 'en')).toEqual({
      text: original.name,
      language: 'zh',
      status: 'TRANSLATION_NEEDED',
    });
    expect(presentMasterLabel(parsed, 'zh').status).toBe('ORIGINAL');
    expect(parsed).not.toHaveProperty('labels');
  });

  it('retains exact source whitespace, codes, numbers and units without mutation', () => {
    const before = structuredClone(master);
    const parsed = parseMasterLabelDto(master);
    expect(parsed.original).toEqual(original);
    presentMasterLabel(parsed, 'en');
    expect(master).toEqual(before);
    expect(parsed.original.name).toBe(original.name);
    expect(parsed.original.source.reference).toBe(original.source.reference);
  });

  it('renders confirmed English while retaining the original and a newer candidate', () => {
    const parsed = parseMasterLabelDto({
      ...master,
      labels: { en: confirmed },
      englishCandidate: { ...candidate, text: 'TEST proposed alternative' },
    });
    expect(presentMasterLabel(parsed, 'en')).toEqual({
      text: 'TEST bracket',
      language: 'en',
      status: 'CONFIRMED',
    });
    expect(parsed.original.name).toBe(original.name);
    expect(presentMasterLabel(parsed, 'zh').text).toBe(original.name);
  });

  it('never presents an AI candidate as a confirmed English name', () => {
    const parsed = parseMasterLabelDto({
      ...master,
      englishCandidate: candidate,
    });
    expect(parsed.englishCandidate?.status).toBe('PENDING_REVIEW');
    expect(presentMasterLabel(parsed, 'en').status).toBe('TRANSLATION_NEEDED');
    expect(presentMasterLabel(parsed, 'en').text).toBe(original.name);
  });

  it('retains distinct material and work identities even when names coincide', () => {
    const material = parseMasterLabelDto(master);
    const work = parseMasterLabelDto({
      ...master,
      conceptId: otherId,
      kind: 'work',
    });
    expect(material.conceptId).not.toBe(work.conceptId);
    expect(material.kind).toBe('material');
    expect(work.kind).toBe('work');
    expect(parseMasterLabelDto({ ...master, kind: 'machinery' }).kind).toBe(
      'machinery',
    );
    expect(() =>
      parseMasterLabelDto({ ...master, kind: 'material-work' }),
    ).toThrow();
  });

  it('marks legacy captured labels honestly, without reconstructing original bytes', () => {
    const legacy = {
      ...original,
      name: 'TEST legacy trimmed label',
      captureStatus: 'LEGACY_CAPTURED',
      source: { kind: 'LEGACY_REPORT', reference: 'TEST legacy report label' },
    };
    expect(
      parseMasterLabelDto({ ...master, original: legacy }).original,
    ).toEqual(legacy);
    for (const source of [
      { ...legacy, captureStatus: 'SOURCE_CAPTURED' },
      { ...original, captureStatus: 'LEGACY_CAPTURED' },
    ])
      expect(() =>
        parseMasterLabelDto({ ...master, original: source }),
      ).toThrow();
  });

  it('keeps unknown source language explicit and does not invent an NA name field', () => {
    const parsed = parseMasterLabelDto({
      ...master,
      original: { ...original, language: 'unknown' },
    });
    expect(presentMasterLabel(parsed, 'en').language).toBe('unknown');
    for (const language of [null, '', 'NA', 'es'])
      expect(() =>
        parseMasterLabelDto({ ...master, original: { ...original, language } }),
      ).toThrow();
  });

  it('supports curated Chinese and all explicit provenance variants on read DTOs', () => {
    for (const provenance of [
      { kind: 'MANUAL' },
      { kind: 'SUPPLIER', sourceRef: 'TEST supplier sheet' },
      { kind: 'CONFIRMED_GLOSSARY', entryId: otherId, entryVersion: 1 },
      ai,
    ]) {
      const parsed = parseMasterLabelDto({
        ...master,
        labels: { zh: { ...confirmed, provenance, text: 'TEST 已确认名称' } },
      });
      expect(presentMasterLabel(parsed, 'zh')).toEqual({
        text: 'TEST 已确认名称',
        language: 'zh',
        status: 'CONFIRMED',
      });
    }
  });

  it('rejects incomplete, impossible or stale review metadata and mismatched provenance', () => {
    for (const patch of [
      { status: 'PENDING_REVIEW' },
      { reviewedByPersonId: undefined },
      { reviewedByPersonId: 'not-a-person-id' },
      { reviewedAt: undefined },
      { reviewedAt: '2030-02-30T03:04:05Z' },
      { sourceRevision: 2 },
      { provenance: { kind: 'AI_CANDIDATE' } },
      { provenance: { kind: 'MANUAL', candidateId: otherId } },
      { provenance: { kind: 'SUPPLIER' } },
      {
        provenance: {
          kind: 'CONFIRMED_GLOSSARY',
          entryId: otherId,
          entryVersion: 0,
        },
      },
      {
        provenance: {
          kind: 'AI_CANDIDATE',
          candidateId: otherId,
          adapterVersion: ' ',
        },
      },
    ])
      expect(() =>
        parseMasterLabelDto({
          ...master,
          labels: { en: { ...confirmed, ...patch } },
        }),
      ).toThrow();
    expect(() =>
      parseMasterLabelDto({ ...master, englishCandidate: confirmed }),
    ).toThrow();
    expect(() =>
      parseMasterLabelDto({
        ...master,
        englishCandidate: { ...candidate, sourceRevision: 2 },
      }),
    ).toThrow();
  });

  it('accepts human proposals but rejects client-invented approval or trusted origins', () => {
    expect(parseMasterLabelProposal(proposal)).toEqual(proposal);
    expect(
      parseMasterLabelProposal({
        ...proposal,
        provenance: { kind: 'SUPPLIER', sourceRef: 'TEST sheet' },
      }).provenance.kind,
    ).toBe('SUPPLIER');
    for (const patch of [
      { status: 'CONFIRMED' },
      { reviewedByPersonId: otherId },
      { reviewedAt: '2030-01-02T03:04:05Z' },
      { role: 'ADMIN' },
      { labels: { en: confirmed } },
      { provenance: ai },
      {
        provenance: {
          kind: 'CONFIRMED_GLOSSARY',
          entryId: otherId,
          entryVersion: 1,
        },
      },
    ])
      expect(() =>
        parseMasterLabelProposal({ ...proposal, ...patch }),
      ).toThrow();
  });

  it('rejects unknown fields, blank names and invalid identifiers without echoing text', () => {
    for (const patch of [
      { conceptId: 'TEST-not-uuid' },
      { orgId: otherId },
      { modelCode: 'TEST-M42' },
      { labels: null },
      { labels: undefined },
      { labels: { en: null } },
      { labels: { es: confirmed } },
      { englishCandidate: undefined },
      { original: { ...original, name: ' \n ' } },
      { original: { ...original, revision: 0 } },
      {
        original: {
          ...original,
          source: { ...original.source, invented: true },
        },
      },
    ])
      expect(() => parseMasterLabelDto({ ...master, ...patch })).toThrow();
    expect(() =>
      parseMasterLabelDto({ ...master, 'TEST secret text': true }),
    ).toThrow('Invalid field: masterLabel');
  });
});
