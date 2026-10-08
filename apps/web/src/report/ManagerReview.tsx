import { useState, useSyncExternalStore } from 'react';
import type { CompletionReviewDecisionDto } from '../../../../packages/contracts/src/manager-review.js';
import { outcomeKey } from '../field/errors.js';
import { useI18n } from '../i18n.js';
import { shown } from './format.js';
import {
  reviewCanAct,
  visibleReviewState,
  type ManagerReviewRead,
  type ManagerReviewSession,
  type OwnedReview,
  type ReviewInput,
} from './review-session.js';

/** Local copy remains injectable until the shared messages holder integrates these keys. */
export const MANAGER_REVIEW_COPY = {
  en: {
    title: 'Completion review',
    original: 'Original declaration',
    revision: 'Revision',
    evidence: 'Evidence coverage',
    noEvidence: 'Evidence is missing or its scope is unconfirmed',
    declarationOnly:
      'Declaration, adoption, quality acceptance and billing are separate.',
    NOT_CHECKED: 'Not checked',
    REVIEW_REQUIRED: 'Review required',
    CONFIRMED_SCOPE: 'Checked scope',
    INCONCLUSIVE: 'Further review needed',
    RETURNED: 'Returned for correction',
    NONE: 'No checked quantity',
    PARTIAL: 'Partial scope',
    FULL: 'Whole scope',
    declared: 'Declared quantity',
    checked: 'Checked quantity',
    blank: 'Blank',
    unknown: 'Unknown',
    na: 'Not applicable',
    confirm: 'Confirm checked scope',
    inconclusive: 'Further review needed',
    return: 'Return for correction',
    scope: 'Scope',
    qty: 'Partial checked quantity',
    whole: 'Whole declaration',
    partial: 'Evidence scope only',
    reason: 'Reason',
    method: 'Review method',
    limitations: 'Limitations',
    preview: 'Review before sending',
    send: 'Send this judgment',
    cancel: 'Back to editing',
    unavailable: 'Review authority or current evidence is unavailable',
    pending: 'Outcome unknown; retry this original judgment',
    running: 'Sending original judgment',
    retry: 'Retry original',
    discard: 'Give up and refresh',
    refresh: 'Refresh',
    savedStale: 'Judgment saved; refresh is required before editing',
    unknownStale: 'The earlier send may be recorded; refresh is required',
    refusedStale: 'Refresh is required before editing',
    loading: 'Load the current declaration',
    actorChanged: 'The original judgment belongs to another signed-in account',
    changed:
      'The declaration, review or evidence version changed. Refresh and review again.',
    invalid: 'Check the reason, method and checked quantity.',
  },
  zh: {
    title: '完成量核对',
    original: '原申报',
    revision: '版本',
    evidence: '证据覆盖',
    noEvidence: '缺少证据或覆盖范围尚未确认',
    declarationOnly: '申报、采用、质量验收和计费分别判断。',
    NOT_CHECKED: '待核对',
    REVIEW_REQUIRED: '需要重新核对',
    CONFIRMED_SCOPE: '范围已核对',
    INCONCLUSIVE: '待进一步核对',
    RETURNED: '退回待更正',
    NONE: '尚无已核量',
    PARTIAL: '部分范围',
    FULL: '完整范围',
    declared: '申报量',
    checked: '已核量',
    blank: '空白',
    unknown: '未知',
    na: '不适用',
    confirm: '确认核对范围',
    inconclusive: '待进一步核对',
    return: '退回更正',
    scope: '范围',
    qty: '局部已核量',
    whole: '整条申报',
    partial: '仅证据覆盖范围',
    reason: '原因',
    method: '核对方法',
    limitations: '局限说明',
    preview: '发送前核对',
    send: '发送本次判断',
    cancel: '返回编辑',
    unavailable: '缺少核对授权或当前证据',
    pending: '结果未知；可重试本次原判断',
    running: '正在发送原判断',
    retry: '重试原判断',
    discard: '放弃并刷新',
    refresh: '刷新',
    savedStale: '判断已保存；刷新后才能继续编辑',
    unknownStale: '之前的发送可能已记录；需要刷新',
    refusedStale: '刷新后才能继续编辑',
    loading: '请读取当前申报',
    actorChanged: '原判断属于另一个登录账号',
    changed: '申报、核对或证据版本已改变，请刷新后重新核对。',
    invalid: '请检查原因、核对方法和已核量。',
  },
};
export type ManagerReviewCopy = (typeof MANAGER_REVIEW_COPY)['en'];
export interface ReviewFormValues {
  decision: CompletionReviewDecisionDto;
  partial: boolean;
  qty: string;
  reason: string;
  method: string;
  limitations: string;
}
/** The preview captures its exact original revision/basis; send never rebinds these to a new read. */
export function managerReviewInput(
  d: ManagerReviewRead,
  v: ReviewFormValues,
): ReviewInput {
  const base = {
    target: { ...d.target },
    expectedRevision: d.revisionNumber,
    expectedVersion: d.reviewVersion,
    reason: v.reason,
    method: v.method,
    limitations: v.limitations,
  };
  if (v.decision !== 'CONFIRM_SCOPE')
    return {
      ...base,
      decision: v.decision,
      coverage: null,
      evidenceBasis: d.evidence ? { ...d.evidence.basis } : null,
    };
  if (!d.evidence?.coverage) throw new Error('EVIDENCE_REQUIRED');
  if (
    !v.partial &&
    (d.evidence.state !== 'READY' ||
      d.evidence.coverage.scopeRef !== d.scopeRef)
  )
    throw new Error('COVERAGE_INVALID');
  return {
    ...base,
    decision: v.decision,
    evidenceBasis: { ...d.evidence.basis },
    coverage: v.partial
      ? { kind: 'PARTIAL', scopeRef: d.evidence.coverage.scopeRef, qty: v.qty }
      : { kind: 'WHOLE' },
  };
}
function quantity(
  raw: string | null,
  locale: string,
  c: ManagerReviewCopy,
): string {
  const value = shown(raw ?? '', locale);
  return value.kind === 'blank'
    ? c.blank
    : value.kind === 'token'
      ? c[value.token]
      : value.kind === 'number'
        ? value.text
        : value.raw;
}

/** Session is created once by the workspace, never here or in a role-dependent tab. */
export function ManagerReview({
  session,
  copy,
}: {
  session: ManagerReviewSession;
  copy?: ManagerReviewCopy;
}) {
  useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const { lang, locale, t } = useI18n();
  const c = copy ?? MANAGER_REVIEW_COPY[lang === 'zh' ? 'zh' : 'en'];
  const owned = session.owned.current;
  const d = session.data;
  const error = session.localError ?? session.owned.refusal;
  const errorKey = outcomeKey(error, {
    write: true,
    uncertain: session.owned.refusalUncertain,
  });
  const pendingKey = outcomeKey(session.session.error, {
    write: true,
    uncertain: true,
  });
  const versionChanged =
    error &&
    [
      'TARGET_CHANGED',
      'FOREMAN_REVISION_CHANGED',
      'REVIEW_VERSION_CONFLICT',
      'EVIDENCE_CHANGED',
    ].includes(error);
  const message =
    error === 'ACTOR_CHANGED'
      ? c.actorChanged
      : versionChanged
        ? c.changed
        : error === 'INVALID_INPUT'
          ? c.invalid
          : error
            ? t(errorKey)
            : null;
  return (
    <section aria-label={c.title}>
      <h3>{c.title}</h3>
      <p>{c.declarationOnly}</p>
      {message && <p role="alert">{message}</p>}
      {owned ? (
        <div role="status">
          <p>{session.busy ? c.running : t(pendingKey)}</p>
          <ReviewPayload
            input={owned.command}
            declaration={owned.declaration}
            copy={c}
            locale={locale}
          />
          <button
            type="button"
            disabled={session.busy}
            onClick={() => {
              void session.retry();
            }}
          >
            {c.retry}
          </button>
          <button
            type="button"
            disabled={session.busy}
            onClick={() => {
              void session.discard();
            }}
          >
            {c.discard}
          </button>
        </div>
      ) : session.held ? (
        <p role="status">
          {session.lockOutcome === 'saved'
            ? c.savedStale
            : session.lockOutcome === 'unknown'
              ? c.unknownStale
              : c.refusedStale}
        </p>
      ) : null}
      {!d ? (
        <p>{c.loading}</p>
      ) : (
        <>
          <p>
            {c.original}: {d.target.businessDate} · {d.labels.crew} ·{' '}
            {d.labels.item} · {c.revision} {d.revisionNumber}
          </p>
          <p>
            {c.declared}: {quantity(d.declaredQty, locale, c)} {d.unit ?? ''}
          </p>
          <p>
            {c.evidence}:{' '}
            {d.evidence?.coverage
              ? `${quantity(d.evidence.coverage.qty, locale, c)} ${d.evidence.coverage.unit} · ${d.labels.scope ?? c.unknown}`
              : c.noEvidence}
          </p>
          <ReviewStatus data={d} copy={c} locale={locale} />
          {!owned && session.canStart && (
            <ReviewEditor
              key={`${d.target.foremanRevisionId}/${d.reviewVersion}/${d.evidence?.basis.linkSetId}/${d.evidence?.basis.version}/${session.owned.generation}`}
              data={d}
              session={session}
              copy={c}
              locale={locale}
            />
          )}
        </>
      )}
      <button
        type="button"
        disabled={session.busy}
        onClick={() => {
          void session.refresh();
        }}
      >
        {c.refresh}
      </button>
    </section>
  );
}
function ReviewStatus({
  data,
  copy: c,
  locale,
}: {
  data: ManagerReviewRead;
  copy: ManagerReviewCopy;
  locale: string;
}) {
  const state = visibleReviewState(data);
  return (
    <p>
      {c[state.status]} · {c[state.coverage]}
      {state.confirmedQty !== null
        ? ` · ${c.checked}: ${quantity(state.confirmedQty, locale, c)} ${state.unit ?? ''}`
        : ''}
    </p>
  );
}
function ReviewPayload({
  input,
  declaration,
  copy: c,
  locale,
}: {
  input: ReviewInput;
  declaration: OwnedReview['declaration'];
  copy: ManagerReviewCopy;
  locale: string;
}) {
  return (
    <div>
      <p>
        {input.target.businessDate} · {declaration.crew} · {declaration.item} ·{' '}
        {c.revision} {input.expectedRevision}
      </p>
      <p>
        {c.declared}: {quantity(declaration.qty, locale, c)}{' '}
        {declaration.unit ?? ''}
      </p>
      <p>
        {input.decision === 'RETURN'
          ? c.return
          : input.decision === 'INCONCLUSIVE'
            ? c.inconclusive
            : c.confirm}
      </p>
      {input.coverage && (
        <p>
          {c.scope}:{' '}
          {input.coverage.kind === 'WHOLE'
            ? c.whole
            : `${input.coverage.scopeRef} · ${quantity(input.coverage.qty, locale, c)}`}
        </p>
      )}
      <p>
        {c.reason}: {input.reason}
      </p>
      <p>
        {c.method}: {input.method}
      </p>
      <p>
        {c.limitations}: {input.limitations}
      </p>
    </div>
  );
}
function ReviewEditor({
  data,
  session,
  copy: c,
  locale,
}: {
  data: ManagerReviewRead;
  session: ManagerReviewSession;
  copy: ManagerReviewCopy;
  locale: string;
}) {
  const [v, set] = useState<ReviewFormValues>({
    decision: 'RETURN',
    partial:
      data.evidence?.state !== 'READY' ||
      data.evidence?.coverage?.scopeRef !== data.scopeRef,
    qty: '',
    reason: '',
    method: '',
    limitations: '',
  });
  const [preview, setPreview] = useState<ReviewInput | null>(null);
  const canWhole =
    data.evidence?.state === 'READY' &&
    data.evidence.coverage?.scopeRef === data.scopeRef;
  if (preview)
    return (
      <div>
        <h4>{c.preview}</h4>
        <ReviewPayload
          input={preview}
          declaration={{
            qty: data.declaredQty,
            unit: data.unit,
            crew: data.labels.crew,
            item: data.labels.item,
          }}
          copy={c}
          locale={locale}
        />
        <button
          type="button"
          onClick={() => {
            void session.start(preview);
          }}
        >
          {c.send}
        </button>
        <button type="button" onClick={() => setPreview(null)}>
          {c.cancel}
        </button>
      </div>
    );
  const allowed = reviewCanAct(data, v.decision);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (allowed) setPreview(managerReviewInput(data, v));
      }}
    >
      <label>
        {c.title}
        <select
          value={v.decision}
          onChange={(e) =>
            set({
              ...v,
              decision: e.target.value as CompletionReviewDecisionDto,
            })
          }
        >
          <option value="RETURN" disabled={!reviewCanAct(data, 'RETURN')}>
            {c.return}
          </option>
          <option
            value="INCONCLUSIVE"
            disabled={!reviewCanAct(data, 'INCONCLUSIVE')}
          >
            {c.inconclusive}
          </option>
          <option
            value="CONFIRM_SCOPE"
            disabled={!reviewCanAct(data, 'CONFIRM_SCOPE')}
          >
            {c.confirm}
          </option>
        </select>
      </label>
      {v.decision === 'CONFIRM_SCOPE' && (
        <>
          <label>
            {c.scope}
            <select
              value={v.partial ? 'PARTIAL' : 'WHOLE'}
              onChange={(e) =>
                set({ ...v, partial: e.target.value === 'PARTIAL' })
              }
            >
              <option value="WHOLE" disabled={!canWhole}>
                {c.whole}
              </option>
              <option value="PARTIAL">{c.partial}</option>
            </select>
          </label>
          {v.partial && (
            <label>
              {c.qty}
              <input
                inputMode="decimal"
                required
                value={v.qty}
                onChange={(e) => set({ ...v, qty: e.target.value })}
              />
            </label>
          )}
        </>
      )}
      <label>
        {c.reason}
        <textarea
          required={v.decision !== 'CONFIRM_SCOPE'}
          maxLength={500}
          value={v.reason}
          onChange={(e) => set({ ...v, reason: e.target.value })}
        />
      </label>
      <label>
        {c.method}
        <textarea
          required={v.decision === 'CONFIRM_SCOPE'}
          maxLength={500}
          value={v.method}
          onChange={(e) => set({ ...v, method: e.target.value })}
        />
      </label>
      <label>
        {c.limitations}
        <textarea
          maxLength={500}
          value={v.limitations}
          onChange={(e) => set({ ...v, limitations: e.target.value })}
        />
      </label>
      {!allowed && <p>{c.unavailable}</p>}
      <button type="submit" disabled={!allowed}>
        {c.preview}
      </button>
    </form>
  );
}
