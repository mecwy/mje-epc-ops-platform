import { useEffect, useReducer, useState, type ReactNode } from 'react';
import type { MessageKey } from '@mje/ui';
import type {
  EvidenceWorkspace,
  FactEvidence,
} from '../../../../packages/contracts/src/business-evidence.js';
import { EvidenceSession } from './evidence-session.js';

/** Host supplies its existing i18n messages; this component introduces no second translation store. */
export interface EvidenceCardCopy {
  title: string;
  notConnected: string;
  loading: string;
  declared: string;
  coverage: string;
  unknown: string;
  factAllowed: string;
  availabilityOnly: string;
  state: Record<FactEvidence['state'], string>;
  photo: string;
  scope: string;
  qty: string;
  bind: string;
  unbind: string;
  retry: string;
  refresh: string;
  discard: string;
  pending: string;
  history: string;
  linkedPhoto: string;
  error: (key: MessageKey) => string;
}

function BindingForm({
  session,
  data,
  copy,
}: {
  session: EvidenceSession;
  data: EvidenceWorkspace;
  copy: EvidenceCardCopy;
}) {
  // Keep the version the user started editing. A subsequent read never silently rebinds it.
  const [base] = useState(() => structuredClone(data));
  const [photoId, setPhotoId] = useState('');
  const [scopeId, setScopeId] = useState(
    base.associationCoverage?.scopeRef ?? '',
  );
  const [qty, setQty] = useState(base.associationCoverage?.qty ?? '');
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    const photo = base.availablePhotos.find((p) => p.photoId === photoId);
    if (!photo) return;
    const scope = base.scopes.find((s) => s.id === scopeId);
    // Client validation is only convenience; the provider repeats version/scope/unit checks.
    if (qty !== '' && !/^\d{1,14}(?:[.,]\d{1,6})?$/.test(qty.trim()))
      return setInvalid(true);
    setInvalid(false);
    void session.bind(
      photo,
      {
        scopeRef: scope?.id ?? null,
        withinScopeRef: scope?.withinScopeRef ?? null,
        qty: qty.trim() === '' ? null : qty.trim().replace(',', '.'),
        unit: base.declaration.unit,
      },
      base,
    );
  };
  return (
    <div>
      <label>
        {copy.photo}
        <select value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
          <option value="">{copy.unknown}</option>
          {base.availablePhotos.map((p) => (
            <option key={p.photoId} value={p.photoId}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {copy.scope}
        <select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
          <option value="">{copy.unknown}</option>
          {base.scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        {copy.qty}
        <input
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />{' '}
        {base.declaration.unit}
      </label>
      {invalid && <p role="alert">{copy.error('numberInvalid')}</p>}
      <button
        type="button"
        disabled={!photoId || !session.canEdit}
        onClick={submit}
      >
        {copy.bind}
      </button>
    </div>
  );
}

/** Existing media only; raw-image access must be supplied by the authorized host reader. */
export function FactEvidenceCard({
  session,
  copy,
  renderPhoto,
}: {
  session: EvidenceSession;
  copy: EvidenceCardCopy;
  renderPhoto?: (photo: FactEvidence['photos'][number]) => ReactNode;
}) {
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe(changed), [session]);
  useEffect(() => {
    if (session.connected) void session.load();
  }, [session]);
  const data = session.data;
  const owned = session.actions.current;
  return (
    <section className="card" aria-label={copy.title}>
      <h3>{copy.title}</h3>
      <p>{copy.factAllowed}</p>
      <p>{copy.availabilityOnly}</p>
      {!session.connected ? (
        <p role="status">{copy.notConnected}</p>
      ) : (
        <>
          <button type="button" onClick={() => void session.load()}>
            {copy.refresh}
          </button>
          {!data ? (
            <p role="status">{copy.loading}</p>
          ) : (
            <>
              <p>
                {copy.declared}: {data.declaration.qty || copy.unknown}{' '}
                {data.declaration.unit ?? copy.unknown}
              </p>
              <p role="status">
                {copy.state[data.evidence?.state ?? 'MISSING']}
              </p>
              <p>
                {copy.coverage}: {data.associationCoverage?.qty ?? copy.unknown}{' '}
                {data.associationCoverage?.unit ?? copy.unknown}
              </p>
              <p>
                {copy.scope}:{' '}
                {data.scopes.find(
                  (s) => s.id === data.associationCoverage?.scopeRef,
                )?.label ?? copy.unknown}
              </p>
              {data.evidence?.photos.map((p) => (
                <div key={p.linkId}>
                  {renderPhoto?.(p) ?? <span>{copy.linkedPhoto}</span>}
                  {session.canEdit && (
                    <button
                      type="button"
                      onClick={() => void session.unbind(p.linkId, data)}
                    >
                      {copy.unbind}
                    </button>
                  )}
                </div>
              ))}
              {session.canEdit && !owned && (
                <BindingForm
                  key={session.actions.generation}
                  session={session}
                  data={data}
                  copy={copy}
                />
              )}
              {data.history.length > 0 && (
                <details>
                  <summary>{copy.history}</summary>
                  {data.history.map((e) => (
                    <div key={`${e.basis.linkSetId}:${e.basis.version}`}>
                      <p>
                        {copy.state[e.state]}: {e.coverage?.qty ?? copy.unknown}{' '}
                        {e.coverage?.unit ?? copy.unknown}
                      </p>
                      {e.photos.map((p) => (
                        <div key={p.linkId}>
                          {renderPhoto?.(p) ?? copy.linkedPhoto}
                        </div>
                      ))}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          {owned && (
            <div role="status">
              <p>{copy.pending}</p>
              {owned.operation === 'BIND' && (
                <p>
                  {copy.qty}: {owned.coverage.qty ?? copy.unknown}{' '}
                  {owned.coverage.unit ?? copy.unknown}
                </p>
              )}
              {session.actions.unresolved && (
                <>
                  <button type="button" onClick={() => void session.retry()}>
                    {copy.retry}
                  </button>
                  <button type="button" onClick={() => session.discard()}>
                    {copy.discard}
                  </button>
                </>
              )}
            </div>
          )}
          {(session.list.error || session.list.readError) && (
            <p role="alert">
              {copy.error(session.list.error ? session.messageKey : 'loadFail')}
            </p>
          )}
          {!owned && session.list.error === 'STALE' && (
            <button type="button" onClick={() => void session.retry()}>
              {copy.retry}
            </button>
          )}
        </>
      )}
    </section>
  );
}
