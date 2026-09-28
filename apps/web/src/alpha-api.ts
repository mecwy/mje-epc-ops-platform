import type { AlphaDeclaration, SaveAlphaCommand } from '@mje/contracts';

export interface AuthConfig {
  enabled: boolean;
  tenantId?: string;
  clientId?: string;
  scope?: string;
}
export interface Project {
  id: string;
  name: string;
  code: string;
  timezone: string;
}
export interface ProjectsResponse {
  accountId: string;
  personId: string;
  projects: Project[];
}
export interface SiteDaySummary {
  id: string;
  businessDate: string;
  version: number;
  currentRevisionNumber: number;
  status: 'DRAFT' | 'SAVED_PENDING_REVIEW';
  updatedAt: string;
}
export interface SiteDayDetail extends SiteDaySummary {
  projectId: string;
  siteTimezone: string;
  content: { declaration: AlphaDeclaration };
  revisions: Array<{
    id: string;
    revisionNumber: number;
    baseRevisionNumber: number | null;
    reason: string;
    createdAt: string;
    snapshot: { declaration: AlphaDeclaration };
  }>;
}
export interface SaveResponse {
  recordId: string;
  version: number;
  revisionNumber: number;
  status: 'DRAFT' | 'SAVED_PENDING_REVIEW';
  savedAt: string;
}
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  token: string,
  command?: SaveAlphaCommand,
): Promise<T> {
  const response = await fetch(path, {
    method: command ? 'POST' : 'GET',
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(command
        ? {
            'Content-Type': 'application/json',
            'Idempotency-Key': command.clientMutationId,
          }
        : {}),
    },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    throw new ApiError(body.code ?? 'REQUEST_FAILED', response.status);
  }
  return (await response.json()) as T;
}
