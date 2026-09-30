import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckInListDto } from '@mje/contracts';
import type { Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { CheckInsBeside, PmFieldContext } from '../report/CheckInsBeside.js';
import { declaredHeadcount } from '../report/model.js';
import { CheckInsCard } from './CheckIns.js';
import { SiteSessions } from './site-sessions.js';

const P = '11111111-1111-4111-8111-111111111111';
const root = join(import.meta.dirname, '..');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe('U8: check-ins sit beside the headcount and never fill it', () => {
  it('the declared headcount is computed from the report facts only', () => {
    expect(declaredHeadcount({ people: {} })).toBeNull();
    expect(
      declaredHeadcount({ people: { installer: 'unknown', manager: '' } }),
    ).toBeNull();
    expect(
      declaredHeadcount({
        people: { installer: '5', manager: '1', supervisor: '0' },
      }),
    ).toBe('6');
    // Its only input is facts.people (no check-in data can reach it).
    expect(declaredHeadcount.length).toBe(1);
  });
  it('the only writer of facts.people in the web app is the PM typing a role count', () => {
    const writers = sources(root).filter((f) =>
      /\bedit\(\s*`people\.|facts\.people\s*=|people:\s*\{\s*\.\.\./.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(writers.map((f) => f.slice(root.length + 1))).toEqual([
      'report/FillPage.tsx',
    ]);
    const fill = readFileSync(join(root, 'report/FillPage.tsx'), 'utf8');
    // ...and that input takes the typed value, never a check-in figure.
    expect(fill).toMatch(/h\.edit\(`people\.\$\{r\}`, v\)/);
    for (const f of [
      'site/CheckIns.tsx',
      'report/CheckInsBeside.tsx',
      'report/ForemanLine.tsx',
      'App.tsx',
    ])
      expect(readFileSync(join(root, f), 'utf8')).not.toMatch(
        /edit\(\s*`people/,
      );
  });
  it('the People page shows both, side by side: 5 checked in beside an undeclared headcount', async () => {
    const list: CheckInListDto = {
      projectId: P,
      businessDate: '2026-10-02',
      seqBoundary: null,
      summary: { present: 5, self: 4, proxy: 1, flagged: 1 },
      checkIns: [],
    };
    const api = {
      entryCode: async () => ({ code: null, createdAt: null }),
      devices: async () => [],
      fieldSettings: async () => null,
      roster: async () => ({
        projectId: P,
        rosterVersion: 1,
        crews: [],
        assignments: [],
      }),
      checkIns: async () => list,
    };
    const s = new SiteSessions(api as never, P);
    await s.checkIns('2026-10-02').list.load();
    const project: Project = {
      id: P,
      name: 'TEST',
      code: 'TEST',
      timezone: 'Europe/Belgrade',
      access: 'write',
    };
    const html = renderToString(
      createElement(
        I18nProvider,
        null,
        createElement(CheckInsCard, {
          api: api as never,
          project,
          sessions: s,
          date: '2026-10-02',
          headcount: null,
        }),
      ),
    );
    const side = html.slice(html.indexOf('class="side"'));
    expect(side).toMatch(/>5</);
    expect(side).toMatch(/Report headcount \(declared\)[\s\S]*>—</);
    expect(side).toContain('never filled from check-ins');
  });
  it('the fill page shows the count beside its people total for a writer, nothing for a reader', () => {
    const at = (value: { checkIns: null } | null | object) =>
      renderToString(
        createElement(
          I18nProvider,
          null,
          createElement(
            PmFieldContext.Provider,
            { value: value as never },
            createElement(CheckInsBeside),
          ),
        ),
      );
    const writer = at({
      checkIns: { present: 5, self: 4, proxy: 1, flagged: 1 },
    });
    expect(writer).toMatch(/checked in 5 \(self 4, by others 1\)/);
    expect(writer).not.toMatch(/<input/);
    expect(at(null)).toBe('');
    expect(at({ checkIns: null })).toBe('');
  });
});
