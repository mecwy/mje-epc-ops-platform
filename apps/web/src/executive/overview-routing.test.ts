import { describe, expect, it } from 'vitest';
import {
  executiveHref,
  reportHref,
  parseReportRoute,
  parseExecutiveRoute,
  type ExecutiveRoute,
} from './overview-routing.js';
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('executive deep links', () => {
  it('roundtrips overview, immutable status and issue targets without report date or authority', () => {
    const routes: ExecutiveRoute[] = [
      { kind: 'home' },
      { kind: 'attention' },
      { kind: 'overview', projectId },
      { kind: 'overview', projectId, statusId: id },
      { kind: 'issue', projectId, issueId: id },
    ];
    for (const route of routes)
      expect(parseExecutiveRoute(executiveHref(route))).toEqual(route);
  });
  it('rejects path traversal, extra arguments, script text, malformed IDs and missing issue targets', () => {
    for (const hash of [
      '#/projects/../overview',
      '#/projects/a/overview',
      `#/projects/${projectId}/overview?role=manager`,
      `#/projects/${projectId}/issues`,
      `#/projects/${projectId}/issues/${id}/more`,
      '#/projects/javascript:alert(1)/overview',
    ])
      expect(parseExecutiveRoute(hash)).toBeNull();
  });
  it('normalizes valid identifiers and never generates untrusted paths', () => {
    expect(
      parseExecutiveRoute(`#/projects/${projectId.toUpperCase()}/overview`),
    ).toEqual({ kind: 'overview', projectId });
    expect(() =>
      executiveHref({ kind: 'overview', projectId: '../' }),
    ).toThrow();
  });
});

describe('report project and business-date navigation', () => {
  it('roundtrips the exact target day without substituting today or newest revision', () => {
    const route = { projectId, businessDate: '2028-02-29' };
    const href = reportHref(route);
    expect(parseReportRoute(href)).toEqual(route);
    expect(
      parseReportRoute(href.replace(projectId, projectId.toUpperCase())),
    ).toEqual(route);
    expect(parseExecutiveRoute(href)).toBeNull();
    expect(
      parseReportRoute(executiveHref({ kind: 'overview', projectId })),
    ).toBeNull();
  });
  it.each([
    '2027-02-29',
    '2028-04-31',
    '2028-00-10',
    '2028-01-00',
    'today',
    '2028-2-9',
  ])(
    'rejects invalid date %s instead of silently selecting another day',
    (businessDate) => {
      expect(
        parseReportRoute(`#/projects/${projectId}/report/${businessDate}`),
      ).toBeNull();
      expect(() => reportHref({ projectId, businessDate })).toThrow(
        'Invalid report route',
      );
    },
  );
  it.each([
    '?role=manager',
    '?orgId=TEST',
    '/revision/5',
    '/../overview',
    '?token=TEST',
    '#more',
  ])(
    'does not accept authority, version, or extra data suffix %s',
    (suffix) => {
      expect(
        parseReportRoute(`#/projects/${projectId}/report/2028-02-29${suffix}`),
      ).toBeNull();
    },
  );
  it('rejects malformed and encoded path identifiers', () => {
    for (const invalid of ['..', 'TEST', '%2e%2e', 'javascript:alert(1)']) {
      expect(
        parseReportRoute(`#/projects/${invalid}/report/2028-02-29`),
      ).toBeNull();
      expect(() =>
        reportHref({ projectId: invalid, businessDate: '2028-02-29' }),
      ).toThrow();
    }
  });
});
