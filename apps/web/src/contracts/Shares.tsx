import { useState } from 'react';
import { confirmedShares } from './drafts.js';
import type {
  ContractEditorLookupsDto,
  ContractRegisterItemDto,
  ContractLineDto,
  ContractShareInput,
  SetContractSharesCommand,
} from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { Field } from './Editor.js';
import { basisKeys } from './View.js';
import { message } from './messages.js';
export function Shares({
  item,
  line,
  lookups,
  send,
  close,
}: {
  item: ContractRegisterItemDto;
  line: ContractLineDto;
  lookups: ContractEditorLookupsDto;
  send: (b: SetContractSharesCommand) => void;
  close: () => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<ContractShareInput[]>(() =>
    line.shares.map((s) => ({
      scopeId: s.scopeId,
      projectId: s.projectId,
      expectedVersion: s.version,
      basis: s.basis,
      quantity: s.quantity,
      area: s.internal.area ?? '',
      note: s.internal.note ?? '',
      retired: s.retired,
      reason: s.internal.reason ?? '',
    })),
  );
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());
  const projectIds =
    lookups.maintainedProjects.find((p) => p.direction === item.direction)
      ?.projectIds ?? [];
  const update = (i: number, key: keyof ContractShareInput, value: unknown) =>
    setRows((old) => old.map((r, j) => (i === j ? { ...r, [key]: value } : r)));
  return (
    <section>
      <h2>
        {t('ctShares')} · {line.lineNo}
      </h2>
      <p>{t('ctSharesHint')}</p>
      <p>
        {line.description} · {t('ctVersion', { n: item.latest.n })} ·{' '}
        {line.unitRaw}
      </p>
      {rows.map((r, i) => (
        <fieldset className="ct-line" key={r.scopeId}>
          <label>
            <input
              type="checkbox"
              checked={confirmed.has(r.scopeId)}
              onChange={(e) =>
                setConfirmed((old) => {
                  const next = new Set(old);
                  if (e.target.checked) next.add(r.scopeId);
                  else next.delete(r.scopeId);
                  return next;
                })
              }
            />
            {t('ctConfirmShares')}
          </label>
          <div className="ct-grid">
            <Field title={t('ctShares')}>
              <select
                disabled={r.expectedVersion > 0 || !confirmed.has(r.scopeId)}
                value={r.projectId}
                onChange={(e) => update(i, 'projectId', e.target.value)}
              >
                <option value="">{t('ctNone')}</option>
                {lookups.projects
                  .filter((p) => projectIds.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field title={t('ctQuantity')}>
              <select
                disabled={!confirmed.has(r.scopeId)}
                value={r.basis}
                onChange={(e) => {
                  setRows((old) =>
                    old.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            basis: e.target
                              .value as ContractShareInput['basis'],
                            quantity: e.target.value === 'QUANTITY' ? '' : null,
                          }
                        : x,
                    ),
                  );
                }}
              >
                {(['WHOLE', 'QUANTITY', 'AREA', 'NOTE'] as const).map((b) => (
                  <option key={b} value={b}>
                    {message(t, basisKeys[b])}
                  </option>
                ))}
              </select>
            </Field>
            {r.basis === 'QUANTITY' && (
              <Field title={t('ctQuantity') + ' · ' + line.unitRaw}>
                <input
                  disabled={!confirmed.has(r.scopeId)}
                  type="text"
                  inputMode="decimal"
                  value={r.quantity ?? ''}
                  onChange={(e) => update(i, 'quantity', e.target.value)}
                />
              </Field>
            )}
            <Field title={t('ctArea')}>
              <input
                disabled={!confirmed.has(r.scopeId)}
                value={r.area}
                onChange={(e) => update(i, 'area', e.target.value)}
              />
            </Field>
            <Field title={t('ctNote')}>
              <textarea
                disabled={!confirmed.has(r.scopeId)}
                value={r.note}
                onChange={(e) => update(i, 'note', e.target.value)}
              />
            </Field>
            <Field title={t('ctRetire')}>
              <input
                disabled={!confirmed.has(r.scopeId)}
                type="checkbox"
                checked={r.retired}
                onChange={(e) => update(i, 'retired', e.target.checked)}
              />
            </Field>
            <Field title={t('ctReason')}>
              <textarea
                disabled={!confirmed.has(r.scopeId)}
                value={r.reason}
                onChange={(e) => update(i, 'reason', e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
      ))}
      <div className="ct-actions">
        <button
          type="button"
          onClick={() => {
            const scopeId = crypto.randomUUID();
            setConfirmed((old) => new Set([...old, scopeId]));
            setRows([
              ...rows,
              {
                scopeId,
                projectId: '',
                expectedVersion: 0,
                basis: 'NOTE',
                quantity: null,
                area: '',
                note: '',
                retired: false,
                reason: '',
              },
            ]);
          }}
        >
          {t('ctShareAdd')}
        </button>
        <button type="button" onClick={close}>
          {t('back')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!confirmed.size}
          onClick={() =>
            send({
              contractId: item.id,
              lineId: line.id,
              expectedVersion: item.latest.n,
              clientMutationId: crypto.randomUUID(),
              shares: confirmedShares(rows, confirmed),
            })
          }
        >
          {t('ctConfirmShares')}
        </button>
      </div>
    </section>
  );
}
