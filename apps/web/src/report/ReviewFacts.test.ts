import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DayFactsDto, ReportItemDto } from '@mje/contracts';
import { ReviewFacts } from './ReviewFacts.js';

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

describe('whole-report confirmation facts', () => {
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
