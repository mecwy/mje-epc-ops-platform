import { describe, expect, it } from 'vitest';
import type { PhotoAsOfDto, PhotoDto, ReportItemDto } from '@mje/contracts';
import {
  frozenPhotoViews,
  readerContent,
  readerDayState,
  readerPlan,
} from './reader-view.js';
import { blankFacts, planRows, planStatus } from './report-rules.js';

const item: ReportItemDto = {
  kind: 'work',
  key: 'support',
  label: 'TEST support',
  unit: 'set',
  designQty: '',
  openingCumulative: '',
  sortOrder: 0,
  active: true,
};
const asOf = (id: string, link: PhotoAsOfDto['link']): PhotoAsOfDto => ({
  id,
  source: 'album',
  location: 'none',
  accuracyM: null,
  deviceCapturedAt: null,
  fileTakenAt: null,
  fileTakenLocal: null,
  link,
});
const photo = (id: string, link: PhotoDto['link']): PhotoDto => ({
  id,
  projectId: 'TEST-project',
  businessDate: '2026-10-05',
  source: 'album',
  mediaType: 'image/jpeg',
  sizeBytes: 1,
  sha256: id,
  capture: null,
  deviceCapturedAt: null,
  file: { takenLocal: null, takenAt: null, gps: null },
  location: 'none',
  hasThumbnail: false,
  receivedAt: '2026-10-05T08:00:00.000Z',
  uploadedByPersonId: 'TEST-person',
  link,
  linkVersion: 3,
});

describe('reader view (OD18)', () => {
  it('shows a draft as empty and an open correction as the last submission', () => {
    expect(readerDayState('empty')).toBe('empty');
    expect(readerDayState('draft')).toBe('empty');
    expect(readerDayState('submitted')).toBe('submitted');
    expect(readerDayState('correcting')).toBe('submitted');
  });

  it('drops the plan draft but keeps the confirmed versions', () => {
    const v1 = { n: 1, rows: [{ item: 'support', target: '300' }], at: 'T' };
    const draft = [{ item: 'support', target: '999' }];
    const shown = readerPlan({ versions: [v1], draft });
    expect(shown).toEqual({ versions: [v1], draft: null });
    expect(planStatus(shown)).toEqual({ status: 'confirmed', n: 1 });
    expect(planRows(shown, undefined)).toEqual(v1.rows);
    // Without a confirmed version, a draft leaves nothing for a reader.
    const onlyDraft = readerPlan({ versions: [], draft });
    expect(planStatus(onlyDraft)).toEqual({ status: 'none', n: null });
    expect(planRows(onlyDraft, undefined)).toEqual([]);
  });

  it('shows nothing of a day without a submission', () => {
    const c = readerContent(null, [item]);
    expect(c).toEqual({
      state: 'empty',
      facts: blankFacts(),
      items: [item],
      planStatus: { status: 'none', n: null },
      baseline: null,
      nextPlan: { status: 'none', n: null, rows: [] },
      previousSubmittedDate: null,
      cumulativeBase: {},
      materialsCumulative: {},
      coverage: { missing: [], invalid: [] },
      issues: [],
      frozenPhotos: [],
    });
  });

  it('builds a submitted day from the snapshot only, tolerating older snapshots', () => {
    const facts = { ...blankFacts(), weather: 'TEST frozen' };
    const snapshot = {
      facts,
      items: [{ ...item, label: 'TEST frozen label' }],
      baseline: { n: 2, rows: [{ item: 'support', target: '350' }] },
      nextPlan: { status: 'draft', n: null, rows: [] },
      previousSubmittedDate: '2026-10-04',
      cumulativeBase: { support: { value: '10', asOf: '2026-10-04' } },
      materialsCumulative: {},
      coverage: { missing: [{ key: 'weather' }], invalid: [] },
      // before issues and photos existed: no such keys
    };
    const c = readerContent(snapshot, [item]);
    expect(c.state).toBe('submitted');
    expect(c.facts).toBe(facts);
    expect(c.items[0]!.label).toBe('TEST frozen label');
    expect(c.planStatus).toEqual({ status: 'confirmed', n: 2 });
    expect(c.baseline).toEqual(snapshot.baseline);
    // The next-day plan as frozen at submission (part of the submitted report).
    expect(c.nextPlan).toEqual(snapshot.nextPlan);
    expect(c.previousSubmittedDate).toBe('2026-10-04');
    expect(c.cumulativeBase).toEqual(snapshot.cumulativeBase);
    expect(c.coverage).toEqual(snapshot.coverage);
    expect(c.issues).toEqual([]);
    expect(c.frozenPhotos).toEqual([]);
    const noBaseline = readerContent({ ...snapshot, baseline: null }, []);
    expect(noBaseline.planStatus).toEqual({ status: 'none', n: null });
  });

  it('shows frozen photos with their frozen link, in revision order, without link version', () => {
    const frozen = [
      asOf('b', { type: 'item', id: 'rail' }),
      asOf('a', { type: 'issue', id: 'TEST-issue' }),
      asOf('gone', null),
    ];
    const rows = [
      photo('a', null), // unlinked since
      photo('b', { type: 'issue', id: 'relinked' }),
      photo('not-frozen', { type: 'item', id: 'support' }),
    ];
    const views = frozenPhotoViews(frozen, rows);
    expect(views.map((p) => [p.id, p.link, p.linkVersion])).toEqual([
      ['b', { type: 'item', id: 'rail' }, 0],
      ['a', { type: 'issue', id: 'TEST-issue' }, 0],
    ]);
    expect(frozenPhotoViews([], rows)).toEqual([]);
  });
});
