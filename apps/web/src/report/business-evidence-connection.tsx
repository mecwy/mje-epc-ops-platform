import { createContext, useContext, useEffect, useReducer } from 'react';
import type {
  BusinessEvidenceCommand,
  EvidenceTarget,
  EvidenceWorkspace,
  ManagerReviewReadDto,
  ManagerReviewScopeDto,
  ReviewForemanCommand,
} from '@mje/contracts';
import { ApiError, type ReportApi } from '../api.js';
import { UNSETTLED } from '../field/session.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { DayStore } from './day-store.js';
import { EvidenceSession, type EvidencePort } from './evidence-session.js';
import { FactEvidenceCard, type EvidenceCardCopy } from './FactEvidenceCard.js';
import { ManagerReview } from './ManagerReview.js';
import {
  ManagerReviewSession,
  type ManagerReviewService,
  type ReviewDayLock,
  type ReviewScope,
} from './review-session.js';

export interface FieldEvidenceServices {
  review: ManagerReviewService;
  evidence: EvidencePort;
}
export interface FieldEvidenceApi {
  readManagerReview(
    scope: ManagerReviewScopeDto,
  ): Promise<ManagerReviewReadDto>;
  writeManagerReview(command: ReviewForemanCommand): Promise<unknown>;
  readBusinessEvidence(target: EvidenceTarget): Promise<EvidenceWorkspace>;
  writeBusinessEvidence(command: BusinessEvidenceCommand): Promise<unknown>;
}
/** No substitute provider: until the real HTTP functions are mounted, no disconnected cards. */
export function fieldEvidenceServices(
  api: Partial<FieldEvidenceApi>,
): FieldEvidenceServices | null {
  if (
    !api.readManagerReview ||
    !api.writeManagerReview ||
    !api.readBusinessEvidence ||
    !api.writeBusinessEvidence
  )
    return null;
  return {
    review: {
      read: (scope) => api.readManagerReview!(scope),
      write: async (command) => {
        await api.writeManagerReview!(command);
      },
    },
    evidence: {
      read: (target) => api.readBusinessEvidence!(target),
      command: (input) => api.writeBusinessEvidence!(input),
    },
  };
}
/** Captures this project/day. Navigation cannot release a different day's mutation owner. */
export function managerReviewDayLock(
  store: DayStore,
  projectId: string,
  businessDate: string,
): ReviewDayLock {
  const entry = store.entry(projectId, businessDate);
  return {
    holds: (owner) => entry.lock === owner,
    acquire: (owner) => store.acquire(entry, owner),
    prepare: async (owner) => {
      const held = await store.hold(entry, owner);
      // DraftSession keeps its own original save/key on failure; no review is sent yet.
      return held.outcome === 'ok'
        ? 'ok'
        : held.outcome === 'failed'
          ? 'unknown'
          : 'blocked';
    },
    abandon: (owner) => store.abandon(entry, owner),
    release: (owner, outcome) => store.release(entry, owner, outcome),
  };
}
export interface ConnectedClaim {
  evidence: EvidenceSession;
  review: ManagerReviewSession | null;
  reviewError: string | null;
  loadReview: () => Promise<void>;
}
export interface FieldEvidenceRecoveryRow {
  key: string;
  target: EvidenceTarget;
  kind: 'evidence' | 'review';
  busy: boolean;
  unresolved: boolean;
  held: boolean;
  code: string | null;
  retry: () => Promise<unknown>;
  discard: () => void | Promise<void>;
  refresh: () => Promise<unknown>;
}
const sameActor = (key: string, actor: string) =>
  key.split(':').length === 3 &&
  !!key.split(':')[0] &&
  key.split(':').slice(1).join(':') === actor;
const sameTarget = (a: EvidenceTarget, b: EvidenceTarget) =>
  a.projectId === b.projectId &&
  a.businessDate === b.businessDate &&
  a.crewId === b.crewId &&
  a.foremanRevisionId === b.foremanRevisionId &&
  a.itemKey === b.itemKey;
type DayApi = Pick<ReportApi, 'day' | 'revision' | 'saveFacts'>;

/** Workspace-owned instances survive tab/date changes; an original command stays with its actor. */
export class FieldEvidenceWorkspace {
  private readonly claims = new Map<
    string,
    {
      actor: string;
      claim: ConnectedClaim;
      evidenceHeld: () => boolean;
      evidenceBusy: () => boolean;
      refreshEvidence: () => Promise<void>;
    }
  >();
  private readonly stores = new Map<string, DayStore>();
  private readonly dayApis = new Map<string, DayApi>();
  private readonly listeners = new Set<() => void>();
  private active: { actor: string; services: FieldEvidenceServices } | null =
    null;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  bind(actor: string, services: FieldEvidenceServices) {
    this.active = { actor, services };
    this.changed();
  }
  /** One canonical day owner per verified actor/project, independent of React mount/session. */
  dayStoreFor(actor: string, projectId: string, api: DayApi): DayStore {
    this.services(actor);
    const key = `${actor}:${projectId}`;
    this.dayApis.set(key, api);
    let store = this.stores.get(key);
    if (!store) {
      const requireTransportActor = () => {
        // A local session transition is not a definitive server refusal of a saved draft.
        if (this.active?.actor !== actor) throw new ApiError('RETRY', 409);
      };
      const current = () => {
        requireTransportActor();
        return this.dayApis.get(key)!;
      };
      const transport: DayApi = {
        day: async (...args) => {
          const result = await current().day(...args);
          requireTransportActor();
          return result;
        },
        revision: async (...args) => {
          const result = await current().revision(...args);
          requireTransportActor();
          return result;
        },
        // A sent response settles only this actor's canonical store, even after navigation.
        saveFacts: (...args) => current().saveFacts(...args),
      };
      store = new DayStore(transport, () => {});
      store.subscribe(() => this.changed());
      this.stores.set(key, store);
    }
    return store;
  }
  dayStore(projectId: string, store: DayStore) {
    // The report remains usable when the optional evidence HTTP services are unavailable.
    // An unbound store is never registered as an authenticated actor's evidence owner.
    if (!this.active) return;
    const key = `${this.active.actor}:${projectId}`;
    const existing = this.stores.get(key);
    if (existing && existing !== store) throw new ApiError('NOT_CONNECTED', 0);
    if (!existing) {
      store.subscribe(() => this.changed());
      this.stores.set(key, store);
    }
  }
  private services(actor: string) {
    if (this.active?.actor !== actor) throw new ApiError('FORBIDDEN', 403);
    return this.active.services;
  }
  clearActor() {
    this.active = null;
    this.changed();
  }
  /** Recovery belongs to the original command, independently of the current crew list/day. */
  recoveries(actor: string): FieldEvidenceRecoveryRow[] {
    if (this.active?.actor !== actor) return [];
    const rows: FieldEvidenceRecoveryRow[] = [];
    for (const [key, record] of this.claims) {
      if (record.actor !== actor) continue;
      const { evidence, review } = record.claim;
      const held = record.evidenceHeld();
      if (evidence.actions.current || held)
        rows.push({
          key: `${key}:evidence`,
          target: evidence.target,
          kind: 'evidence',
          busy: record.evidenceBusy(),
          unresolved: evidence.actions.unresolved !== null,
          held,
          code: evidence.list.error,
          retry: () => evidence.retry(),
          discard: () => evidence.discard(),
          refresh: record.refreshEvidence,
        });
      if (review && (review.owned.current || review.held))
        rows.push({
          key: `${key}:review`,
          target: evidence.target,
          kind: 'review',
          busy: review.busy,
          unresolved: review.owned.unresolved !== null,
          held: review.held,
          code: review.session.error ?? review.localError,
          retry: () => review.retry(),
          discard: () => review.discard(),
          refresh: () => review.refresh(),
        });
    }
    return rows;
  }
  claim(actor: string, target: EvidenceTarget): ConnectedClaim {
    this.services(actor);
    const key = JSON.stringify([
      actor,
      target.projectId,
      target.businessDate,
      target.crewId,
      target.foremanRevisionId,
      target.itemKey,
    ]);
    const existing = this.claims.get(key);
    if (existing) return existing.claim;
    const store = this.stores.get(`${actor}:${target.projectId}`);
    if (!store) throw new ApiError('NOT_CONNECTED', 0);
    const lock = managerReviewDayLock(
      store,
      target.projectId,
      target.businessDate,
    );
    const scope: ReviewScope = {
      projectId: target.projectId,
      businessDate: target.businessDate,
      crewId: target.crewId,
      itemKey: target.itemKey,
    };
    let heldOwner: string | null = null;
    let evidenceSettling = false;
    const isActive = () => this.active?.actor === actor;
    const requireCommandActor = () => {
      // A local account transition is no server verdict on an original unknown write.
      if (!isActive()) throw new ApiError('RETRY', 409);
    };
    const entry = store.entry(target.projectId, target.businessDate);
    const evidenceHeld = () => {
      return heldOwner !== null && entry.lock === heldOwner;
    };
    const notify = () => this.changed();
    // A retry uses the original command/key. Only a definitive outcome triggers the parent's reread.
    const command = async (input: BusinessEvidenceCommand) => {
      requireCommandActor();
      const owner = input.clientMutationId;
      if (!lock.acquire(owner)) throw new ApiError('BUSY', 409);
      heldOwner = owner;
      let attempted = false;
      try {
        const prepared = await lock.prepare(owner);
        if (prepared !== 'ok')
          throw new ApiError(
            prepared === 'unknown' ? 'NETWORK' : 'READ_ONLY',
            409,
          );
        requireCommandActor();
        attempted = true;
        const receipt = await this.services(actor).evidence.command(input);
        if (await lock.release(owner, 'saved')) heldOwner = null;
        return receipt;
      } catch (error) {
        if (!(error instanceof ApiError) || UNSETTLED.has(error.code))
          throw error;
        if (attempted) {
          if (await lock.release(owner, 'refused')) heldOwner = null;
        } else {
          lock.abandon(owner);
          heldOwner = null;
        }
        throw error;
      }
    };
    class DayBoundEvidenceSession extends EvidenceSession {
      override get canEdit() {
        return (
          super.canEdit &&
          isActive() &&
          !evidenceHeld() &&
          !evidenceSettling &&
          entry.lock === null
        );
      }
      override retry() {
        return isActive()
          ? super.retry()
          : Promise.resolve({ kind: 'failed' as const, code: 'ACTOR_CHANGED' });
      }
      override discard() {
        if (!isActive() || this.list.busy || evidenceSettling) return;
        super.discard();
        if (evidenceHeld()) {
          const owner = heldOwner!;
          evidenceSettling = true;
          void lock
            .release(owner, 'unknown')
            .then((released) => {
              if (released && heldOwner === owner) heldOwner = null;
            })
            .catch(() => {
              /* Parent remains locked until its existing refresh succeeds. */
            })
            .finally(() => {
              evidenceSettling = false;
              notify();
            });
        }
      }
    }
    const evidence = new DayBoundEvidenceSession(target, {
      read: async (input) => {
        const result = await this.services(actor).evidence.read(input);
        this.services(actor);
        return result;
      },
      command,
    });
    let loading: Promise<void> | null = null;
    const claim: ConnectedClaim = {
      evidence,
      review: null,
      reviewError: null,
      loadReview: () => {
        if (loading) return loading;
        loading = (async () => {
          try {
            const read = await this.services(actor).review.read(scope);
            this.services(actor);
            if (!sameActor(read.actorScopeKey, actor))
              throw new ApiError('FORBIDDEN', 403);
            if (!sameTarget(read.target, target))
              throw new ApiError('TARGET_CHANGED', 409);
            if (!claim.review) {
              class ActorBoundReviewSession extends ManagerReviewSession {
                override get canStart() {
                  return isActive() && super.canStart;
                }
                override async retry() {
                  if (!isActive())
                    return { kind: 'failed' as const, code: 'ACTOR_CHANGED' };
                  return super.retry();
                }
                override async discard() {
                  if (isActive()) await super.discard();
                }
                override async refresh() {
                  return isActive() ? super.refresh() : false;
                }
              }
              const review = new ActorBoundReviewSession(
                scope,
                read.actorScopeKey,
                {
                  read: async (input) => {
                    const current =
                      await this.services(actor).review.read(input);
                    this.services(actor);
                    if (!sameTarget(current.target, target))
                      throw new ApiError('TARGET_CHANGED', 409);
                    return current;
                  },
                  write: (input) => {
                    requireCommandActor();
                    return this.services(actor).review.write(input);
                  },
                },
                lock,
              );
              claim.review = review;
              review.subscribe(() => this.changed());
            }
            await claim.review.load();
            claim.reviewError = claim.review.session.readError;
          } catch (error) {
            claim.reviewError =
              error instanceof ApiError ? error.code : 'NETWORK';
          } finally {
            loading = null;
            this.changed();
          }
        })();
        return loading;
      },
    };
    evidence.subscribe(() => this.changed());
    this.claims.set(key, {
      actor,
      claim,
      evidenceHeld,
      evidenceBusy: () => evidence.list.busy || evidenceSettling,
      refreshEvidence: async () => {
        if (
          this.active?.actor !== actor ||
          evidence.list.busy ||
          evidenceSettling ||
          evidence.actions.current ||
          !evidenceHeld()
        ) {
          this.changed();
          return;
        }
        evidenceSettling = true;
        this.changed();
        try {
          await store.reloadLocked(entry);
          evidenceHeld();
        } finally {
          evidenceSettling = false;
          this.changed();
        }
      },
    });
    return claim;
  }
}
/** Always mounted at workspace level; no quantity or personnel payload is disclosed here. */
export function FieldEvidenceRecovery({
  owner,
  actor,
  projectLabel,
}: {
  owner: FieldEvidenceWorkspace;
  actor: string | null;
  projectLabel: (projectId: string) => string;
}) {
  const { lang, t } = useI18n();
  const [, update] = useReducer((n: number) => n + 1, 0);
  useEffect(() => owner.subscribe(update), [owner]);
  const rows = actor ? owner.recoveries(actor) : [];
  if (rows.length === 0) return null;
  return (
    <section className="card" aria-label={t('fm_unresolvedTitle')}>
      <h2>{t('fm_unresolvedTitle')}</h2>
      <ul className="plainlist">
        {rows.map((row) => (
          <li key={row.key} className="devrow">
            <span className="grow">
              <b>
                {row.kind === 'evidence'
                  ? lang === 'zh'
                    ? '照片关联'
                    : 'Photo association'
                  : lang === 'zh'
                    ? '完成量核对'
                    : 'Quantity review'}{' '}
                · {projectLabel(row.target.projectId)} ·{' '}
                {row.target.businessDate}
              </b>
              <span role="status">
                {row.busy ? (
                  t('saving')
                ) : row.unresolved ? (
                  <ErrorText code={row.code ?? 'NETWORK'} write uncertain />
                ) : (
                  t('dayRereadFailed')
                )}
              </span>
            </span>
            {row.unresolved ? (
              <span className="chips">
                <button
                  type="button"
                  className="pill"
                  disabled={row.busy}
                  onClick={() => void row.discard()}
                >
                  {t('pm_giveUp')}
                </button>
                <button
                  type="button"
                  className="pill accent"
                  disabled={row.busy}
                  onClick={() => void row.retry()}
                >
                  {t('retry')}
                </button>
              </span>
            ) : (
              row.held && (
                <button
                  type="button"
                  className="pill"
                  disabled={row.busy}
                  onClick={() => void row.refresh()}
                >
                  {t('pm_reload')}
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
export const BusinessEvidenceContext = createContext<{
  owner: FieldEvidenceWorkspace;
  actor: string;
  projectId: string;
  businessDate: string;
  /** Current-only provider cannot substitute live evidence for a submitted snapshot. */
  submitted?: boolean;
} | null>(null);

function evidenceCopy(
  en: boolean,
  error: EvidenceCardCopy['error'],
): EvidenceCardCopy {
  return {
    title: en ? 'Quantity evidence' : '工程量证据',
    notConnected: en ? 'Unavailable' : '暂不可用',
    loading: en ? 'Loading' : '读取中',
    declared: en ? 'Declared' : '申报量',
    coverage: en ? 'Covered quantity' : '覆盖量',
    unknown: '—',
    factAllowed: '',
    availabilityOnly: '',
    state: en
      ? {
          MISSING: 'Evidence missing',
          PARTIAL: 'Partial coverage',
          READY: 'Evidence available',
          UNCONFIRMED_SCOPE: 'Scope pending',
        }
      : {
          MISSING: '缺少证据',
          PARTIAL: '部分覆盖',
          READY: '证据可用',
          UNCONFIRMED_SCOPE: '范围待确认',
        },
    photo: en ? 'Photo' : '照片',
    scope: en ? 'Scope' : '范围',
    qty: en ? 'Quantity' : '数量',
    bind: en ? 'Associate' : '关联',
    unbind: en ? 'Remove association' : '解除关联',
    retry: en ? 'Retry' : '重试',
    refresh: en ? 'Refresh' : '刷新',
    discard: en ? 'Cancel retry' : '取消重试',
    pending: en ? 'Outcome pending' : '结果待确认',
    history: en ? 'Evidence history' : '证据历史',
    linkedPhoto: en ? 'Associated photo' : '关联照片',
    error,
  };
}
/** Lives beside the original crew claim. No additional quantity/adoption ledger. */
export function BusinessEvidenceConnection({
  crewId,
  foremanRevisionId,
  itemKey,
}: {
  crewId: string;
  foremanRevisionId: string;
  itemKey: string;
}) {
  const context = useContext(BusinessEvidenceContext);
  const { lang, t } = useI18n();
  const [, update] = useReducer((n: number) => n + 1, 0);
  useEffect(() => context?.owner.subscribe(update), [context?.owner]);
  const claim =
    context && !context.submitted
      ? context.owner.claim(context.actor, {
          projectId: context.projectId,
          businessDate: context.businessDate,
          crewId,
          foremanRevisionId,
          itemKey,
        })
      : null;
  useEffect(() => {
    if (claim) void claim.loadReview();
  }, [claim]);
  if (context?.submitted)
    return (
      <p role="status">
        {lang === 'zh'
          ? '已提交证据暂不可用'
          : 'Submitted evidence unavailable'}
      </p>
    );
  if (!claim) return null;
  return (
    <div className="crew-evidence">
      <FactEvidenceCard
        session={claim.evidence}
        copy={evidenceCopy(lang !== 'zh', (key) => t(key))}
      />
      {claim.review ? (
        <ManagerReview session={claim.review} />
      ) : (
        claim.reviewError && (
          <p role="status">
            {lang !== 'zh' ? 'Review unavailable' : '暂不可复核'}
          </p>
        )
      )}
    </div>
  );
}
