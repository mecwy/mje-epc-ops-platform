import { useEffect, useReducer, useRef, useState } from 'react';
import { LANGS, type Lang, type MessageKey } from '@mje/ui';
import type {
  OpportunityHistoryDto,
  OpportunityLookupsDto,
  OpportunityWorklistsDto,
  OpportunityFacts,
} from '@mje/contracts';
import { ApiError, opportunityApi } from '../api.js';
import { FieldSession } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { ReadFence } from '../read-fence.js';
import { useI18n } from '../i18n.js';
import { outcomeKey } from '../field/errors.js';
import { message, failureKey, readFailureKey } from '../contracts/messages.js';
import {
  changedFields,
  freezeAction,
  newDraft,
  OpportunityDrafts,
  parseAction,
  rebase,
  type OpportunityAction,
  type OpportunityDraft,
} from './drafts.js';
import { Form, factLabels } from './Form.js';
import {
  FieldValue,
  HistoryView,
  ItemView,
  ProtectedText,
  UpdateView,
  ValueText,
  personName,
} from './View.js';
interface Bundle {
  lookups: OpportunityLookupsDto;
  worklists: OpportunityWorklistsDto;
}
const refusedBeforeReplay = new Set([
  'FORBIDDEN',
  'NOT_FOUND',
  'LOGIN_REQUIRED',
  'UNAUTHORIZED',
  'PROXY_INVALID',
]);
const conflictCodes = new Set([
  'VERSION_CONFLICT',
  'FIELD_CONFLICT',
  'STEP_CONFLICT',
  'REQUEST_CONFLICT',
  'DECISION_CONFLICT',
  'IDENTITY_EXISTS',
]);
function storage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
export function OpportunitiesWorkspace({
  token,
  signOut,
  renew,
  expired,
}: {
  token: () => Promise<string>;
  signOut: (() => void) | null;
  renew: (() => Promise<void>) | null;
  expired: boolean;
}) {
  const { t, lang, setLang } = useI18n(),
    [, render] = useReducer((x) => x + 1, 0),
    tokenRef = useRef(token);
  tokenRef.current = token;
  const [api] = useState(() => opportunityApi(() => tokenRef.current()));
  const [session] = useState(
    () =>
      new FieldSession<Bundle>(async () => {
        const [lookups, worklists] = await Promise.all([
          api.lookups(),
          api.worklists(),
        ]);
        if (lookups.accountId !== worklists.accountId)
          throw new ApiError('FORBIDDEN', 403);
        return { lookups, worklists };
      }, render),
  );
  const actionRef = useRef<OpportunityAction | null>(null),
    actionAccount = useRef<string | null>(null),
    [owned] = useState(
      () =>
        new OwnedCommands<Bundle, OpportunityAction>(
          session,
          () => actionRef.current?.body.clientMutationId ?? crypto.randomUUID(),
        ),
    );
  const [selected, select] = useState<string | null>(null),
    [draft, setDraft] = useState<OpportunityDraft | null>(null),
    draftRef = useRef(draft);
  draftRef.current = draft;
  const [notice, setNotice] = useState<string | null>(null),
    [saved, setSaved] = useState(false),
    [storageFailure, setStorageFailure] = useState(false),
    [savedAwaitRead, setSavedAwaitRead] = useState(false),
    [priorUnknown, setPriorUnknown] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [history, setHistory] = useState<{
      accountId: string;
      id: string;
      value: OpportunityHistoryDto;
    } | null>(null),
    [historyError, setHistoryError] = useState<string | null>(null),
    historyFence = useRef(new ReadFence());
  const [compare, setCompare] = useState(false),
    [choices, setChoices] = useState<
      Partial<Record<keyof OpportunityFacts, 'mine' | 'latest'>>
    >({}),
    [stepChoice, setStepChoice] = useState<OpportunityDraft['nextMode'] | null>(
      null,
    );
  const data = session.data,
    lookups = data?.lookups,
    accountId = lookups?.accountId,
    item = data?.worklists.items.find((x) => x.id === selected),
    latest = draft
      ? data?.worklists.items.find((x) => x.id === draft.opportunityId)
      : undefined;
  const accountRef = useRef<string | null>(null);
  function draftsFor(id: string) {
    const s = storage();
    return s ? new OpportunityDrafts(s, id) : null;
  }
  function change(d: OpportunityDraft | null) {
    draftRef.current = d;
    setDraft(d);
    if (d)
      try {
        draftsFor(d.accountId)?.save(d);
      } catch {
        setStorageFailure(true);
      }
  }
  useEffect(() => {
    void session.load();
  }, [session]);
  useEffect(() => {
    if (!accountId || accountRef.current === accountId) return;
    accountRef.current = accountId;
    select(null);
    setHistory(null);
    setHistoryOpen(false);
    setCompare(false);
    setNotice(null);
    if (owned.owned) {
      setDraft(null);
      draftRef.current = null;
      return;
    }
    const restored = draftsFor(accountId)?.load() ?? null;
    draftRef.current = restored;
    setDraft(restored);
    if (restored?.unresolved) {
      actionRef.current = restored.unresolved;
      actionAccount.current = restored.accountId;
      setPriorUnknown(true);
    } else {
      actionRef.current = null;
      actionAccount.current = null;
      setPriorUnknown(false);
    }
  }, [accountId, owned]);
  useEffect(() => {
    const fence = historyFence.current;
    fence.supersedeAll();
    setHistory(null);
    setHistoryError(null);
    if (!historyOpen || !selected || !accountId || !item || session.readError)
      return;
    const ticket = fence.begin();
    api
      .history(selected)
      .then((value) => {
        if (fence.settle(ticket, true) === 'applied')
          setHistory({ id: selected, accountId, value });
      })
      .catch((e) => {
        if (fence.settle(ticket, false) === 'applied')
          setHistoryError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
      });
    return () => fence.supersedeAll();
  }, [api, selected, accountId, historyOpen, item?.version, session.readError]);
  function clearDraft(id: string) {
    try {
      draftsFor(id)?.remove();
    } catch {
      setStorageFailure(true);
    }
    change(null);
    actionRef.current = null;
    actionAccount.current = null;
    setPriorUnknown(false);
    setSavedAwaitRead(false);
  }
  const uncertain =
    priorUnknown || owned.refusalUncertain || session.errorUncertain;
  const pending =
    owned.current ??
    draft?.unresolved ??
    (savedAwaitRead ? actionRef.current : null);
  const noWrite =
    !!draft &&
    (draft.kind === 'create'
      ? !lookups?.canCreateLead
      : draft.kind === 'decide'
        ? !latest?.capabilities.decide
        : !latest?.capabilities.maintain);
  const blocked =
    owned.owned ||
    !!draft?.unresolved ||
    savedAwaitRead ||
    !!session.readError ||
    expired ||
    noWrite;
  const wrongAccount =
    !!actionAccount.current &&
    !!accountId &&
    actionAccount.current !== accountId;
  function start(kind: OpportunityAction['kind']) {
    if (!lookups || blocked || draft) return;
    const d = newDraft(
      lookups.accountId,
      lookups.personId,
      kind,
      () => crypto.randomUUID(),
      kind === 'create' ? null : (item ?? null),
    );
    change(d);
    setSaved(false);
    setNotice(null);
    // Starting another editor follows a settled action, so its old error must
    // not appear as a validation failure of this new draft.
    session.discard();
    owned.clearRefusal();
    setCompare(false);
  }
  async function settle(
    result: Awaited<ReturnType<typeof owned.run>>,
    action: OpportunityAction,
    ownerId: string,
    wasUnknown: boolean,
  ) {
    if (result.kind === 'ok') {
      setSaved(true);
      select(action.body.opportunityId);
      setHistoryOpen(false);
      setCompare(false);
      if (session.readError) {
        setSavedAwaitRead(true);
        setNotice('STALE');
        return;
      }
      clearDraft(ownerId);
      setNotice(null);
    } else if (result.kind === 'rejected') {
      const retain =
          (wasUnknown || result.uncertain) &&
          refusedBeforeReplay.has(result.code),
        own = draftRef.current ?? draftsFor(ownerId)?.load();
      if (own?.accountId === ownerId) {
        const next = { ...own, unresolved: retain ? action : null };
        if (session.data?.lookups.accountId === ownerId) change(next);
        else
          try {
            draftsFor(ownerId)?.save(next);
          } catch {
            setStorageFailure(true);
          }
      }
      actionRef.current = retain ? action : null;
      actionAccount.current = retain ? ownerId : null;
      setNotice(result.code);
      setPriorUnknown(wasUnknown || result.uncertain);
    } else {
      setNotice(result.code);
      setPriorUnknown(true);
    }
  }
  async function run(
    action: OpportunityAction,
    ownerId: string,
    wasUnknown = false,
  ) {
    if (!owned.canStart) return;
    const frozen = parseAction(structuredClone(action));
    actionRef.current = frozen;
    actionAccount.current = ownerId;
    const own = draftRef.current;
    if (own?.accountId === ownerId) change({ ...own, unresolved: frozen });
    setSaved(false);
    setNotice(null);
    setCompare(false);
    const result = await owned.run(frozen, (current) => {
      if (current?.lookups.accountId !== ownerId) return null;
      return {
        key: frozen.body.clientMutationId,
        send: async () => {
          return api.sendOwned(ownerId, frozen);
        },
      };
    });
    await settle(result, frozen, ownerId, wasUnknown);
  }
  async function submit() {
    if (!draft || blocked || !accountId) return;
    try {
      await run(freezeAction(draft, crypto.randomUUID()), draft.accountId);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.code : 'INVALID_INPUT');
    }
  }
  async function retry() {
    if (wrongAccount) {
      setNotice('FORBIDDEN');
      setPriorUnknown(true);
      return;
    }
    const action = actionRef.current ?? draft?.unresolved,
      ownerId = actionAccount.current ?? draft?.accountId;
    if (!action || !ownerId) return;
    if (owned.unresolved) {
      const result = await owned.retry();
      await settle(result, action, ownerId, true);
    } else await run(action, ownerId, true);
  }
  async function refresh() {
    const applied = await session.load();
    if (
      applied &&
      savedAwaitRead &&
      actionAccount.current === session.data?.lookups.accountId &&
      actionAccount.current
    )
      clearDraft(actionAccount.current);
  }
  function discard() {
    if (session.busy) return;
    owned.discard();
    if (draft) clearDraft(draft.accountId);
    else {
      actionRef.current = null;
      actionAccount.current = null;
      setPriorUnknown(false);
      setSavedAwaitRead(false);
    }
    setNotice(null);
    setCompare(false);
  }
  function beginCompare() {
    setCompare(true);
    setChoices({});
    setStepChoice(null);
    setNotice(null);
    void session.load();
  }
  function applyCompare() {
    if (!draft || !latest) return;
    try {
      change(rebase(draft, latest, choices, stepChoice));
      setCompare(false);
      setNotice(null);
      setPriorUnknown(false);
      // A definite refusal also lives in FieldSession. Clear it only after the
      // user has rebased successfully; no unresolved command can enter here.
      session.discard();
      owned.clearRefusal();
    } catch {
      setNotice('INVALID_INPUT');
    }
  }
  const error = notice ?? owned.refusal ?? session.error;
  const errorKey: MessageKey =
    error === 'STALE' && saved
      ? 'opSavedStale'
      : ['NETWORK', 'REQUEST_FAILED', 'RETRY', 'RATE_LIMITED'].includes(
            error ?? '',
          ) ||
          (uncertain && ['FORBIDDEN', 'LOGIN_REQUIRED'].includes(error ?? ''))
        ? outcomeKey(error, { write: true, uncertain })
        : uncertain
          ? 'ctUncertain'
          : conflictCodes.has(error ?? '')
            ? 'opConflict'
            : error === 'NOT_FOUND' ||
                error === 'FORBIDDEN' ||
                error === 'LOGIN_REQUIRED'
              ? 'opPermChanged'
              : error === 'INVALID_INPUT'
                ? 'opInvalidInput'
                : failureKey(error);
  const currentDraft = draft?.accountId === accountId ? draft : null;
  return (
    <main className="ct-workspace op-workspace">
      <header className="ct-header">
        <h1>{t('opTitle')}</h1>
        <div className="ct-actions">
          <a href={blocked ? undefined : '/'} aria-disabled={blocked}>
            {t('nav_report')}
          </a>
          <a href={blocked ? undefined : '/contracts'} aria-disabled={blocked}>
            {t('ctTitle')}
          </a>
          <select
            aria-label={t('ctLanguage')}
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
          >
            {Object.entries(LANGS).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
          {signOut && (
            <button disabled={blocked} type="button" onClick={signOut}>
              {t('signOut')}
            </button>
          )}
          <button
            type="button"
            disabled={session.busy}
            onClick={() => void (expired && renew ? renew() : refresh())}
          >
            {message(t, expired ? 'signIn' : 'ctRecheck')}
          </button>
        </div>
      </header>
      {error && (
        <div className="banner err" role="alert">
          {t(errorKey)}
        </div>
      )}
      {session.readError && (
        <div className="banner err" role="alert">
          {message(
            t,
            readFailureKey(session.readError) === 'ctReadFailed'
              ? 'opReadFailed'
              : readFailureKey(session.readError),
          )}
        </div>
      )}
      {storageFailure && <p role="alert">{t('ctDraftFailed')}</p>}
      {saved && !savedAwaitRead && <p role="status">{t('opSaved')}</p>}
      {pending && (
        <section className="op-callout">
          <h2>{t('opSnapshot')}</h2>
          <p>{message(t, savedAwaitRead ? 'opSavedStale' : 'ctUncertain')}</p>
          {wrongAccount ? (
            <p>{t('opPermChanged')}</p>
          ) : (
            <ActionSnapshot action={pending} lookups={lookups} />
          )}
          <div className="ct-actions">
            {!savedAwaitRead && (
              <button
                type="button"
                disabled={session.busy || wrongAccount}
                onClick={() => void retry()}
              >
                {t('retry')}
              </button>
            )}
            <button type="button" disabled={session.busy} onClick={discard}>
              {t('discard')}
            </button>
          </div>
        </section>
      )}
      {!data && (
        <p>{message(t, session.readError ? 'opReadFailed' : 'loading')}</p>
      )}
      {lookups && data && !session.readError && (
        <>
          <div className="ct-actions">
            {lookups.canCreateLead && (
              <button
                className="primary"
                type="button"
                disabled={blocked || !!draft}
                onClick={() => start('create')}
              >
                {t('opNew')}
              </button>
            )}
          </div>
          <div className="ct-layout">
            <nav className="ct-list" aria-label={t('opList')}>
              {!data.worklists.items.length && <p>{t('opEmpty')}</p>}
              {data.worklists.items.map((x) => (
                <button
                  type="button"
                  key={x.id}
                  aria-current={selected === x.id ? 'true' : undefined}
                  disabled={blocked || !!draft}
                  onClick={() => {
                    select(x.id);
                    setHistoryOpen(false);
                    setSaved(false);
                    setNotice(null);
                    owned.clearRefusal();
                  }}
                >
                  <strong>{x.revision.facts.name}</strong>
                  <span>{x.code}</span>
                  <span>
                    {message(
                      t,
                      x.effectiveDecision.kind === 'CONTINUE'
                        ? 'opContinue'
                        : x.effectiveDecision.kind === 'PAUSE'
                          ? 'opPause'
                          : 'opExit',
                    )}
                    {x.pendingRequest && ' · ' + t('opPending')}
                  </span>
                </button>
              ))}
            </nav>
            <section className="ct-detail">
              {currentDraft && !pending && (
                <section className="ct-form">
                  <h2>
                    {message(
                      t,
                      currentDraft.kind === 'create'
                        ? 'opNew'
                        : currentDraft.kind === 'update'
                          ? 'opUpdate'
                          : currentDraft.kind === 'request'
                            ? 'opRequest'
                            : 'opDecide',
                    )}
                  </h2>
                  <fieldset disabled={blocked}>
                    <Form
                      draft={currentDraft}
                      onChange={change}
                      lookups={lookups}
                    />
                  </fieldset>
                  <div className="ct-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        blocked || compare || conflictCodes.has(error ?? '')
                      }
                      onClick={() => void submit()}
                    >
                      {t('opSave')}
                    </button>
                    <button
                      type="button"
                      disabled={session.busy}
                      onClick={discard}
                    >
                      {t('back')}
                    </button>
                    {currentDraft.baseline && (
                      <button
                        type="button"
                        disabled={blocked}
                        onClick={beginCompare}
                      >
                        {t('opCompare')}
                      </button>
                    )}
                  </div>
                </section>
              )}
              {compare && currentDraft && latest && (
                <section className="op-callout">
                  <h3>{t('opCompare')}</h3>
                  {changedFields(currentDraft).map((field) => (
                    <fieldset key={field}>
                      <legend>{message(t, factLabels[field])}</legend>
                      <div className="op-compare">
                        <div>
                          <strong>{t('opUseMine')}</strong>
                          <FieldValue
                            field={field}
                            value={currentDraft.facts[field]}
                            lookups={lookups}
                          />
                        </div>
                        <div>
                          <strong>{t('opUseLatest')}</strong>
                          {field === 'internalNote' ||
                          field === 'probabilityRaw' ||
                          field === 'mustWinRaw' ? (
                            <ProtectedText
                              value={latest.revision.facts[field]}
                            />
                          ) : (
                            <FieldValue
                              field={field}
                              value={latest.revision.facts[field]}
                              lookups={lookups}
                            />
                          )}
                        </div>
                      </div>
                      <select
                        aria-label={
                          message(t, factLabels[field]) + ' ' + t('opCompare')
                        }
                        value={choices[field] ?? ''}
                        onChange={(e) =>
                          setChoices({
                            ...choices,
                            [field]: e.target.value as 'mine' | 'latest',
                          })
                        }
                      >
                        <option value="">{t('opUnassigned')}</option>
                        <option value="mine">{t('opUseMine')}</option>
                        <option value="latest">{t('opUseLatest')}</option>
                      </select>
                    </fieldset>
                  ))}
                  {currentDraft.kind === 'update' && (
                    <fieldset>
                      <legend>{t('opNext')}</legend>
                      <p>{latest.nextStep?.action ?? t('opEmptyList')}</p>
                      <select
                        aria-label={t('opNext') + ' ' + t('opCompare')}
                        value={stepChoice ?? ''}
                        onChange={(e) =>
                          setStepChoice(
                            e.target.value as OpportunityDraft['nextMode'],
                          )
                        }
                      >
                        <option value="">{t('opUnassigned')}</option>
                        <option value="KEEP">{t('opKeep')}</option>
                        <option value="REPLACE">{t('opReplace')}</option>
                        <option
                          value="COMPLETE_AND_ADD"
                          disabled={!latest.nextStep}
                        >
                          {t('opCompleteAdd')}
                        </option>
                      </select>
                    </fieldset>
                  )}
                  <button type="button" onClick={applyCompare}>
                    {t('opCompare')}
                  </button>
                </section>
              )}
              {item && !currentDraft && (
                <>
                  <ItemView item={item} lookups={lookups} />
                  <div className="ct-actions">
                    {item.capabilities.maintain && (
                      <>
                        <button
                          type="button"
                          disabled={blocked}
                          onClick={() => start('update')}
                        >
                          {t('opUpdate')}
                        </button>
                        <button
                          type="button"
                          disabled={blocked}
                          onClick={() => start('request')}
                        >
                          {t('opRequest')}
                        </button>
                      </>
                    )}
                    {item.capabilities.decide && (
                      <button
                        type="button"
                        disabled={blocked}
                        onClick={() => start('decide')}
                      >
                        {t('opDecide')}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={blocked}
                      onClick={() => setHistoryOpen(!historyOpen)}
                    >
                      {t('opHistory')}
                    </button>
                  </div>
                  {historyError && (
                    <p role="alert">
                      {message(t, readFailureKey(historyError))}
                    </p>
                  )}
                  {historyOpen &&
                    history &&
                    history.accountId === accountId &&
                    history.id === item.id && (
                      <HistoryView history={history.value} lookups={lookups} />
                    )}
                </>
              )}
            </section>
          </div>
          <div className="op-worklists">
            <section>
              <h2>{t('opMySteps')}</h2>
              {!data.worklists.myNextSteps.length && <p>{t('opEmptyList')}</p>}
              {data.worklists.myNextSteps.map(({ opportunityId, step }) => (
                <article className="op-record" key={step.id}>
                  <button
                    type="button"
                    disabled={blocked || !!draft}
                    onClick={() => select(opportunityId)}
                  >
                    {
                      data.worklists.items.find((x) => x.id === opportunityId)
                        ?.revision.facts.name
                    }
                  </button>
                  <p>
                    {step.action} · <ValueText value={step.dueOn} />
                  </p>
                </article>
              ))}
            </section>
            <section>
              <h2>{t('opPending')}</h2>
              {!data.worklists.pendingDecisions.length && (
                <p>{t('opEmptyList')}</p>
              )}
              {data.worklists.pendingDecisions.map(
                ({ opportunityId, request }) => (
                  <article className="op-record" key={request.id}>
                    <button
                      type="button"
                      disabled={blocked || !!draft}
                      onClick={() => select(opportunityId)}
                    >
                      {
                        data.worklists.items.find((x) => x.id === opportunityId)
                          ?.revision.facts.name
                      }
                    </button>
                    <p>
                      {personName(
                        request.requestedPersonId,
                        lookups,
                        t('opUnassigned'),
                      )}{' '}
                      · <ValueText value={request.dueOn} />
                    </p>
                    <ProtectedText value={request.explanation} />
                  </article>
                ),
              )}
            </section>
            <section>
              <h2>{t('opWeek')}</h2>
              <p>
                {data.worklists.recordedWeek.start} →{' '}
                {data.worklists.recordedWeek.end}
              </p>
              {!data.worklists.weekChanges.length && <p>{t('opEmptyList')}</p>}
              {data.worklists.weekChanges.map(({ opportunityId, update }) => (
                <div key={update.id}>
                  <button
                    type="button"
                    disabled={blocked || !!draft}
                    onClick={() => select(opportunityId)}
                  >
                    {
                      data.worklists.items.find((x) => x.id === opportunityId)
                        ?.revision.facts.name
                    }
                  </button>
                  <UpdateView update={update} lookups={lookups} />
                </div>
              ))}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
function ActionSnapshot({
  action,
  lookups,
}: {
  action: OpportunityAction;
  lookups: OpportunityLookupsDto | undefined;
}) {
  const { t } = useI18n(),
    c = action.body;
  return (
    <div className="op-snapshot">
      {'facts' in c && <p>{c.facts.name}</p>}
      {'newFact' in c && (
        <>
          <p>{c.noMaterialChange ? t('opNoChange') : c.newFact}</p>
          <p>{c.evidence}</p>
          <p>{c.obstacle}</p>
          {c.nextStep.mode !== 'KEEP' && (
            <p>
              {t('opNext')}: {c.nextStep.next.action} ·{' '}
              <ValueText value={c.nextStep.next.dueOn} />
            </p>
          )}
          {lookups &&
            c.changes.map((x) => (
              <div key={x.field}>
                <strong>{message(t, factLabels[x.field])}</strong>
                <FieldValue field={x.field} value={x.after} lookups={lookups} />
                <p>{x.reason}</p>
              </div>
            ))}
        </>
      )}
      {'explanation' in c && <p>{c.explanation}</p>}
      {'recordText' in c && (
        <>
          <p>{c.recordText}</p>
          <p>{c.basis}</p>
          <p>{c.decision.resumeCondition ?? c.decision.exitReason}</p>
        </>
      )}
    </div>
  );
}
