/**
 * ADR-0003 D2.1 / D2.4 import boundary (eslint.config.mjs `mje/boundary`): its module lists
 * match legacy-adapters.ts, and the rule refuses each bypass on resolved paths (PR #51 review 5).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM config module without type declarations
import { BOUNDARY, boundaryViolation } from '../../../../eslint.config.mjs';
import { MODULES } from './legacy-adapters.js';

const D = 'packages/domain/src/';
const v = (file: string, spec: string, names = ['x'], typeOnly = false) =>
  boundaryViolation(file, spec, names, typeOnly) as string | null;

describe('import boundary', () => {
  it('uses the module files of legacy-adapters.ts', () => {
    for (const m of ['report', 'issue', 'photo'] as const)
      expect([...BOUNDARY.modules[m]].sort()).toEqual(
        [...MODULES[m].files].sort(),
      );
  });
  it('refuses pg and store-kit outside the SQL-owning files', () => {
    expect(v(`${D}report-rules.ts`, 'pg')).toMatch(/pg/);
    expect(v(`${D}authz/surface.ts`, 'pg')).toMatch(/pg/);
    expect(v('apps/api/src/report.controller.ts', 'pg')).toMatch(/pg/);
    expect(v(`${D}report-rules.ts`, './store-kit.js')).toMatch(/store-kit/);
    expect(v(`${D}authz/surface.ts`, '../././store-kit.js')).toMatch(
      /store-kit/,
    );
    expect(v(`${D}issue-store.ts`, 'pg')).toBeNull();
    expect(v(`${D}issue-store.ts`, './store-kit.js')).toBeNull();
  });
  it('refuses report, issue and photo internals on resolved paths', () => {
    expect(v(`${D}issue-store.ts`, './report-store.js')).toMatch(
      /report module/,
    );
    expect(v(`${D}issue-store.ts`, '././report-store.js')).toMatch(
      /report module/,
    );
    expect(v(`${D}issue-store.ts`, '../src/report-store.js')).toMatch(
      /report module/,
    );
    expect(v(`${D}field-store.ts`, './issue-store.js')).toMatch(/issue module/);
    expect(v(`${D}foreman-store.ts`, './photo-store.js')).toMatch(
      /photo module/,
    );
    expect(
      v(`${D}issue-store.ts`, './report-reader.js', ['readerSnapshot']),
    ).toMatch(/internal/);
    expect(
      v(`${D}issue-store.ts`, './report-read-context.js', [
        'openReportReadContext',
      ]),
    ).toMatch(/internal/);
  });
  it('allows the exits, the barrel and the registered legacy imports', () => {
    expect(
      v(`${D}issue-store.ts`, './report-reader.js', ['reportReader']),
    ).toBeNull();
    expect(
      v(`${D}issue-store.ts`, './report-read-context.js', [
        'withReportReadContext',
      ]),
    ).toBeNull();
    expect(v(`${D}index.ts`, './report-store.js', ['ReportStore'])).toBeNull();
    expect(
      v(`${D}report-store.ts`, './photo-store.js', ['photosOfDay']),
    ).toBeNull();
    expect(
      v(`${D}authz/fields.ts`, '../issue-store.js', ['IssueStore'], true),
    ).toBeNull();
    expect(
      v(`${D}authz/fields.ts`, '../issue-store.js', ['IssueStore'], false),
    ).toMatch(/issue module/);
  });
  it('keeps apps on the package barrel', () => {
    expect(
      v('apps/api/src/x.ts', '../../../packages/domain/src/report-store.js'),
    ).toMatch(/@mje\/domain/);
    expect(v('apps/api/src/x.ts', '@mje/domain/dist/report-store.js')).toMatch(
      /@mje\/domain/,
    );
    expect(v('apps/api/src/x.ts', '@mje/domain/authz')).toBeNull();
    expect(v('apps/api/src/x.ts', '@mje/domain')).toBeNull();
  });
});
