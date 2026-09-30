import type { ForemanDayView, ReportApi } from '../api.js';
import type { CommandOutcome, DayStore } from '../report/day-store.js';
import { AdoptFlow } from '../report/foreman-adopt.js';
import { SiteSessions } from './site-sessions.js';

/** A project's report days as the adoption flows act on them (pmDayBinding). */
export interface DayBinding {
  /** Take the day's lock for `owner` and save what was typed (DayStore.hold). */
  hold: (
    businessDate: string,
    owner: string,
  ) => Promise<{ outcome: string; version: number }>;
  current: (
    businessDate: string,
  ) => { foreman: ForemanDayView | null; version: number } | null;
  /**
   * Release `owner`'s lock after its command: freed once a read started after it is applied
   * (DayStore.release); `outcome` words the page while that read fails.
   */
  release: (
    businessDate: string,
    owner: string,
    outcome: CommandOutcome,
  ) => Promise<boolean>;
  /** Free `owner`'s lock when nothing was sent under it (DayStore.abandon). */
  abandon: (businessDate: string, owner: string) => void;
}

/**
 * The binding of one project's days in the workspace's DayStore: every call goes to that
 * project's own day entry (captured here), never to whatever day the page shows now, so
 * switching projects or dates cannot release or read another day.
 */
export function pmDayBinding(store: DayStore, projectId: string): DayBinding {
  return {
    hold: (date, owner) => store.hold(store.entry(projectId, date), owner),
    current: (date) => {
      const e = store.entry(projectId, date);
      return e.day && e.day.businessDate === date
        ? { foreman: e.day.foreman ?? null, version: e.session.version }
        : null;
    },
    release: (date, owner, outcome) =>
      store.release(store.entry(projectId, date), owner, outcome),
    abandon: (date, owner) =>
      store.abandon(store.entry(projectId, date), owner),
  };
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
          hold: (owner) =>
            this.day?.hold(businessDate, owner) ??
            Promise.resolve({ outcome: 'failed', version: 0 }),
          current: () => this.day?.current(businessDate) ?? null,
          release: (owner, outcome) =>
            this.day?.release(businessDate, owner, outcome) ??
            Promise.resolve(false),
          abandon: (owner) => this.day?.abandon(businessDate, owner),
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
