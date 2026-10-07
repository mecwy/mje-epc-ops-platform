import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DayFactsDto } from '@mje/contracts';
import type { ReportContent, RevisionMeta } from '../api.js';
import { ReportBody } from './ReportView.js';

vi.mock('../i18n.js', () => {
  const text: Record<string, string> = {
    people: 'People',
    today: 'Today',
    persons: 'Persons',
    notFilled: 'Not filled',
    unknown: 'Unknown',
    na: 'N/A',
  };
  const labels: Record<string, string> = {
    role_manager: 'TEST Manager',
    role_safetyOfficer: 'TEST Safety',
    role_supervisor: 'TEST Supervisor',
    role_subManager: 'TEST Subcontractor',
    role_installer: 'TEST Installer',
  };
  return {
    useI18n: () => ({
      lang: 'en',
      locale: 'en-GB',
      t: (key: string) => text[key] ?? key,
      label: (key: string) => labels[key] ?? key,
    }),
  };
});
vi.mock('./PersonnelMetrics.js', () => ({
  PersonnelMetrics: ({ mode }: { mode: string }) =>
    createElement(
      'section',
      { 'aria-label': 'TEST seven-day summary' },
      `TEST ${mode} summary`,
    ),
}));

function content(people: DayFactsDto['people'] = {}): ReportContent {
  return {
    businessDate: '2026-10-07',
    facts: {
      weather: '',
      temperature: '',
      qty: {},
      cumulative: {},
      people,
      machinery: {},
      materials: {},
      presence: {},
      milestones: {},
      updated: {},
      narrative: { construction: '', quality: '', safety: '' },
      noWork: { reason: 'rest', note: 'TEST no construction' },
    },
    items: [],
    baseline: null,
    nextPlan: { status: 'none', n: null, rows: [] },
    previousSubmittedDate: null,
    cumulativeBase: {},
    materialsCumulative: {},
    coverage: { missing: [], invalid: [] },
  };
}
const version: RevisionMeta = {
  n: 1,
  at: '2026-10-07T10:00:00Z',
  by: 'TEST actor',
  reason: '',
};
function render(
  c: ReportContent,
  revision: RevisionMeta | null = null,
  summary = false,
) {
  return renderToStaticMarkup(
    createElement(ReportBody, {
      c,
      version: revision,
      timeZone: 'UTC',
      photos: [],
      ...(summary ? { onOpenPersonnelRevision: vi.fn() } : {}),
    }),
  );
}
function daily(html: string): string {
  const section =
    /<section[^>]*aria-label="People · Today"[^>]*>([^]*?)<\/section>/.exec(
      html,
    );
  expect(
    section,
    'a separate current-day personnel section is visible',
  ).not.toBeNull();
  return section![1]!;
}
function row(section: string, label: string): string {
  const match = new RegExp(
    `<tr[^>]*>[^]*?<th[^>]*>${label}</th>([^]*?)</tr>`,
  ).exec(section);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('no-work current-day personnel reading', () => {
  it('shows the report manager and safety counts on a current no-work day', () => {
    const c = content({ manager: '1', safetyOfficer: '2' }),
      before = structuredClone(c);
    const section = daily(render(c));
    expect(row(section, 'TEST Manager')).toContain('>1</b>');
    expect(row(section, 'TEST Safety')).toContain('>2</b>');
    expect(c).toEqual(before);
  });
  it('reads historical personnel solely from the supplied frozen facts', () => {
    const frozen = content({ manager: '3', safetyOfficer: '0' }),
      current = content({ manager: '9', safetyOfficer: '4' });
    const before = structuredClone(frozen);
    const historical = daily(render(frozen, version));
    expect(row(historical, 'TEST Manager')).toContain('>3</b>');
    expect(row(historical, 'TEST Manager')).not.toContain('>9</b>');
    expect(row(daily(render(current)), 'TEST Manager')).toContain('>9</b>');
    expect(frozen).toEqual(before);
  });
  it('omits blank roles while retaining explicit zero, unknown and N/A', () => {
    const section = daily(
      render(
        content({
          manager: '0',
          safetyOfficer: 'unknown',
          supervisor: '',
          subManager: 'na',
        }),
      ),
    );
    expect(row(section, 'TEST Manager')).toContain('>0</b>');
    expect(row(section, 'TEST Safety')).toContain('Unknown');
    expect(section).not.toContain('TEST Supervisor');
    expect(row(section, 'TEST Subcontractor')).toContain('N/A');
    expect(section).not.toContain('TEST Installer');
    expect(section.match(/>0<\/b>/g)).toHaveLength(1);
  });
  it('does not render current-day personnel when all roles are absent or blank', () => {
    for (const people of [
      {},
      { manager: '', safetyOfficer: '   ', supervisor: '\t' },
    ]) {
      const c = content(people),
        before = structuredClone(c);
      const html = render(c);
      expect(html).not.toContain('aria-label="People · Today"');
      for (const label of [
        'TEST Manager',
        'TEST Safety',
        'TEST Supervisor',
        'TEST Subcontractor',
        'TEST Installer',
      ])
        expect(html).not.toContain(label);
      expect(c).toEqual(before);
    }
  });
  it('does not infer an attendance total, labor hours or seven-day values', () => {
    const section = daily(
      render(content({ manager: '1', safetyOfficer: '2' })),
    );
    for (const value of ['peopleTotal', 'hours', '24', 'seven-day'])
      expect(section).not.toContain(value);
  });
  it('uses escaped raw-value formatting without rewriting the facts', () => {
    const c = content({ manager: '<img src=x onerror=alert(1)>' }),
      before = structuredClone(c);
    const section = daily(render(c));
    expect(section).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(section).not.toContain('<img');
    expect(c).toEqual(before);
  });
  it('keeps the existing seven-day widget separate and renders it once', () => {
    const html = render(
      content({ manager: '1', safetyOfficer: '2' }),
      version,
      true,
    );
    expect(html.match(/aria-label="TEST seven-day summary"/g)).toHaveLength(1);
    expect(daily(html)).not.toContain('TEST seven-day summary');
    expect(html.match(/aria-label="People · Today"/g)).toHaveLength(1);
  });
  it('does not add a second personnel section to a normal work report', () => {
    const c = content({ manager: '1' });
    c.facts.noWork = null;
    const html = render(c);
    expect(html).not.toContain('aria-label="People · Today"');
    expect(html).toContain('TEST Manager');
  });
});
