import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  parseFacts,
  parseNoWorkCommand,
  parseSaveFactsCommand,
  parseSavePlanDraftCommand,
  parseStartCorrectionCommand,
  reported,
} from './report.js';

const ID = '10000000-0000-4000-8000-00000000000';
const facts = () => ({
  weather: '多云',
  temperature: '12–20℃',
  qty: { support: '260', rail: '' },
  cumulative: { support: '5380' },
  narrative: { construction: 'TEST', quality: '', safety: '' },
  people: { manager: '1', installer: 'unknown' },
  presence: { W1: 'present' },
  machinery: { boomLift: '1', crane: '0' },
  materials: { rail: 'na' },
  milestones: { msSupport: { actual: '', note: '' } },
  noWork: null,
  updated: { support: '2026-09-29T14:20:00Z' },
});

describe('report contracts', () => {
  it('keeps blank, zero, tokens and decimals distinct; normalizes a comma decimal', () => {
    expect(reported('', 'x')).toBe('');
    expect(reported('0', 'x')).toBe('0');
    expect(reported('unknown', 'x')).toBe('unknown');
    expect(reported('12,5', 'x')).toBe('12.5');
    expect(() => reported('18O', 'x')).toThrow(InvalidReportInput);
    expect(() => reported('-1', 'x')).toThrow(InvalidReportInput);
  });
  it('parses facts exactly and rejects unknown roles, bad dates and bad keys', () => {
    expect(parseFacts(facts())).toEqual(facts());
    expect(() => parseFacts({ ...facts(), people: { boss: '1' } })).toThrow(
      'facts.people.boss',
    );
    expect(() =>
      parseFacts({
        ...facts(),
        milestones: { m: { actual: '2026-13-01', note: '' } },
      }),
    ).toThrow('facts.milestones.m.actual');
    expect(() => parseFacts({ ...facts(), qty: { 'a b': '1' } })).toThrow(
      'facts.qty.a b',
    );
    expect(() =>
      parseFacts({ ...facts(), updated: { support: 'yesterday' } }),
    ).toThrow('facts.updated.support');
  });
  it('save command needs uuids, a valid date and a non-negative integer version', () => {
    const cmd = {
      projectId: ID + '1',
      businessDate: '2026-09-29',
      expectedVersion: 0,
      clientMutationId: ID + '2',
      facts: facts(),
    };
    expect(parseSaveFactsCommand(cmd).projectId).toBe(ID + '1');
    expect(() =>
      parseSaveFactsCommand({ ...cmd, expectedVersion: -1 }),
    ).toThrow('expectedVersion');
    expect(() =>
      parseSaveFactsCommand({ ...cmd, businessDate: '2026-02-30' }),
    ).toThrow('businessDate');
    expect(() =>
      parseSaveFactsCommand({ ...cmd, clientMutationId: 'abc' }),
    ).toThrow('clientMutationId');
  });
  it('plan rows are unique items with plain numbers or blank; tokens are not targets', () => {
    const base = {
      projectId: ID + '1',
      targetBusinessDate: '2026-09-30',
      clientMutationId: ID + '3',
    };
    expect(
      parseSavePlanDraftCommand({
        ...base,
        rows: [
          { item: 'support', target: '300' },
          { item: 'rail', target: '' },
        ],
      }).rows,
    ).toHaveLength(2);
    expect(() =>
      parseSavePlanDraftCommand({
        ...base,
        rows: [
          { item: 'support', target: '1' },
          { item: 'support', target: '2' },
        ],
      }),
    ).toThrow('rows.1.item');
    expect(() =>
      parseSavePlanDraftCommand({
        ...base,
        rows: [{ item: 'support', target: 'unknown' }],
      }),
    ).toThrow('rows.0.target');
  });
  it('correction needs a reason; no-work needs a listed reason', () => {
    const base = {
      projectId: ID + '1',
      businessDate: '2026-09-29',
      clientMutationId: ID + '4',
    };
    expect(() =>
      parseStartCorrectionCommand({ ...base, reason: '   ' }),
    ).toThrow('reason');
    expect(
      parseStartCorrectionCommand({ ...base, reason: ' 数量填错 ' }).reason,
    ).toBe('数量填错');
    expect(
      parseNoWorkCommand({
        ...base,
        expectedVersion: 2,
        reason: 'weather',
        note: '',
      }).reason,
    ).toBe('weather');
    expect(() =>
      parseNoWorkCommand({
        ...base,
        expectedVersion: 2,
        reason: 'holiday',
        note: '',
      }),
    ).toThrow('reason');
  });
});
