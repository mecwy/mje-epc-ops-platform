import type { ForemanDayView, ReportApi } from '../api.js';
import { AdoptFlow } from '../report/foreman-adopt.js';
import { SiteSessions } from './site-sessions.js';

/** The report day the adoption flows act on; the workspace binds its day handle to it. */
export interface DayBinding {
  flush: () => Promise<string>;
  current: (
    businessDate: string,
  ) => { foreman: ForemanDayView | null; version: number } | null;
  reload: () => Promise<unknown>;
}

/**
 * A project's PM command owners (AGENTS.md: an owner lives for the workspace, never for a tab
 * or a role): the People page's sessions (settings, site location, devices, QR, PM proxies)
 * and one adoption flow per site day. The workspace keeps one per project for its whole life,
 * so leaving a tab, losing write access or switching projects and back never orphans an
 * attempt; a reader gets an owned-actions bar with Retry / Give up (the server decides).
 */
export class PmOwners {
  readonly site: SiteSessions;
  private readonly adopts = new Map<string, AdoptFlow>();
  /** Bound by the workspace on every render to its current day handle. */
  day: DayBinding | null = null;

  constructor(
    private readonly api: ReportApi,
    readonly projectId: string,
    private readonly newKey?: () => string,
  ) {
    this.site = new SiteSessions(api, projectId);
  }

  /** One adoption flow per site day, for the owners' life. */
  adoptFor(businessDate: string): AdoptFlow {
    let flow = this.adopts.get(businessDate);
    if (!flow) {
      flow = new AdoptFlow(
        {
          api: this.api,
          projectId: this.projectId,
          businessDate,
          flush: () => this.day?.flush() ?? Promise.resolve('STALE'),
          current: () => this.day?.current(businessDate) ?? null,
          reload: () => this.day?.reload() ?? Promise.resolve(),
        },
        () => this.site.changed(),
        this.newKey,
      );
      this.adopts.set(businessDate, flow);
    }
    return flow;
  }
  /** Every day with an adoption flow (for the owned-actions bar). */
  adoptDays(): [string, AdoptFlow][] {
    return [...this.adopts.entries()];
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
