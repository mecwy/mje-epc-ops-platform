import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { PhotoHost } from './Photos.js';
import type { PhotosHandle } from './usePhotos.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate, LOCALES, type Lang } from '@mje/ui';
import { QtyRow, CheckList, CheckPage } from './FillPage.js';
import { ReviewFacts } from './ReviewFacts.js';
import type { DayView } from '../api.js';
import type { DayHandle } from './useDay.js';
let language: Lang = 'en';
vi.mock('../i18n.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../i18n.js')>()),
  useI18n: () => ({
    lang: language,
    locale: LOCALES[language],
    label: (s: string) => s,
    t: (
      key: Parameters<typeof translate>[1],
      vars?: Parameters<typeof translate>[2],
    ) => translate(language, key, vars),
  }),
}));
import type {
  DayFactsDto,
  PhotoAsOfDto,
  PhotoDto,
  ReportItemDto,
} from '@mje/contracts';
import {
  buildInstallationCumulative,
  blankFacts as blankRuleFacts,
} from '@mje/domain/rules';
import {
  activeWork,
  installationPreview,
  cumulativeChecks,
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
      coordinates: 'exact',
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

  it('flags a cumulative below today and one that differs from last + today; skips unknown', () => {
    let f = setFact(blankFacts(), 'qty.support', '110');
    f = setFact(f, 'cumulative.support', '100');
    // first day (no earlier cumulative): 100 declared after today was corrected to 110
    expect(cumulativeChecks({ items, facts: f }, {})).toEqual([
      { item: 'support', kind: 'belowToday' },
    ]);
    const base = { support: { value: '500', asOf: '2026-09-28' } };
    f = setFact(f, 'cumulative.support', '600');
    expect(cumulativeChecks({ items, facts: f }, base)).toEqual([
      { item: 'support', kind: 'notSuggested', sum: '610' },
    ]);
    expect(
      cumulativeChecks(
        { items, facts: setFact(f, 'cumulative.support', '610') },
        base,
      ),
    ).toEqual([]);
    expect(
      cumulativeChecks(
        { items, facts: setFact(f, 'cumulative.support', 'unknown') },
        base,
      ),
    ).toEqual([]);
    expect(
      cumulativeChecks({ items, facts: setFact(f, 'qty.support', '') }, base),
    ).toEqual([]);
  });
});

describe('N4 scoped automatic cumulative draft preview', () => {
  const projectId = '10000000-0000-4000-8000-000000000001';
  const referenceId = '20000000-0000-4000-8000-000000000001';
  const make = () =>
    buildInstallationCumulative({
      projectId,
      businessDate: '2026-10-06',
      selectedAtUTC: '2026-10-06T12:00:00Z',
      workKeys: ['support'],
      history: [],
      todayQty: { support: '10' },
      completeBaselines: {
        support: {
          kind: 'complete-baseline',
          unit: '',
          value: '100',
          asOf: '2026-10-05',
          referenceId,
        },
      },
    });
  it('updates with today edits, never copies plan target or changes raw cumulative', () => {
    const facts = {
      ...blankFacts(),
      qty: { support: '10' },
      cumulative: { support: '' },
    };
    const projection = make();
    const original = structuredClone(projection);
    const day = {
      projectId,
      businessDate: '2026-10-06',
      installationCumulative: projection,
    };
    expect(installationPreview(day, facts, 'support')?.value).toBe('110');
    facts.qty.support = '20';
    expect(installationPreview(day, facts, 'support')?.value).toBe('120');
    expect(facts.cumulative.support).toBe('');
    expect(projection).toEqual(original);
  });
  it('ignores stale project/day and malformed metadata; never falls back to adding legacy carried values', () => {
    const facts = { ...blankFacts(), qty: { support: '10' } };
    const installationCumulative = make();
    expect(
      installationPreview(
        {
          projectId: '10000000-0000-4000-8000-000000000002',
          businessDate: '2026-10-06',
          installationCumulative,
        },
        facts,
        'support',
      ),
    ).toBeNull();
    expect(
      installationPreview(
        { projectId, businessDate: '2026-10-07', installationCumulative },
        facts,
        'support',
      ),
    ).toBeNull();
    expect(
      installationPreview(
        { projectId, businessDate: '2026-10-06' },
        facts,
        'support',
      ),
    ).toBeNull();
  });
  it('preserves an explicit zero, and unknown/blank never produce the previous complete result', () => {
    const day = {
      projectId,
      businessDate: '2026-10-06',
      installationCumulative: make(),
    };
    expect(
      installationPreview(day, { qty: { support: '0' } }, 'support')?.value,
    ).toBe('100');
    for (const qty of ['', 'unknown', 'bad'])
      expect(
        installationPreview(day, { qty: { support: qty } }, 'support')?.value,
      ).toBeNull();
  });
});

function renderWithPhotos(node: ReactNode) {
  const handle = {
    session: { linked: () => [], jobsFor: () => [] },
    unlinked: 0,
    error: null,
    retryReason: null,
    inputs: {
      cameraRef: { current: null },
      albumRef: { current: null },
      onCamera: () => {},
      onAlbum: () => {},
    },
  } as unknown as PhotosHandle;
  return renderToStaticMarkup(
    createElement(PhotoHost, {
      env: {
        handle,
        items: [],
        issues: [],
        canWrite: false,
        canUpload: false,
        timeZone: 'UTC',
      },
      children: node,
    }),
  );
}
describe('N4 actual quantity row rendering', () => {
  const projectId = '10000000-0000-4000-8000-000000000001';
  const referenceId = '20000000-0000-4000-8000-000000000001';
  function setup(complete: boolean) {
    const facts = {
      ...blankFacts(),
      qty: { support: '10' },
      cumulative: { support: '' },
    };
    const projection = buildInstallationCumulative({
      projectId,
      businessDate: '2026-10-06',
      selectedAtUTC: '2026-10-06T12:00:00Z',
      workKeys: ['support'],
      todayQty: facts.qty,
      history: complete
        ? []
        : [
            {
              projectId,
              businessDate: '2026-10-05',
              revisionId: referenceId,
              n: 1,
              qty: { support: '5' },
              cumulative: { support: '100' },
            },
          ],
      ...(complete
        ? {
            completeBaselines: {
              support: {
                kind: 'complete-baseline' as const,
                unit: '',
                value: '100',
                asOf: '2026-10-05',
                referenceId,
              },
            },
          }
        : {}),
    });
    const day = {
      projectId,
      businessDate: '2026-10-06',
      installationCumulative: projection,
      items,
      baseline: { n: 1, rows: [{ item: 'support', target: '500' }] },
      cumulativeBase: { support: { value: '100', asOf: '2026-10-05' } },
      state: 'draft',
    } as unknown as DayView;
    const edit = vi.fn();
    const h = { facts, edit } as unknown as DayHandle;
    return { day, h, edit, facts };
  }
  it.each(['zh', 'en'] as const)(
    'shows automatic complete110 with no Adopt or editable raw field in %s',
    (lang) => {
      language = lang;
      const { day, h, edit, facts } = setup(true);
      const html = renderWithPhotos(
        createElement(QtyRow, { it: items[0]!, day, h, locked: false }),
      );
      expect(html).toContain('110');
      expect(html).toContain(
        translate(lang, 'installationCalculatedCumulative'),
      );
      expect(html).not.toContain(translate(lang, 'adopt'));
      expect(html).not.toContain('id="c-support"');
      expect(edit).not.toHaveBeenCalled();
      expect(facts.cumulative.support).toBe('');
    },
  );
  it('a partial110 shows subtotal only; unknown and readonly keep absence and locks', () => {
    language = 'en';
    const { day, h, edit } = setup(false);
    let html = renderWithPhotos(
      createElement(QtyRow, { it: items[0]!, day, h, locked: true }),
    );
    expect(html).toContain('Recorded subtotal');
    expect(html).toContain('110');
    expect(html).not.toContain('Calculated cumulative');
    expect(edit).not.toHaveBeenCalled();
    h.facts!.qty.support = 'unknown';
    html = renderWithPhotos(
      createElement(QtyRow, { it: items[0]!, day, h, locked: true }),
    );
    expect(html).toContain('Cumulative unknown');
    expect(html).not.toContain('110');
  });
  it('confirmation keeps site, weather, temperature and personnel with one progress section', () => {
    language = 'zh';
    const { day, h } = setup(false);
    h.facts!.siteLocation = 'TEST 施工一区';
    h.facts!.weather = '晴';
    h.facts!.temperature = '26 °C';
    h.facts!.people = { installer: '8' };
    const props = {
      day,
      h,
      projectName: 'TEST N4',
      cov: { missing: [], invalid: [] },
      onBack: vi.fn(),
      onFocus: vi.fn(),
      onSubmit: vi.fn(),
      busy: false,
      photos: { counts: null } as unknown as PhotosHandle,
    };
    const html = renderWithPhotos(createElement(CheckPage, props));
    for (const text of [
      'TEST 施工一区',
      '晴',
      '26 °C',
      '8',
      '已记录小计',
      '110',
    ])
      expect(html).toContain(text);
    expect(html.match(/aria-label="进度"/g)).toHaveLength(1);
    expect(html).not.toContain('采用');
    h.facts!.qty.support = 'unknown';
    const unknown = renderWithPhotos(createElement(CheckPage, props));
    expect(unknown).toContain('累计未知');
    expect(unknown).not.toContain('110');
  });
  it('confirmation shows an entered original cumulative separately from computed subtotal', () => {
    language = 'en';
    const { day, h } = setup(false);
    h.facts!.cumulative.support = '99';
    const html = renderWithPhotos(
      createElement(CheckPage, {
        day,
        h,
        projectName: 'TEST',
        cov: { missing: [], invalid: [] },
        onBack: vi.fn(),
        onFocus: vi.fn(),
        onSubmit: vi.fn(),
        busy: false,
        photos: { counts: null } as unknown as PhotosHandle,
      }),
    );
    expect(html).toContain('Declared cumulative');
    expect(html).toContain('99');
    expect(html).toContain('Recorded subtotal');
    expect(html).toContain('110');
  });
  it('ReviewFacts default behavior preserves the original work declaration without a slot', () => {
    language = 'en';
    const { facts } = setup(false);
    facts.cumulative.support = '99';
    const html = renderToStaticMarkup(
      createElement(ReviewFacts, {
        facts,
        items,
        projectName: 'TEST',
        roles: [],
      }),
    );
    expect(html).toContain('99');
    expect(html.match(/aria-label="Progress"/g)).toHaveLength(1);
  });
  it('same-key non-work item cannot resurrect a missing original cumulative reminder', () => {
    language = 'en';
    const { day, h } = setup(true);
    day.items = [{ ...items[2]!, key: 'support', unit: 'unit' }, ...items];
    const focus = vi.fn();
    const html = renderWithPhotos(
      createElement(CheckList, {
        day,
        h,
        cov: { missing: [{ key: 'cumulative', item: 'support' }], invalid: [] },
        onFocus: focus,
        onSubmit: vi.fn(),
        busy: false,
      }),
    );
    expect(html).not.toContain('Declared cumulative');
    expect(html).not.toContain('c-support');
    expect(focus).not.toHaveBeenCalled();
  });
  it('confirmation never requests per-item adoption or raw cumulative entry when projection exists', () => {
    language = 'en';
    const { day, h, edit } = setup(true);
    const html = renderWithPhotos(
      createElement(CheckList, {
        day,
        h,
        cov: { missing: [{ key: 'cumulative', item: 'support' }], invalid: [] },
        onFocus: vi.fn(),
        onSubmit: vi.fn(),
        busy: false,
      }),
    );
    expect(html).not.toContain('Adopt');
    expect(html).not.toContain('Declared cumulative');
    expect(edit).not.toHaveBeenCalled();
  });
});
