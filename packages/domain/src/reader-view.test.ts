import { describe, expect, it } from 'vitest';
import type { PhotoAsOfDto, PhotoDto, ReportItemDto } from '@mje/contracts';
import {
  frozenPhotoViews,
  readerContent,
  readerDayState,
  readerPlan,
  readerSnapshot,
  withheldCoordinates,
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
  coordinates: 'exact',
  hasThumbnail: false,
  receivedAt: '2026-10-05T08:00:00.000Z',
  uploadedByPersonId: 'TEST-person',
  link,
  linkVersion: 3,
});

describe('reader view (OD18)', () => {
  it('lists only submitted days; an open correction is the last submission', () => {
    expect(readerDayState('empty')).toBe(null);
    expect(readerDayState('draft')).toBe(null);
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

describe('reader view: whether a photo has a position, not where (OD20)', () => {
  // Synthetic TEST positions (0.0000 / 0.0000), not a real site.
  const device: PhotoDto = {
    ...photo('d', { type: 'item', id: 'support' }),
    source: 'camera',
    capture: {
      lat: '0.000000',
      lon: '0.000000',
      accuracyM: '12.00',
      fixAt: '2026-10-05T08:00:00.000Z',
    },
    location: 'device',
  };
  const file: PhotoDto = {
    ...photo('f', null),
    file: {
      takenLocal: '2026-10-05T09:15:30',
      takenAt: null,
      gps: { lat: '0.000000', lon: '0.000000' },
    },
    location: 'file',
  };

  it('keeps the position kind, accuracy and fix time; the coordinates are null and marked withheld', () => {
    const before = structuredClone(device);
    expect(withheldCoordinates(device)).toEqual({
      ...device,
      capture: {
        lat: null,
        lon: null,
        accuracyM: '12.00',
        fixAt: '2026-10-05T08:00:00.000Z',
      },
      coordinates: 'withheld',
    });
    expect(withheldCoordinates(file)).toEqual({
      ...file,
      file: { takenLocal: '2026-10-05T09:15:30', takenAt: null, gps: null },
      location: 'file',
      coordinates: 'withheld',
    });
    const none = withheldCoordinates(photo('n', null));
    expect([none.location, none.capture, none.file.gps]).toEqual([
      'none',
      null,
      null,
    ]);
    expect(device).toEqual(before); // the writer's object is not changed
  });

  it('every frozen photo view a reader gets is withheld', () => {
    const views = frozenPhotoViews(
      [asOf('d', { type: 'item', id: 'support' }), asOf('f', null)],
      [device, file],
    );
    expect(views.map((p) => p.coordinates)).toEqual(['withheld', 'withheld']);
    expect(JSON.stringify(views)).not.toContain('0.000000');
  });

  it("a revision snapshot's photos carry only the frozen fields; the stored snapshot is not changed", () => {
    const frozen = asOf('d', { type: 'item', id: 'support' });
    const stored = {
      businessDate: '2026-10-05',
      facts: blankFacts(),
      // Whatever a snapshot might hold beyond the frozen fields never reaches a reader.
      photos: [{ ...frozen, lat: '0.000000', capture: { lon: '0.000000' } }],
    };
    const copy = structuredClone(stored);
    const shown = readerSnapshot(stored);
    expect(shown).toEqual({ ...stored, photos: [frozen] });
    expect(stored).toEqual(copy);
    const noPhotos = { businessDate: '2026-10-05' };
    expect(readerSnapshot(noPhotos)).toBe(noPhotos);
  });

  it('a revision snapshot never gives a reader the frozen check-ins (A6.0)', () => {
    const field = { seqBoundary: 2, checkIns: [{ personId: 'p' }] };
    const stored = { businessDate: '2026-10-05', field, photos: [] };
    const copy = structuredClone(stored);
    const shown = readerSnapshot(stored);
    expect('field' in shown).toBe(false);
    expect(shown).toEqual({ businessDate: '2026-10-05', photos: [] });
    expect(readerSnapshot({ businessDate: 'x', field })).toEqual({
      businessDate: 'x',
    });
    expect(stored).toEqual(copy);
  });
});
