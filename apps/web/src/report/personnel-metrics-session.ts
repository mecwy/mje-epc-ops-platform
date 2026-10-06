import type { PeopleWindowSummaryDto } from '@mje/contracts';
import { ApiError } from '../api.js';
import { FieldSession } from '../field/session.js';

/** Adapter must parse the safe contract projection at the API boundary. No new writes. */
export interface PersonnelMetricsApi {
  peopleWindow(
    projectId: string,
    businessDate: string,
  ): Promise<PeopleWindowSummaryDto>;
}

/** Retain one instance per authorized project/date window; use a new one on scope change. */
export class PersonnelMetricsSession {
  readonly read: FieldSession<PeopleWindowSummaryDto>;
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(
    api: PersonnelMetricsApi,
    readonly projectId: string,
    readonly businessDate: string,
  ) {
    this.read = new FieldSession(
      async () => {
        const data = await api.peopleWindow(projectId, businessDate);
        if (
          data.projectId !== projectId ||
          data.windowTo !== businessDate ||
          data.schemaVersion !== 1 ||
          data.basis !== 'declared_category_day_sum' ||
          data.policyVersion !== 'personnel-category-seven-slots-v1' ||
          data.slotDays !== 7
        )
          throw new ApiError('INVALID_RESPONSE', 502);
        return data;
      },
      () => {
        this.generation++;
        for (const listener of this.listeners) listener();
      },
    );
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): number => this.generation;
  get summary(): PeopleWindowSummaryDto | null {
    // Never present a previously successful aggregate as current after any failed read.
    return this.read.readError === null ? this.read.data : null;
  }
  refresh(): Promise<boolean> {
    return this.read.load();
  }
}
