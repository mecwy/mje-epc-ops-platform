import { describe, expect, it } from 'vitest';
import {
  parseCloseIssueCommand,
  parseCreateIssueCommand,
  parseDismissLagCommand,
  parseNoteIssueCommand,
  parseReopenIssueCommand,
  parseReplyIssueCommand,
  parseSetEscalateCommand,
} from './issue.js';
import { InvalidReportInput } from './report.js';

const P = '10000000-0000-4000-8000-000000000001';
const I = '10000000-0000-4000-8000-000000000002';
const K = '10000000-0000-4000-8000-000000000003';
const create = (over: Record<string, unknown> = {}) => ({
  projectId: P,
  businessDate: '2026-10-05',
  clientMutationId: K,
  title: '  TEST north row cable delay  ',
  ...over,
});
const field = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidReportInput);
    return (e as InvalidReportInput).field;
  }
  throw new Error('accepted');
};

describe('issue contracts', () => {
  it('creates with defaults: no category, not escalated, not controlled, nothing optional', () => {
    expect(parseCreateIssueCommand(create())).toEqual({
      projectId: P,
      businessDate: '2026-10-05',
      clientMutationId: K,
      title: 'TEST north row cable delay',
      category: '',
      escalate: false,
      controlled: false,
      workItemKey: null,
      ownerPersonId: null,
      dueOn: null,
      note: '',
    });
  });
  it('keeps every optional field; ids are lower-cased; blank optionals are null', () => {
    const c = parseCreateIssueCommand(
      create({
        category: 'progressLag',
        escalate: true,
        controlled: true,
        workItemKey: 'support',
        ownerPersonId: I.toUpperCase(),
        dueOn: '2026-10-09',
        note: ' first note ',
      }),
    );
    expect(c).toMatchObject({
      category: 'progressLag',
      escalate: true,
      controlled: true,
      workItemKey: 'support',
      ownerPersonId: I,
      dueOn: '2026-10-09',
      note: 'first note',
    });
    expect(
      parseCreateIssueCommand(
        create({ category: '', workItemKey: '', ownerPersonId: null }),
      ),
    ).toMatchObject({ category: '', workItemKey: null, ownerPersonId: null });
  });
  it('escalate without a category parses; the store refuses it (CATEGORY_REQUIRED)', () => {
    expect(parseCreateIssueCommand(create({ escalate: true }))).toMatchObject({
      escalate: true,
      category: '',
    });
  });
  it('rejects a missing, blank or over-long title and bad optionals', () => {
    expect(
      field(() => parseCreateIssueCommand(create({ title: undefined }))),
    ).toBe('title');
    expect(field(() => parseCreateIssueCommand(create({ title: '   ' })))).toBe(
      'title',
    );
    expect(
      field(() => parseCreateIssueCommand(create({ title: 'x'.repeat(201) }))),
    ).toBe('title');
    expect(
      field(() => parseCreateIssueCommand(create({ category: 'fraud' }))),
    ).toBe('category');
    expect(
      field(() => parseCreateIssueCommand(create({ escalate: 'yes' }))),
    ).toBe('escalate');
    expect(
      field(() => parseCreateIssueCommand(create({ controlled: 1 }))),
    ).toBe('controlled');
    expect(
      field(() => parseCreateIssueCommand(create({ workItemKey: 'a b' }))),
    ).toBe('workItemKey');
    expect(
      field(() => parseCreateIssueCommand(create({ ownerPersonId: 'W1' }))),
    ).toBe('ownerPersonId');
    expect(
      field(() => parseCreateIssueCommand(create({ dueOn: '2026-02-30' }))),
    ).toBe('dueOn');
    expect(
      field(() => parseCreateIssueCommand(create({ note: 'x'.repeat(2001) }))),
    ).toBe('note');
    expect(
      field(() =>
        parseCreateIssueCommand(create({ businessDate: '5.10.2026' })),
      ),
    ).toBe('businessDate');
  });
  it('a hostile key or category is never echoed back', () => {
    const hostile = `x\n${'k'.repeat(5000)}`;
    for (const over of [{ category: hostile }, { workItemKey: hostile }]) {
      const f = field(() => parseCreateIssueCommand(create(over)));
      expect(f).not.toMatch(/\n|kkkk/);
      expect(f.length).toBeLessThan(20);
    }
  });
  it('note and reply need text; note needs expectedVersion, reply does not take one', () => {
    const note = {
      issueId: I,
      businessDate: '2026-10-06',
      expectedVersion: 2,
      clientMutationId: K,
      text: ' east side done ',
    };
    expect(parseNoteIssueCommand(note).text).toBe('east side done');
    expect(field(() => parseNoteIssueCommand({ ...note, text: '' }))).toBe(
      'text',
    );
    expect(
      field(() => parseNoteIssueCommand({ ...note, expectedVersion: -1 })),
    ).toBe('expectedVersion');
    expect(
      field(() =>
        parseNoteIssueCommand({ ...note, expectedVersion: undefined }),
      ),
    ).toBe('expectedVersion');
    const reply = parseReplyIssueCommand({ ...note, text: 'noted' });
    expect(reply).toEqual({
      issueId: I,
      businessDate: '2026-10-06',
      clientMutationId: K,
      text: 'noted',
    });
    expect(field(() => parseReplyIssueCommand({ ...note, text: ' ' }))).toBe(
      'text',
    );
  });
  it('escalate needs an explicit boolean; category is optional', () => {
    const base = { issueId: I, expectedVersion: 1, clientMutationId: K };
    expect(parseSetEscalateCommand({ ...base, escalate: true })).toEqual({
      ...base,
      escalate: true,
      category: '',
    });
    expect(
      parseSetEscalateCommand({ ...base, escalate: false, category: 'safety' })
        .category,
    ).toBe('safety');
    expect(field(() => parseSetEscalateCommand(base))).toBe('escalate');
    expect(
      field(() =>
        parseSetEscalateCommand({ ...base, escalate: true, category: 'x' }),
      ),
    ).toBe('category');
  });
  it('close and reopen carry the business day and a version', () => {
    const c = {
      issueId: I,
      businessDate: '2026-10-07',
      expectedVersion: 3,
      clientMutationId: K,
    };
    expect(parseCloseIssueCommand(c)).toEqual(c);
    expect(parseReopenIssueCommand(c)).toEqual(c);
    expect(
      field(() => parseCloseIssueCommand({ ...c, businessDate: undefined })),
    ).toBe('businessDate');
    expect(field(() => parseReopenIssueCommand({ ...c, issueId: 'I1' }))).toBe(
      'issueId',
    );
  });
  it('dismissing a lag reminder names one work item', () => {
    const d = {
      projectId: P,
      businessDate: '2026-10-07',
      workItemKey: 'support',
      clientMutationId: K,
    };
    expect(parseDismissLagCommand(d)).toEqual(d);
    expect(field(() => parseDismissLagCommand({ ...d, workItemKey: '' }))).toBe(
      'workItemKey',
    );
  });
});
