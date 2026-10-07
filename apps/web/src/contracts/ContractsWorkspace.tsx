import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { LANGS, type Lang, type MessageKey } from '@mje/ui';
import {
  parseCreateContract,
  parseCorrectContract,
  parseContractShares,
  type ContractEditorLookupsDto,
  type ContractRegisterItemDto,
  type ContractHistoryDto,
  type ContractEditorDto,
  type ContractLineDto,
  type SetContractSharesCommand,
  type ReadContractAttentionCommand,
} from '@mje/contracts';
import { ApiError, contractApi } from '../api.js';
import { FieldSession } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { useI18n } from '../i18n.js';
import {
  blankDraft,
  correctionDraft,
  freezeWrite,
  ContractDrafts,
  mergeRevision,
  type ContractDraft,
  type ContractWrite,
} from './drafts.js';
import { Editor, stateKeys } from './Editor.js';
import { RevisionView, ShareView, preview } from './View.js';
import { Shares } from './Shares.js';
import { failureKey, readFailureKey, message } from './messages.js';
interface Bundle {
  lookups: ContractEditorLookupsDto;
  items: ContractRegisterItemDto[];
}
type Action =
  | ContractWrite
  | { kind: 'shares'; body: SetContractSharesCommand }
  | { kind: 'read'; body: ReadContractAttentionCommand };
const steps: MessageKey[] = [
  'ctStepSource',
  'ctStepFacts',
  'ctStepLines',
  'ctStepPreview',
];
const attentionKeys: Record<
  'UNASSIGNED' | 'CORRECTION' | 'SHARE_MISASSIGNED',
  MessageKey
> = {
  UNASSIGNED: 'ctUnassigned',
  CORRECTION: 'ctCorrectionAttention',
  SHARE_MISASSIGNED: 'ctShareAttention',
};
const mergeLabels: Record<string, MessageKey> = {
  name: 'ctName',
  originalNumber: 'ctOriginalNo',
  counterpartyRaw: 'ctParty',
  selfPartyRaw: 'ctSelf',
  counterpartyCompanyId: 'ctPartyCompany',
  selfCompanyId: 'ctSelfCompany',
  informationOwnerPersonId: 'ctOwner',
  signedOn: 'ctSignedOn',
  effectiveOn: 'ctEffectiveOn',
  registrationStatus: 'ctStatus',
  total: 'ctTotal',
  currency: 'ctCurrency',
  taxBasis: 'ctTax',
  lineNo: 'ctLineNo',
  description: 'ctDescription',
  quantity: 'ctQuantity',
  unitRaw: 'ctRawUnit',
  unit: 'ctMappedUnit',
  pricingType: 'ctPricing',
  amount: 'ctLineAmount',
  includes: 'ctIncludes',
  excludes: 'ctExcludes',
  derivation: 'ctDerivation',
  source: 'ctSource',
  removed: 'ctRemoved',
  removalSource: 'ctRemovalSource',
  parties: 'ctPartiesSource',
  dates: 'ctDatesSource',
};
function storage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
export function ContractsWorkspace({
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
  const { t, lang, setLang } = useI18n();
  const [, render] = useReducer((x) => x + 1, 0);
  const actionRef = useRef<Action | null>(null);
  const api = useMemo(() => contractApi(token), [token]);
  const session = useMemo(
    () =>
      new FieldSession<Bundle>(async () => {
        const [lookups, items] = await Promise.all([api.lookups(), api.list()]);
        return { lookups, items };
      }, render),
    [api],
  );
  const owned = useMemo(
    () =>
      new OwnedCommands<Bundle, Action>(
        session,
        () => actionRef.current?.body.clientMutationId ?? crypto.randomUUID(),
      ),
    [session],
  );
  const [selected, setSelected] = useState<string | null>(null),
    [draft, setDraft] = useState<ContractDraft | null>(null),
    [step, setStep] = useState(0),
    [formError, setFormError] = useState<string | null>(null),
    [saved, setSaved] = useState(false),
    [storageError, setStorageError] = useState(false);
  const [history, setHistory] = useState<ContractHistoryDto | null>(null),
    [historyError, setHistoryError] = useState<string | null>(null),
    [historyOpen, setHistoryOpen] = useState(false);
  const [mergeLatest, setMergeLatest] = useState<ContractEditorDto | null>(
      null,
    ),
    [choices, setChoices] = useState<Record<string, 'mine' | 'latest'>>({});
  const [shareLine, setShareLine] = useState<ContractLineDto | null>(null);
  const selectRef = useRef<string | null>(null);
  selectRef.current = selected;
  const data = session.data;
  const lookups = data?.lookups;
  const accountId = lookups?.accountId;
  const drafts = useMemo(() => {
    const store = storage();
    return store && accountId ? new ContractDrafts(store, accountId) : null;
  }, [accountId]);
  useEffect(() => {
    void session.load();
  }, [session]);
  useEffect(() => {
    setDraft(null);
    setSelected(null);
    setShareLine(null);
    setHistory(null);
  }, [accountId]);
  useEffect(() => {
    if (!selected || !historyOpen) return;
    let active = true;
    setHistory(null);
    setHistoryError(null);
    api
      .history(selected)
      .then((r) => {
        if (active) setHistory(r);
      })
      .catch((e) => {
        if (active)
          setHistoryError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
      });
    return () => {
      active = false;
    };
  }, [api, selected, historyOpen, data]);
  useEffect(() => {
    const reread = () => void session.load();
    window.addEventListener('online', reread);
    const visible = () => {
      if (document.visibilityState === 'visible') reread();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', reread);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [session]);
  const change = (next: ContractDraft) => {
    setDraft(next);
    setFormError(null);
    setSaved(false);
    setMergeLatest(null);
    try {
      if (!drafts) throw new Error('storage');
      drafts.save(next);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };
  const setInput = (next: ContractDraft) => {
    setStep(0);
    setFormError(null);
    setMergeLatest(null);
    change(next);
  };
  const item = data?.items.find((c) => c.id === selected);
  const canDraft = Boolean(
    draft && lookups?.directions.includes(draft.identity.direction),
  );
  const busy = owned.owned || Boolean(draft?.unresolved);
  const error = formError ?? owned.refusal ?? session.error;
  async function run(action: Action) {
    if (!owned.canStart) return;
    setFormError(null);
    setSaved(false);
    actionRef.current = structuredClone(action);
    const frozen = actionRef.current;
    if ((frozen.kind === 'create' || frozen.kind === 'correct') && draft)
      change({ ...draft, unresolved: frozen });
    const result = await owned.run(frozen, () => ({
      key: frozen.body.clientMutationId,
      send: () =>
        frozen.kind === 'create'
          ? api.create(frozen.body)
          : frozen.kind === 'correct'
            ? api.correct(frozen.body)
            : frozen.kind === 'shares'
              ? api.shares(frozen.body)
              : api.read(frozen.body),
    }));
    if (result.kind === 'ok') {
      setSaved(true);
      setShareLine(null);
      setHistoryOpen(false);
      setSelected(frozen.body.contractId);
      if (frozen.kind === 'create' || frozen.kind === 'correct') {
        try {
          drafts?.remove(frozen.body.contractId);
        } catch {
          setStorageError(true);
        }
        setDraft(null);
      }
      actionRef.current = null;
    } else if (result.kind === 'rejected') {
      if ((frozen.kind === 'create' || frozen.kind === 'correct') && draft)
        change({ ...draft, unresolved: null });
      setFormError(result.code);
      actionRef.current = null;
    }
  }
  async function submit() {
    if (!draft) return;
    try {
      const action = freezeWrite(draft, crypto.randomUUID());
      if (action.kind === 'create') parseCreateContract(action.body);
      else parseCorrectContract(action.body);
      await run(action);
    } catch {
      setFormError('INVALID_VALUE');
    }
  }
  async function retry() {
    if (owned.unresolved) {
      const result = await owned.retry();
      if (result.kind === 'ok') {
        const action = actionRef.current;
        setSaved(true);
        if (action && (action.kind === 'create' || action.kind === 'correct')) {
          try {
            drafts?.remove(action.body.contractId);
          } catch {
            setStorageError(true);
          }
          setDraft(null);
          setSelected(action.body.contractId);
        }
        setShareLine(null);
        actionRef.current = null;
      } else if (result.kind === 'rejected') {
        setFormError(result.code);
        if (draft) change({ ...draft, unresolved: null });
        actionRef.current = null;
      }
    } else if (draft?.unresolved) await run(draft.unresolved);
  }
  async function correct() {
    if (!item) return;
    const id = item.id,
      account = accountId;
    setFormError(null);
    try {
      const editor = await api.editor(id);
      if (
        selectRef.current === id &&
        session.data?.lookups.accountId === account
      )
        setInput(correctionDraft(editor));
    } catch (e) {
      setFormError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
    }
  }
  async function loadMerge() {
    if (!draft?.baseline) return;
    try {
      const latest = await api.editor(draft.identity.contractId);
      setMergeLatest(latest);
      setChoices({});
    } catch (e) {
      setFormError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
    }
  }
  const merged =
    draft?.baseline && mergeLatest
      ? mergeRevision(
          draft.baseline,
          draft.revision,
          mergeLatest.revision,
          choices,
        )
      : null;
  function conflictText(v: unknown): string {
    if (v === null) return t('ctNotStated');
    if (typeof v === 'string')
      return (
        lookups?.people.find((p) => p.id === v)?.displayName ??
        lookups?.companies.find((c) => c.id === v)?.name ??
        v
      );
    if (typeof v === 'object' && v) {
      const x = v as {
        state?: string;
        value?: string;
        description?: string;
        unitRaw?: string;
        location?: string;
        sourceDocumentId?: string;
      };
      if (x.description) return x.description + ' · ' + (x.unitRaw ?? '');
      if (x.state)
        return (
          x.value ??
          message(
            t,
            stateKeys[x.state as keyof typeof stateKeys] ?? 'ctUnknown',
          )
        );
      if (x.sourceDocumentId)
        return (
          (lookups?.sources.find((s) => s.id === x.sourceDocumentId)
            ?.filename ?? t('ctSource')) +
          ' · ' +
          (x.location ?? '')
        );
      return t('ctSource');
    }
    return String(v);
  }
  if (!data)
    return (
      <main className="ct-workspace">
        <h1>{t('ctTitle')}</h1>
        <p>
          {session.readError
            ? message(t, readFailureKey(session.readError))
            : t('loading')}
        </p>
        <button type="button" onClick={() => void session.load()}>
          {t('ctRecheck')}
        </button>
      </main>
    );
  if (session.readError || expired)
    return (
      <main className="ct-workspace">
        <h1>{t('ctTitle')}</h1>
        <p role="alert">
          {message(
            t,
            readFailureKey(expired ? 'LOGIN_REQUIRED' : session.readError),
          )}
        </p>
        <button
          type="button"
          onClick={() => void (expired ? renew?.() : session.load())}
        >
          {expired ? t('signIn') : t('ctRecheck')}
        </button>
      </main>
    );
  return (
    <main className="ct-workspace">
      <header className="ct-header">
        <h1>{t('ctTitle')}</h1>
        <div className="ct-actions">
          <a href={busy ? undefined : '/'} aria-disabled={busy}>
            {t('nav_report')}
          </a>
          <select
            aria-label={t('ctLanguage')}
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
          >
            {Object.entries(LANGS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          {signOut && (
            <button type="button" disabled={busy} onClick={signOut}>
              {t('signOut')}
            </button>
          )}
        </div>
      </header>
      {saved && (
        <p className="banner" role="status">
          {t('saved')}
        </p>
      )}
      {error && (
        <p className="banner err" role="alert">
          {message(
            t,
            failureKey(error, owned.refusalUncertain || session.errorUncertain),
          )}
        </p>
      )}
      {(owned.unresolved || draft?.unresolved) && (
        <section className="banner">
          <p>{t('ctUncertain')}</p>
          <div className="ct-actions">
            <button
              type="button"
              className="primary"
              disabled={session.busy}
              onClick={() => void retry()}
            >
              {t('retry')}
            </button>
            <button
              type="button"
              disabled={session.busy}
              onClick={() => {
                owned.discard();
                if (draft) change({ ...draft, unresolved: null });
                actionRef.current = null;
                void session.load();
              }}
            >
              {t('ctStopRetry')}
            </button>
          </div>
        </section>
      )}
      {draft && !canDraft && (
        <section>
          <p role="alert">{t('ctForbidden')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setFormError(null);
              setMergeLatest(null);
              owned.clearRefusal();
            }}
          >
            {t('back')}
          </button>
        </section>
      )}
      {draft && canDraft ? (
        <section>
          <h2>
            {draft.version ? t('ctCorrect') : t('ctCreate')} ·{' '}
            {t('ctVersion', { n: draft.version + 1 })}
          </h2>
          <ol className="ct-steps">
            {steps.map((key, i) => (
              <li key={key} aria-current={step === i ? 'step' : undefined}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setStep(i)}
                >
                  {message(t, key)}
                </button>
              </li>
            ))}
          </ol>
          <p className="muted" role="status">
            {storageError ? t('ctDraftFailed') : t('ctDraftSaved')}
          </p>
          {step === 3 || busy ? (
            <>
              <RevisionView
                revision={preview(draft, lookups!)}
                lookups={lookups!}
                inputPreview
              />
              <p>{t('ctPreviewNote')}</p>
              <p>{t('ctPreviewSharesNote')}</p>
            </>
          ) : (
            <Editor
              draft={draft}
              change={change}
              lookups={lookups!}
              step={step}
            />
          )}
          {merged && mergeLatest && (
            <section className="ct-merge">
              <h3>
                {t('ctMerge')} · {t('ctVersion', { n: mergeLatest.version })}
              </h3>
              {merged.conflicts.map((c) => (
                <fieldset key={c.key}>
                  <legend>
                    {message(
                      t,
                      mergeLabels[c.key.split(':').at(-1) ?? ''] ??
                        'ctStepFacts',
                    )}
                  </legend>
                  <p>
                    {t('ctMine')}: {conflictText(c.mine)}
                  </p>
                  <p>
                    {t('ctLatest')}: {conflictText(c.latest)}
                  </p>
                  <button
                    type="button"
                    onClick={() => setChoices({ ...choices, [c.key]: 'mine' })}
                  >
                    {t('ctMine')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setChoices({ ...choices, [c.key]: 'latest' })
                    }
                  >
                    {t('ctLatest')}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                disabled={merged.conflicts.length > 0}
                onClick={() => {
                  change({
                    ...draft,
                    version: mergeLatest.version,
                    baseline: structuredClone(mergeLatest.revision),
                    revision: merged.revision,
                    unresolved: null,
                  });
                  owned.clearRefusal();
                  setStep(3);
                }}
              >
                {t('ctStepPreview')}
              </button>
            </section>
          )}
          <div className="ct-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setFormError(null);
                setMergeLatest(null);
              }}
            >
              {t('back')}
            </button>
            {step > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep(step - 1)}
              >
                {t('ctChange')}
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => setStep(step + 1)}
              >
                {t('ctNext')}
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || Boolean(mergeLatest)}
                onClick={() => void submit()}
              >
                {t('ctConfirm')}
              </button>
            )}
            {formError === 'VERSION_CONFLICT' && draft.baseline && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadMerge()}
              >
                {t('ctMerge')}
              </button>
            )}
          </div>
        </section>
      ) : (
        !draft && (
          <>
            <div className="ct-actions">
              {lookups!.directions.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    setInput(blankDraft(d, () => crypto.randomUUID()))
                  }
                >
                  {t('ctCreate')} ·{' '}
                  {d === 'INCOME' ? t('ctIncome') : t('ctExpense')}
                </button>
              ))}
              {drafts?.last() && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const restored = drafts.last();
                    if (
                      restored &&
                      lookups!.directions.includes(restored.identity.direction)
                    )
                      setInput(restored);
                    else setFormError('FORBIDDEN');
                  }}
                >
                  {t('ctRestore')}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void session.load()}
              >
                {t('ctRecheck')}
              </button>
            </div>
            <div className="ct-layout">
              <aside className="ct-list" aria-label={t('ctTitle')}>
                {data.items.length === 0 && <p>{t('ctNoContracts')}</p>}
                {data.items.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    aria-current={selected === c.id ? 'page' : undefined}
                    onClick={() => {
                      setSelected(c.id);
                      setShareLine(null);
                      setHistoryOpen(false);
                      setFormError(null);
                    }}
                  >
                    <strong>{c.code}</strong>
                    <span>{c.latest.name}</span>
                    <small>
                      {c.direction === 'INCOME'
                        ? t('ctIncome')
                        : t('ctExpense')}{' '}
                      ·{' '}
                      {c.expenditureSubtype === 'PURCHASE'
                        ? t('ctPurchase')
                        : c.expenditureSubtype === 'SUBCONTRACT'
                          ? t('ctSubcontract')
                          : t('ctVersion', { n: c.latest.n })}
                    </small>
                  </button>
                ))}
              </aside>
              <div className="ct-detail">
                {item && (
                  <>
                    <h2>
                      {item.code} · {t('ctVersion', { n: item.latest.n })}
                    </h2>
                    <div className="ct-actions">
                      {lookups!.directions.includes(item.direction) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void correct()}
                        >
                          {t('ctCorrect')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setHistoryOpen(!historyOpen)}
                      >
                        {t('ctHistory')}
                      </button>
                    </div>
                    {item.attention.visibility === 'visible' &&
                      Boolean(item.attention.entries?.length) && (
                        <section className="ct-line">
                          <h3>{t('ctAttention')}</h3>
                          {item.attention.entries?.map((e) => (
                            <div key={e.id}>
                              <p>
                                {message(t, attentionKeys[e.kind])} ·{' '}
                                {t('ctVersion', { n: e.revisionN })} ·{' '}
                                {e.read
                                  ? t('ctRead')
                                  : e.requiresAnotherPerson
                                    ? t('ctAnother')
                                    : t('ctAttention')}
                              </p>
                              {!e.read && (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void run({
                                      kind: 'read',
                                      body: {
                                        contractId: item.id,
                                        attentionId: e.id,
                                        clientMutationId: crypto.randomUUID(),
                                      },
                                    })
                                  }
                                >
                                  {t('ctMarkRead')}
                                </button>
                              )}
                            </div>
                          ))}
                        </section>
                      )}
                    {shareLine ? (
                      <Shares
                        key={shareLine.id}
                        item={item}
                        line={shareLine}
                        lookups={lookups!}
                        close={() => setShareLine(null)}
                        send={(body) => {
                          try {
                            parseContractShares(body);
                            void run({ kind: 'shares', body });
                          } catch {
                            setFormError('SHARE_INVALID');
                          }
                        }}
                      />
                    ) : (
                      <>
                        <RevisionView
                          revision={item.latest}
                          lookups={lookups!}
                        />
                        {item.latest.lines
                          .filter((l) => !l.removed && l.canMaintainShares)
                          .map((l) => (
                            <button
                              type="button"
                              key={l.id}
                              disabled={busy}
                              onClick={() => setShareLine(l)}
                            >
                              {t('ctShares')} · {l.lineNo}
                            </button>
                          ))}
                      </>
                    )}
                    {historyOpen && (
                      <section>
                        <h3>{t('ctHistory')}</h3>
                        {historyError && (
                          <p role="alert">
                            {message(t, failureKey(historyError))}
                          </p>
                        )}
                        {!history && !historyError && <p>{t('loading')}</p>}
                        {history?.revisions.map((r) => (
                          <details key={r.n}>
                            <summary>{t('ctVersion', { n: r.n })}</summary>
                            <RevisionView revision={r} lookups={lookups!} />
                          </details>
                        ))}
                        {history?.shareVersions.map((s) => (
                          <ShareView
                            key={s.scopeId + ':' + String(s.version)}
                            share={s}
                            lookups={lookups!}
                          />
                        ))}
                      </section>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )
      )}
    </main>
  );
}
