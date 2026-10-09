import { useEffect, useReducer, useState } from 'react';
import { dec, pct } from '@mje/domain/rules';
import type {
  DayFactsDto,
  InitializeMaterialScopeCommand,
  MaterialProjectionDto,
  MaterialSourceDto,
} from '@mje/contracts';
import type { IssueAsOf } from '../api.js';
import { useI18n } from '../i18n.js';
import { materialContinuityCopy } from './material-continuity-copy.js';
import type { MaterialContinuitySession } from './material-continuity-session.js';
import './material-continuity.css';

export function MaterialContinuity({
  session,
  facts,
  issues,
  revisionNumber,
}: {
  session: MaterialContinuitySession;
  facts: DayFactsDto;
  issues: IssueAsOf[];
  revisionNumber?: number;
}) {
  const { lang } = useI18n();
  const t = materialContinuityCopy(lang);
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [links, setLinks] = useState<Record<string, { issueId: string }>>({});
  const [followupError, setFollowupError] = useState(false);
  const [currentIssues, setCurrentIssues] = useState<IssueAsOf[]>(issues);
  const [followupLoadError, setFollowupLoadError] = useState(false);
  const needsFollowup = (s: MaterialSourceDto) => s.followupRequired;
  const actionable = (s: MaterialSourceDto) =>
    [
      'ready',
      'correctionPending',
      'followupPending',
      'reversalPending',
    ].includes(s.state);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<MaterialProjectionDto[] | null>(null);
  useEffect(() => session.subscribe(render), [session]);
  useEffect(() => {
    void session.load();
  }, [session]);
  useEffect(() => {
    let live = true;
    void session
      .readFrozen(revisionNumber)
      .then((x) => {
        if (live) setFrozen(x);
      })
      .catch(() => {
        if (live) setFrozen(null);
      });
    return () => {
      live = false;
    };
  }, [session, revisionNumber, session.session.data]);
  const data = session.session.data;
  useEffect(() => {
    if (data?.access !== 'write') return;
    let live = true;
    void session
      .readFollowups()
      .then((rows) => {
        if (live) {
          setCurrentIssues(rows);
          setFollowupLoadError(false);
        }
      })
      .catch(() => {
        if (live) setFollowupLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [session, data]);
  const owned = session.commands.owned || session.session.busy;
  const write = data?.access === 'write' && !owned;
  const status = (s: MaterialSourceDto) =>
    s.state === 'included'
      ? t.included
      : s.state === 'reversalPending'
        ? t.reversal
        : s.state === 'followupPending'
          ? t.cause
          : s.state === 'pending'
            ? t.unknown
            : s.state === 'correctionPending'
              ? t.correction
              : t.ready;
  const send = (
    scopeId: string,
    version: number,
    source: MaterialSourceDto[],
  ) => {
    const rows = source.filter((s) => selected[s.useFactId] && actionable(s));
    if (
      rows.some(
        (s) => needsFollowup(s) && !(links[s.useFactId]?.issueId || s.issueId),
      )
    ) {
      setFollowupError(true);
      return;
    }
    setFollowupError(false);
    setConfirm(null);
    void session.run({
      kind: 'admit',
      payload: {
        projectId: session.projectId,
        businessDate: session.businessDate,
        scopeId,
        expectedVersion: version,
        records: rows.map((s) => ({
          sourceBusinessDate: s.sourceBusinessDate,
          revisionNumber: s.revisionNumber,
          useFactId: s.useFactId,
          issueId:
            s.state === 'reversalPending'
              ? null
              : links[s.useFactId]?.issueId || s.issueId || null,
          dueAt: null,
        })),
      },
    });
  };
  return (
    <section className="material-ledger" aria-label={t.title}>
      <h3>{t.title}</h3>
      {followupError && <p role="alert">{t.followupRequired}</p>}
      {followupLoadError && <p role="alert">{t.followupUnavailable}</p>}
      {session.session.error && (
        <p className="material-ledger-warning">
          {session.session.pending || session.session.error === 'STALE'
            ? t.unsettled
            : session.session.error === 'INVALID_INPUT'
              ? t.invalidInput
              : session.session.error}
        </p>
      )}
      {(session.commands.owned || session.session.pending) && (
        <>
          <p>{t.unsettled}</p>
          <div className="material-ledger-small">
            {session.commands.current?.kind === 'admit' ? (
              session.commands.current.payload.records.map((r) => (
                <p key={r.useFactId}>
                  {t.record}: {r.sourceBusinessDate} · v{r.revisionNumber}
                </p>
              ))
            ) : (
              <p>
                {t.quantity}:{' '}
                {session.commands.current?.payload.openingQuantity ?? '—'}
              </p>
            )}
          </div>
          <div className="material-ledger-controls">
            <button
              type="button"
              disabled={session.session.busy}
              onClick={() => void session.retry()}
            >
              {t.retry}
            </button>
            <button
              type="button"
              disabled={session.session.busy}
              onClick={() => void session.discard()}
            >
              {t.discard}
            </button>
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => void session.load()}
        disabled={session.session.busy}
      >
        {t.refresh}
      </button>
      {data?.scopes.map(({ scope, current, sources, followups, history }) => (
        <div key={scope.id}>
          <p>
            <strong>
              {scope.materialKey} · {scope.specification} · {scope.unit}
            </strong>
          </p>
          <p className="material-ledger-small">
            {t.scope}: {scope.ownership} / {scope.custody} / {scope.location}
          </p>
          <p>
            <strong>{t.current}</strong>
          </p>
          <dl className="material-ledger-grid">
            <div>
              <dt>{t.opening}</dt>
              <dd>
                {current.opening ?? '—'} {scope.unit}
              </dd>
            </div>
            <div>
              <dt>{t.balance}</dt>
              <dd>
                {current.balance ?? '—'} {scope.unit}
                {pct(
                  dec(current.balance ?? ''),
                  dec(scope.openingQuantity ?? ''),
                ) !== null && (
                  <span className="material-ledger-small">
                    {' '}
                    · {t.ofOpening}{' '}
                    {pct(
                      dec(current.balance ?? ''),
                      dec(scope.openingQuantity ?? ''),
                    )}
                    %
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t.use}</dt>
              <dd>
                {current.admittedUseToday} {scope.unit}
              </dd>
            </div>
            <div>
              <dt>{t.total}</dt>
              <dd>
                {current.admittedUseCumulative} {scope.unit}
              </dd>
            </div>
          </dl>
          {!current.complete && (
            <p className="material-ledger-warning">
              {t.pending} · {current.pendingCount}
            </p>
          )}
          <p className="material-ledger-small">{t.declared}</p>
          <details>
            <summary>{t.basis}</summary>
            <p>
              {scope.openingQuantity ?? '—'} {scope.unit} · {scope.openingDate}{' '}
              · {scope.openingCutoffAt}
            </p>
            <p>{scope.openingBasis || '—'}</p>
          </details>
          <details>
            <summary>{t.frozen}</summary>
            {frozen?.find((f) => f.scopeId === scope.id) ? (
              <p>
                {t.balance}:{' '}
                {frozen.find((f) => f.scopeId === scope.id)!.balance ?? '—'}{' '}
                {scope.unit} · v{revisionNumber ?? ''}
              </p>
            ) : (
              <p>{t.missing}</p>
            )}
          </details>
          <details>
            <summary>{t.history}</summary>
            {history.map((h) => (
              <p key={h.ledgerVersion}>
                #{h.ledgerVersion} · {h.balance ?? '—'} {scope.unit} ·{' '}
                {h.recordedAt}
              </p>
            ))}
          </details>
          <h4>{t.sources}</h4>
          {sources.map((s) => (
            <div className="material-ledger-source" key={s.useFactId}>
              <p>
                {t.record}: {s.sourceBusinessDate} · v{s.revisionNumber}
              </p>
              <p>
                {t.output}: {s.outputQuantity ?? '—'} · {t.actual}:{' '}
                {s.quantity ?? '—'} {scope.unit}
              </p>
              <p>
                <strong>
                  {t.difference}: {s.difference ?? '—'} {scope.unit}
                </strong>{' '}
                ·{' '}
                {s.difference === '0'
                  ? t.noDifference
                  : s.difference === null
                    ? t.differenceUnknown
                    : s.note || t.cause}
              </p>
              <p>{status(s)}</p>
              {s.state === 'followupPending' && (
                <p className="material-ledger-warning">{t.followupRequired}</p>
              )}
              {write && actionable(s) && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!selected[s.useFactId]}
                      onChange={(e) =>
                        setSelected((v) => ({
                          ...v,
                          [s.useFactId]: e.target.checked,
                        }))
                      }
                    />
                    {s.state === 'reversalPending' ? t.reverseSelect : t.select}{' '}
                    {s.sourceBusinessDate}{' '}
                    {s.state === 'reversalPending'
                      ? s.admittedQuantity
                      : s.quantity}{' '}
                    {scope.unit}
                  </label>
                  {s.state !== 'reversalPending' && (
                    <label>
                      {needsFollowup(s) ? t.followup : t.issue}
                      <select
                        value={links[s.useFactId]?.issueId ?? s.issueId ?? ''}
                        onChange={(e) =>
                          setLinks((v) => ({
                            ...v,
                            [s.useFactId]: {
                              issueId: e.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">{t.noIssue}</option>
                        {currentIssues
                          .filter(
                            (i) =>
                              i.workItemKey === s.workItemKey &&
                              i.ownerPersonId &&
                              i.dueOn &&
                              (!needsFollowup(s) || i.status === 'open'),
                          )
                          .map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.title} · {i.dueOn}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </div>
          ))}
          {followups.map((f) => (
            <p key={f.useFactId}>
              {t.followup}: {f.title} · {f.ownerLabel ?? f.ownerPersonId ?? '—'}{' '}
              · {f.dueOn} · {f.state}
            </p>
          ))}
          {write &&
            sources.some((s) => selected[s.useFactId] && actionable(s)) &&
            (confirm === scope.id ? (
              <div>
                <p>{t.declared}</p>
                {sources
                  .filter((s) => selected[s.useFactId] && actionable(s))
                  .map((s) => (
                    <p key={s.useFactId}>
                      {s.sourceBusinessDate} ·{' '}
                      {s.state === 'reversalPending'
                        ? `${t.reverseSelect} ${s.admittedQuantity}`
                        : s.quantity}{' '}
                      {scope.unit}
                    </p>
                  ))}
                <div className="material-ledger-controls">
                  <button
                    type="button"
                    onClick={() => send(scope.id, scope.version, sources)}
                  >
                    {t.admit}
                  </button>
                  <button type="button" onClick={() => setConfirm(null)}>
                    {t.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirm(scope.id)}>
                {t.confirm}
              </button>
            ))}
        </div>
      ))}
      {data?.scopes.length === 0 && (
        <>
          <p>{t.none}</p>
          {write && <OpeningForm session={session} facts={facts} />}
        </>
      )}
      <p className="material-ledger-small">{t.immutable}</p>
    </section>
  );
}
function OpeningForm({
  session,
  facts,
}: {
  session: MaterialContinuitySession;
  facts: DayFactsDto;
}) {
  const { lang } = useI18n();
  const t = materialContinuityCopy(lang);
  const a = facts.activities?.find(
    (a) => a.use?.materialItemId && a.use.materialKey,
  );
  const [v, set] = useState(() => ({ ...session.openingDraft }));
  if (!a?.use?.materialItemId || !a.use.materialKey) return null;
  const fields = [
    ['quantity', t.quantity],
    ['basis', t.basis],
    ['ownership', t.ownership],
    ['custody', t.custody],
    ['location', t.location],
    ['date', t.date],
    ['cutoff', t.cutoff],
  ] as const;
  const save = () => {
    const payload: Omit<InitializeMaterialScopeCommand, 'clientMutationId'> = {
      projectId: session.projectId,
      materialItemId: a.use!.materialItemId!,
      materialKey: a.use!.materialKey!,
      specification: a.use!.specification,
      unit: a.use!.unit,
      workPackageId: a.workPackageId,
      scopeVersion: a.scopeVersion,
      ownership: v.ownership,
      custody: v.custody,
      location: v.location,
      openingDate: v.date,
      openingCutoffAt: v.cutoff,
      openingQuantity: v.quantity === '' ? null : v.quantity,
      openingBasis: v.basis,
    };
    void session.run({ kind: 'initialize', payload });
  };
  return (
    <details
      open={session.openingExpanded}
      onToggle={(e) => {
        session.openingExpanded = e.currentTarget.open;
      }}
    >
      <summary>{t.setup}</summary>
      <p className="material-ledger-small">{t.openingLimit}</p>
      {fields.map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            aria-label={label}
            value={v[key]}
            inputMode={key === 'quantity' ? 'decimal' : undefined}
            type={key === 'date' ? 'date' : 'text'}
            onChange={(e) => {
              session.openingDraft[key] = e.target.value;
              set({ ...session.openingDraft });
            }}
          />
        </label>
      ))}
      <button type="button" onClick={save}>
        {t.save}
      </button>
    </details>
  );
}
