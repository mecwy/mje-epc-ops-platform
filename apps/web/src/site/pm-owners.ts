import type { ReportApi } from '../api.js';
import { SiteSessions } from './site-sessions.js';

/**
 * A project's PM command owners (AGENTS.md: an owner lives for the workspace, never for a tab
 * or a role): the People page's sessions (settings, site location, devices, QR, PM proxies per
 * site day). The workspace keeps one per project for its whole life, so leaving a tab, losing
 * write access or switching projects and back never orphans an attempt; a reader gets an
 * owned-actions bar with Retry / Give up (the server decides).
 */
export class PmOwners {
  readonly site: SiteSessions;

  constructor(
    api: ReportApi,
    readonly projectId: string,
  ) {
    this.site = new SiteSessions(api, projectId);
  }
}

/** One PmOwners per project for the workspace's life. */
export class PmOwnerRegistry {
  private readonly byProject = new Map<string, PmOwners>();
  constructor(private readonly api: ReportApi) {}
  get(projectId: string): PmOwners {
    let o = this.byProject.get(projectId);
    if (!o) {
      o = new PmOwners(this.api, projectId);
      this.byProject.set(projectId, o);
    }
    return o;
  }
}
