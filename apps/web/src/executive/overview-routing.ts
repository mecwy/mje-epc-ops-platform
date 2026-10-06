import { isRealDate } from '@mje/contracts';
/** Public identifiers only; route data never supplies authority, identity or report versions. */
export type ExecutiveRoute =
  | { kind: 'home' }
  | { kind: 'attention' }
  | { kind: 'overview'; projectId: string; statusId?: string }
  | { kind: 'issue'; projectId: string; issueId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseExecutiveRoute(hash: string): ExecutiveRoute | null {
  if (hash === '#/projects') return { kind: 'home' };
  if (hash === '#/attention') return { kind: 'attention' };
  const match = /^#\/projects\/([^/]+)\/(overview|issues)(?:\/([^/]+))?$/.exec(
    hash,
  );
  if (!match || !UUID.test(match[1]!)) return null;
  const projectId = match[1]!.toLowerCase(),
    target = match[3];
  if (target && !UUID.test(target)) return null;
  if (match[2] === 'issues')
    return target
      ? { kind: 'issue', projectId, issueId: target.toLowerCase() }
      : null;
  return {
    kind: 'overview',
    projectId,
    ...(target ? { statusId: target.toLowerCase() } : {}),
  };
}
export function executiveHref(route: ExecutiveRoute): string {
  if (route.kind === 'home') return '#/projects';
  if (route.kind === 'attention') return '#/attention';
  if (!UUID.test(route.projectId)) throw new Error('Invalid project route');
  const suffix = route.kind === 'issue' ? route.issueId : route.statusId;
  if (suffix !== undefined && !UUID.test(suffix))
    throw new Error('Invalid target route');
  return `#/projects/${route.projectId.toLowerCase()}/${route.kind === 'issue' ? 'issues' : 'overview'}${suffix ? `/${suffix.toLowerCase()}` : ''}`;
}

/** A public navigation target only, never an authorization or editable-version snapshot. */
export interface ReportRoute {
  projectId: string;
  businessDate: string;
}
export function parseReportRoute(hash: string): ReportRoute | null {
  const match = /^#\/projects\/([^/]+)\/report\/(\d{4}-\d{2}-\d{2})$/.exec(
    hash,
  );
  if (!match || !UUID.test(match[1]!) || !isRealDate(match[2]!)) return null;
  return { projectId: match[1]!.toLowerCase(), businessDate: match[2]! };
}
export function reportHref(route: ReportRoute): string {
  if (!UUID.test(route.projectId) || !isRealDate(route.businessDate))
    throw new Error('Invalid report route');
  return `#/projects/${route.projectId.toLowerCase()}/report/${route.businessDate}`;
}
