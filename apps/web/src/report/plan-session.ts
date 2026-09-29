import type { PlanRowDto } from '@mje/contracts';
import { dec } from '@mje/domain/rules';
import { ApiError, type PlanView, type ReportApi } from '../api.js';

type PlanApi = Pick<ReportApi, 'plan' | 'savePlanDraft' | 'confirmPlan'>;
const valid = (rows: PlanRowDto[]) =>
  rows.every((r) => r.target === '' || dec(r.target) !== null);

/**
 * Tomorrow's plan for one project and target date, kept for the life of the workspace so a
 * pending save survives the editor unmounting. Draft writes and the confirmation run through
 * one queue, each write sending the rows current when it runs. While confirming, edits are
 * refused, and the confirmation covers exactly the rows the last write acknowledged.
 */
export class PlanSession {
  plan: PlanView | null = null;
  rows: PlanRowDto[] = [];
  error: string | null = null;
  confirming = false;
  private saved: PlanRowDto[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reads = 0;
  /** Bumped by every edit, acknowledged write and confirmation. */
  private generation = 0;

  constructor(
    private readonly api: PlanApi,
    readonly projectId: string,
    readonly target: string,
    private readonly notify: () => void,
    private readonly delayMs = 600,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  get dirty() {
    return this.saved !== null && this.rows !== this.saved;
  }

  /**
   * Load from the server. Only the newest read applies, and only if nothing was edited,
   * written or confirmed since it started: an older read never replaces newer rows.
   */
  async load() {
    const ticket = ++this.reads;
    const startedAt = this.generation;
    try {
      const p = await this.api.plan(this.projectId, this.target);
      if (ticket !== this.reads || startedAt !== this.generation) return;
      this.plan = p;
      if (!this.dirty) {
        this.rows = p.rows;
        this.saved = p.rows;
      }
      this.error = null;
    } catch (e) {
      if (ticket === this.reads)
        this.error = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
    }
    this.notify();
  }

  edit(rows: PlanRowDto[]): boolean {
    if (this.confirming) return false;
    this.rows = rows;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(() => undefined);
    }, this.delayMs);
    this.notify();
    return true;
  }

  /** Write pending rows now (used on leave and before confirming). Rejects on failure. */
  save(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueue(async () => {
      const rows = this.rows;
      if (rows === this.saved || !valid(rows)) return;
      try {
        const r = await this.api.savePlanDraft({
          projectId: this.projectId,
          targetBusinessDate: this.target,
          clientMutationId: this.newId(),
          rows,
        });
        this.saved = rows;
        this.generation++;
        if (this.plan)
          this.plan = { ...this.plan, status: r.status, draft: rows };
        this.error = null;
      } catch (e) {
        this.error = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
        throw e;
      } finally {
        this.notify();
      }
    });
  }

  async confirm(): Promise<void> {
    this.confirming = true;
    this.notify();
    try {
      if (!valid(this.rows)) throw new ApiError('NUMBER_INVALID', 409);
      await this.save();
      await this.enqueue(() =>
        this.api.confirmPlan({
          projectId: this.projectId,
          targetBusinessDate: this.target,
          clientMutationId: this.newId(),
        }),
      );
      this.saved = null;
      this.generation++;
      await this.load();
    } catch (e) {
      this.error = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      throw e;
    } finally {
      this.confirming = false;
      this.notify();
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
