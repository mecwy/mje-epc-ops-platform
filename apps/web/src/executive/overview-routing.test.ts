import { describe, expect, it } from 'vitest';
import {
  executiveHref,
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
