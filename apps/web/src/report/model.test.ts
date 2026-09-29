import { describe, expect, it } from 'vitest';
import type {
  DayFactsDto,
  PhotoAsOfDto,
  PhotoDto,
  ReportItemDto,
} from '@mje/contracts';
import { blankFacts as blankRuleFacts } from '@mje/domain/rules';
import {
  activeWork,
  cumulativeSuggestion,
  liveCoverage,
  photoPlacement,
  reportPhotos,
  savable,
  setFact,
} from './model.js';

const item = (kind: ReportItemDto['kind'], key: string): ReportItemDto => ({
  kind,
  key,
  label: key,
  unit: '',
  designQty: '',
  openingCumulative: '',
  sortOrder: 0,
  active: true,
});
// The empty facts of the rules and the boundary DTO have the same shape.
const blankFacts = () => blankRuleFacts() as DayFactsDto;
const items = [
  item('work', 'support'),
  item('work', 'rail'),
  item('machinery', 'crane'),
  item('material', 'rail'),
];
const baseline = { n: 1, rows: [{ item: 'support', target: '300' }] };

describe('report view model', () => {
  it('planned or already reported items come first; others wait behind a toggle', () => {
    const facts = blankFacts();
    expect(
      activeWork({ items, baseline, facts }).active.map((i) => i.key),
    ).toEqual(['support']);
    const withRail = setFact(facts, 'qty.rail', '5');
    expect(
      activeWork({ items, baseline, facts: withRail }).active.map((i) => i.key),
    ).toEqual(['support', 'rail']);
  });
  it('suggests cumulative from the carried value and keeps its date', () => {
    expect(
      cumulativeSuggestion({ value: '5390', asOf: '2026-09-29' }, '280'),
    ).toEqual({
      base: '5390',
      qty: '280',
      sum: '5670',
      asOf: '2026-09-29',
    });
    expect(cumulativeSuggestion(undefined, '280')).toBeNull();
    expect(
      cumulativeSuggestion({ value: 'unknown', asOf: '2026-09-29' }, '280'),
    ).toBeNull();
  });
  it('coverage reminds of a photo where a quantity has none, only once photos are known', () => {
    const facts = setFact(blankFacts(), 'qty.support', '260');
    const photo = (c: ReturnType<typeof liveCoverage>) =>
      c.missing.filter((m) => m.key === 'photo').map((m) => m.item);
    // Photos not loaded yet: unknown, so neither reminded nor treated as covered.
    const unknown = liveCoverage({ items, baseline, facts }, null);
    expect(photo(unknown)).toEqual([]);
    expect(
      unknown.missing.some(
        (m) => m.key === 'cumulative' && m.item === 'support',
      ),
    ).toBe(true);
    expect(photo(liveCoverage({ items, baseline, facts }, new Set()))).toEqual([
      'support',
    ]);
    expect(
      photo(liveCoverage({ items, baseline, facts }, new Set(['support']))),
    ).toEqual([]);
    // A reminder never blocks: it is not an invalid entry.
    expect(liveCoverage({ items, baseline, facts }, new Set()).invalid).toEqual(
      [],
    );
  });
  it('invalid numbers keep the draft local; tokens and blanks are savable', () => {
    expect(savable(setFact(blankFacts(), 'qty.support', 'unknown'))).toBe(true);
    expect(savable(setFact(blankFacts(), 'qty.support', '12a'))).toBe(false);
    expect(savable(setFact(blankFacts(), 'people.manager', '1,5'))).toBe(true);
  });
  it('a submitted day shows the photo links its revision froze, not later changes', () => {
    const frozen: PhotoAsOfDto = {
      id: 'ph1',
      source: 'camera',
      location: 'device',
      accuracyM: '12.00',
      deviceCapturedAt: '2026-10-01T08:00:00.000Z',
      fileTakenAt: null,
      fileTakenLocal: null,
      link: { type: 'item', id: 'support' },
    };
    // Relinked after submission (allowed): the photo now backs an issue.
    const now: PhotoDto = {
      id: 'ph1',
      projectId: 'p',
      businessDate: '2026-10-01',
      source: 'camera',
      mediaType: 'image/jpeg',
      sizeBytes: 10,
      sha256: 'TEST',
      capture: {
        lat: '1.000000',
        lon: '2.000000',
        accuracyM: '12.00',
        fixAt: '2026-10-01T07:59:59.000Z',
      },
      deviceCapturedAt: '2026-10-01T08:00:00.000Z',
      file: { takenLocal: null, takenAt: null, gps: null },
      location: 'device',
      hasThumbnail: true,
      receivedAt: '2026-10-01T08:00:01.000Z',
      uploadedByPersonId: 'TEST',
      link: { type: 'issue', id: 'i1' },
      linkVersion: 3,
    };
    const unlinked = { ...now, id: 'ph2', link: null };
    expect(reportPhotos('submitted', { photos: [frozen] }, [now])).toEqual([
      frozen,
    ]);
    // A revision from before photos existed has none, whatever is linked now.
    expect(reportPhotos('submitted', {}, [now])).toEqual([]);
    // Not submitted: the linked photos as they are now, without coordinates.
    const live = reportPhotos('correcting', { photos: [frozen] }, [
      now,
      unlinked,
    ]);
    expect(live).toEqual([{ ...frozen, link: { type: 'issue', id: 'i1' } }]);
    expect(JSON.stringify(live)).not.toContain('lat');
  });
  it('gives every frozen photo a place in the report, including closed issues and photo-only items', () => {
    const shot = (id: string, link: PhotoAsOfDto['link']): PhotoAsOfDto => ({
      id,
      source: 'album',
      location: 'none',
      accuracyM: null,
      deviceCapturedAt: null,
      fileTakenAt: null,
      fileTakenLocal: null,
      link,
    });
    const issue = (id: string, status: 'open' | 'closed') => ({
      id,
      title: `TEST ${id}`,
      category: '' as const,
      escalate: false,
      controlled: false,
      ownerPersonId: null,
      dueOn: null,
      workItemKey: null,
      status,
      closedToday: status === 'closed',
      last: null,
    });
    const photos = [
      shot('p1', { type: 'item', id: 'support' }), // planned: its own row
      shot('p2', { type: 'item', id: 'rail' }), // no plan, no quantity
      shot('p3', { type: 'issue', id: 'open1' }),
      shot('p4', { type: 'issue', id: 'closed1' }), // closed that day
      shot('p5', { type: 'issue', id: 'elsewhere' }), // not in this report
    ];
    const c = {
      items,
      baseline,
      facts: blankFacts(),
      issues: [issue('open1', 'open'), issue('closed1', 'closed')],
    };
    const placed = photoPlacement(c, photos);
    expect(placed.photoOnlyItems.map((i) => i.key)).toEqual(['rail']);
    expect(placed.otherIssues.map((i) => i.id)).toEqual(['closed1']);
    expect(placed.unplaced.map((p) => p.id)).toEqual(['p5']);
    // A no-work day shows no progress rows: its item photos still have a place.
    const noWork = photoPlacement(
      {
        ...c,
        facts: { ...blankFacts(), noWork: { reason: 'rest', note: '' } },
      },
      photos,
    );
    expect(noWork.photoOnlyItems).toEqual([]);
    expect(noWork.unplaced.map((p) => p.id)).toEqual(['p1', 'p2', 'p5']);
  });
});
