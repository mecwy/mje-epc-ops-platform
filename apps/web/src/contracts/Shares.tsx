import { useState } from 'react';
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
          <div className="ct-grid">
            <Field title={t('ctShares')}>
              <select
                disabled={r.expectedVersion > 0}
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
                  type="text"
                  inputMode="decimal"
                  value={r.quantity ?? ''}
                  onChange={(e) => update(i, 'quantity', e.target.value)}
                />
              </Field>
            )}
            <Field title={t('ctArea')}>
              <input
                value={r.area}
                onChange={(e) => update(i, 'area', e.target.value)}
              />
            </Field>
            <Field title={t('ctNote')}>
              <textarea
                value={r.note}
                onChange={(e) => update(i, 'note', e.target.value)}
              />
            </Field>
            <Field title={t('ctRetire')}>
              <input
                type="checkbox"
                checked={r.retired}
                onChange={(e) => update(i, 'retired', e.target.checked)}
              />
            </Field>
            <Field title={t('ctReason')}>
              <textarea
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
          onClick={() =>
            setRows([
              ...rows,
              {
                scopeId: crypto.randomUUID(),
                projectId: '',
                expectedVersion: 0,
                basis: 'NOTE',
                quantity: null,
                area: '',
                note: '',
                retired: false,
                reason: '',
              },
            ])
          }
        >
          {t('ctShareAdd')}
        </button>
        <button type="button" onClick={close}>
          {t('back')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!rows.length}
          onClick={() =>
            send({
              contractId: item.id,
              lineId: line.id,
              expectedVersion: item.latest.n,
              clientMutationId: crypto.randomUUID(),
              shares: structuredClone(rows),
            })
          }
        >
          {t('ctConfirmShares')}
        </button>
      </div>
    </section>
  );
}
