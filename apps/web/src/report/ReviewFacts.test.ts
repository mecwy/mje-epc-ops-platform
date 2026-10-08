import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DayFactsDto, ReportItemDto } from '@mje/contracts';
import { ReviewFacts } from './ReviewFacts.js';
import { FillPage } from './FillPage.js';
import { FieldDayOverview, ReportBody } from './ReportView.js';
import type { DayView, ReportContent } from '../api.js';

vi.mock('./Photos.js', () => ({
  PhotosCard: () => null,
  PhotoLine: () => null,
  UnlinkedReminder: () => null,
  PhotoStrip: () => null,
  PhotosRow: () => null,
  ReportPhotos: () => null,
}));

vi.mock('../i18n.js', () => {
  const text: Record<string, string> = {
    notFilled: 'Not filled',
    unknown: 'Unknown',
    na: 'N/A',
  };
  return {
    useI18n: () => ({
      lang: 'en',
      locale: 'en-GB',
      t: (key: string) => text[key] ?? key,
      label: (key: string) => key,
    }),
  };
});

describe('field entrance declarations', () => {
  function overview(
    read: ReportContent,
    options: Partial<ComponentProps<typeof FieldDayOverview>> = {},
  ) {
    return renderToStaticMarkup(
      createElement(FieldDayOverview, {
        day: { state: 'draft' } as DayView,
        read,
        canWrite: true,
        busy: false,
        photos: [],
        onFill: vi.fn(),
        onReport: vi.fn(),
        onCorrect: vi.fn(),
        onNoWork: vi.fn(),
        ...options,
      }),
    );
  }

  it('keeps empty categories visible without turning missing declarations into zeros', () => {
    const html = overview(content(facts()), {
      day: { state: 'empty' } as DayView,
    });
    for (const category of ['progress', 'materials', 'people', 'machinery'])
      expect(html).toContain(`<dt>${category}</dt>`);
    expect(html).toContain('siteLocation');
    expect(html).toContain('weatherLocation_manual');
    expect(html).toContain('fieldFillToday');
    expect(html).toContain('Not filled');
    expect(html).not.toContain('class="num"');
  });

  it('preserves zero, unknown, N/A, precision and text in a submitted read snapshot', () => {
    const f = facts();
    f.siteLocation = 'TEST <script>site</script>';
    f.weather = 'TEST historical observation';
    f.temperature = '12~20℃';
    f.qty.steel = '9007199254740.125001';
    f.materials.steel = '0';
    f.people.manager = 'unknown';
    f.people.installer = '1';
    f.machinery.crane = 'na';
    const c = content(f);
    c.items = [
      item('steel'),
      item('steel', 'material'),
      item('crane', 'machinery'),
    ];
    const before = structuredClone(c);
    const html = overview(c, { day: { state: 'submitted' } as DayView });
    expect(html).toContain('9,007,199,254,740.125001');
    expect(html).toContain('>0</b>');
    expect(html).toContain('Unknown');
    expect(html).toContain('N/A');
    expect(html).toContain('&lt;script&gt;site&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('TEST historical observation');
    expect(html).toContain('12~20℃');
    expect(html).toContain('submittedLocked');
    expect(html).toContain('startCorrect');
    expect(html).not.toContain('fieldFillToday');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('sourceClassifiedTotal');
    expect(c).toEqual(before);
  });

  it('does not expose unfinished facts to a reader or offer correction to a reader', () => {
    const f = facts();
    f.siteLocation = 'TEST unfinished secret';
    const c = content(f);
    const draft = overview(c, { canWrite: false });
    expect(draft).toContain('notSubmitted');
    expect(draft).not.toContain(f.siteLocation);
    expect(draft).not.toContain('fieldFillToday');
    const submitted = overview(c, {
      canWrite: false,
      day: { state: 'submitted' } as DayView,
    });
    expect(submitted).toContain('nav_report');
    expect(submitted).not.toContain('startCorrect');
  });

  it('keeps no-work reasons and contradictory declarations visible, with busy actions disabled', () => {
    const f = facts();
    f.noWork = { reason: 'weather', note: 'TEST rain' };
    f.qty.steel = '4';
    const c = content(f);
    c.items = [item('steel')];
    const html = overview(c, { busy: true });
    expect(html).toContain('TEST rain');
    expect(html).toContain('>4</b>');
    expect(html).toContain('disabled=""');
  });
});

const roles = [
  { key: 'manager', label: 'TEST Manager' },
  { key: 'installer', label: 'TEST Installer' },
];
function facts(): DayFactsDto {
  return {
    weather: '',
    temperature: '',
    qty: {},
    cumulative: {},
    people: {},
    machinery: {},
    materials: {},
    presence: {},
    milestones: {},
    updated: {},
    narrative: { construction: '', quality: '', safety: '' },
    noWork: null,
  };
}
function item(
  key: string,
  kind: ReportItemDto['kind'] = 'work',
): ReportItemDto {
  return {
    key,
    kind,
    label: `TEST ${key}`,
    unit: 'pcs',
    active: true,
    sortOrder: 0,
    designQty: '',
    openingCumulative: '',
  };
}
function render(f: DayFactsDto, items: ReportItemDto[] = []) {
  return renderToStaticMarkup(
    createElement(ReviewFacts, {
      facts: f,
      items,
      projectName: 'TEST Project',
      roles,
    }),
  );
}

function content(f: DayFactsDto): ReportContent {
  return {
    businessDate: '2026-10-07',
    facts: f,
    items: [],
    baseline: null,
    nextPlan: { status: 'none', n: null, rows: [] },
    previousSubmittedDate: null,
    cumulativeBase: {},
    materialsCumulative: {},
    coverage: { missing: [], invalid: [] },
  };
}

function report(f: DayFactsDto, historical = false) {
  return renderToStaticMarkup(
    createElement(ReportBody, {
      c: content(f),
      version: historical
        ? { n: 1, at: '2026-10-07T10:00:00Z', by: 'TEST', reason: '' }
        : null,
      timeZone: 'UTC',
      photos: [],
    }),
  );
}

function fill(
  f: DayFactsDto,
  locked: 'submitted' | 'busy' | 'reader' | 'pending' | null = null,
) {
  const edit = vi.fn();
  const day = {
    ...content(f),
    state: locked === 'submitted' ? 'submitted' : 'draft',
    currentRevisionNumber: 0,
    businessDate: '2026-10-07',
  } as unknown as DayView;
  const h = {
    facts: f,
    save: 'idle',
    busy: locked === 'pending',
    retained: [],
    edit,
    flush: vi.fn(),
  } as unknown as ComponentProps<typeof FillPage>['h'];
  const html = renderToStaticMarkup(
    createElement(FillPage, {
      h,
      day,
      cov: day.coverage,
      focus: null,
      onFocused: vi.fn(),
      onBack: vi.fn(),
      onCheck: vi.fn(),
      onPlan: vi.fn(),
      onSubmit: vi.fn(),
      busy: locked === 'busy',
      tomorrowText: '',
      issues: { issues: [], lag: [] } as unknown as ComponentProps<
        typeof FillPage
      >['issues'],
      canWrite: locked !== 'reader',
    }),
  );
  return { html, edit };
}

describe('whole-report confirmation facts', () => {
  it('shows the raw site location independently on confirmation, full report and history', () => {
    const f = facts();
    f.siteLocation = '  TEST <img src=x onerror=alert(1)> & Zone B  ';
    f.noWork = { reason: 'permit', note: 'TEST waiting for permit' };
    const before = structuredClone(f);
    for (const html of [render(f), report(f), report(f, true)]) {
      expect(html).toContain('aria-label="siteLocation"');
      expect(html).toContain(
        '  TEST &lt;img src=x onerror=alert(1)&gt; &amp; Zone B  ',
      );
      expect(html).not.toContain('<img');
      expect(html).toContain('TEST waiting for permit');
      expect(html).not.toContain('weatherLocation_savedLocation');
    }
    expect(f).toEqual(before);
  });

  it('keeps legacy missing and cleared locations unfilled without defaulting or mutating facts', () => {
    for (const f of [facts(), { ...facts(), siteLocation: '' }]) {
      const before = structuredClone(f);
      for (const html of [render(f), report(f), report(f, true)]) {
        expect(html).toMatch(/aria-label="siteLocation"[^]*?Not filled/);
        expect(html).not.toContain('TEST default address');
      }
      expect(f).toEqual(before);
    }
  });

  it('renders the optional bounded location input without generating an empty saved value', () => {
    const f = facts();
    const initial = fill(f);
    expect(initial.html).toMatch(
      /id="f-site-location"[^>]*maxLength="500"[^>]*value=""/,
    );
    expect(initial.edit).not.toHaveBeenCalled();
    expect(Object.hasOwn(f, 'siteLocation')).toBe(false);
    f.siteLocation = '  TEST Zone & <B>  ';
    expect(fill(f).html).toContain('value="  TEST Zone &amp; &lt;B&gt;  "');
    for (const lock of ['submitted', 'busy', 'reader', 'pending'] as const) {
      expect(fill(f, lock).html).toMatch(
        /id="f-site-location"[^>]*disabled=""/,
      );
    }
  });

  it('shows no-work reason and escaped note without an empty progress warning', () => {
    const f = facts();
    f.noWork = { reason: 'permit', note: 'TEST <permit> pending' };
    const html = render(f);
    expect(html).toContain('aria-label="noWork"');
    expect(html).toContain('nw_permit');
    expect(html).toContain('TEST &lt;permit&gt; pending');
    expect(html).not.toContain('aria-label="progress"');
    f.qty.pile = '0';
    const entered = render(f, [item('pile')]);
    expect(entered).toContain('aria-label="progress"');
    expect(entered).toContain('TEST pile');
    expect(entered).toContain('>0');
  });

  it('keeps project, weather, progress and people explicit when facts are missing', () => {
    const html = render(facts(), [item('unreported')]);
    expect(html).toContain('TEST Project');
    for (const title of ['weather', 'progress', 'people'])
      expect(html).toContain(`aria-label="${title}"`);
    expect(html).toContain('Not filled');
    expect(html).not.toContain('TEST unreported');
    expect(html).not.toContain('aria-label="materials"');
    expect(html).not.toContain('aria-label="machinery"');
  });

  it('preserves explicit zero, unknown and N/A instead of hiding or summing them', () => {
    const f = facts();
    f.qty = { zero: '0', unknown: 'unknown', na: 'na', empty: '' };
    f.people = { manager: '0', installer: 'unknown' };
    const html = render(
      f,
      ['zero', 'unknown', 'na', 'empty'].map((key) => item(key)),
    );
    expect(html).toContain('TEST zero');
    expect(html).toContain('>0');
    expect(html).toContain('Unknown');
    expect(html).toContain('N/A');
    expect(html).not.toContain('TEST empty');
    expect(html).toContain('TEST Manager');
    expect(html).toContain('TEST Installer');
    expect(html).not.toContain('peopleTotal');
  });

  it('shows the entered cumulative unchanged without filling a blank today quantity', () => {
    const f = facts();
    f.cumulative.pile = '110';
    const before = structuredClone(f);
    const html = render(f, [item('pile')]);
    expect(html).toContain('110');
    expect(html).toContain('Not filled');
    expect(f).toEqual(before);
  });

  it('displays entered weather, temperature and role counts and never derives hours', () => {
    const f = facts();
    f.weather = 'TEST cloudy';
    f.temperature = '0';
    f.people.installer = '8';
    const html = render(f);
    expect(html).toContain('TEST cloudy');
    expect(html).toContain('temperature');
    expect(html).toContain('TEST Installer');
    expect(html).toContain('>8');
    expect(html).not.toContain('64');
    expect(html).not.toContain('hours');
  });

  it('retains optional entered resource values but excludes inactive and empty items', () => {
    const f = facts();
    f.materials = { steel: '0', empty: '', old: '100' };
    f.machinery.crane = 'na';
    const old = { ...item('old', 'material'), active: false };
    const html = render(f, [
      item('steel', 'material'),
      item('empty', 'material'),
      old,
      item('crane', 'machinery'),
    ]);
    expect(html).toContain('TEST steel');
    expect(html).toContain('TEST crane');
    expect(html).not.toContain('TEST empty');
    expect(html).not.toContain('TEST old');
  });

  it('shows only saved safe location metadata without inventing a site address', () => {
    const f = facts();
    f.reportLocationRef = {
      recordId: '00000000-0000-4000-8000-000000000001',
      accuracyM: '12.345678',
      deviceFixAt: null,
      acquiredAt: '2026-10-06T15:00:00.000Z',
      clientConfirmedAt: '2026-10-06T15:00:01.000Z',
      serverReceivedAt: '2026-10-06T15:00:02.000Z',
    };
    const before = structuredClone(f);
    const html = render(f);
    expect(html).toContain('weatherLocation_savedLocation');
    expect(html).toContain('12.345678 m');
    expect(html).toContain('2026-10-06T15:00:00.000Z');
    expect(html).toContain('Unknown');
    expect(html).not.toContain('address');
    expect(html).not.toContain(f.reportLocationRef.recordId);
    expect(f).toEqual(before);
    f.reportLocationRef = null;
    expect(render(f)).not.toContain('weatherLocation_savedLocation');
  });

  it('renders notes as text and keeps six-decimal quantities without numeric conversion', () => {
    const f = facts();
    f.qty.pile = '9007199254740.125001';
    f.narrative.safety = '<img src=x onerror=alert(1)>';
    const html = render(f, [item('pile')]);
    expect(html).toContain('9,007,199,254,740.125001');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
  });
});
