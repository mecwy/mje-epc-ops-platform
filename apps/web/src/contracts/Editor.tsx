import type { ReactNode } from 'react';
import {
  CONTRACT_STATES,
  CONTRACT_UNITS,
  CONTRACT_PRICING,
  type ContractValue,
  type ContractLocation,
  type ContractDate,
  type ContractEditorLookupsDto,
  type ContractLineInput,
} from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import { message } from './messages.js';
import { useI18n } from '../i18n.js';
import type { ContractDraft } from './drafts.js';
export const stateKeys: Record<ContractValue['state'], MessageKey> = {
  VALUE: 'ctValue',
  BLANK: 'ctBlank',
  UNKNOWN: 'ctUnknown',
  NA: 'ctNA',
  NOT_STATED: 'ctNotStated',
};
export const priceKeys: Record<(typeof CONTRACT_PRICING)[number], MessageKey> =
  {
    LUMP_SUM: 'ctLump',
    UNIT_PRICE: 'ctUnitPrice',
    TIME_AND_MATERIAL: 'ctTime',
    REIMBURSABLE: 'ctReimbursable',
    UNKNOWN: 'ctUnknown',
  };
export function Field({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <label className="ct-field">
      <span>{title}</span>
      {children}
    </label>
  );
}
export function ValueField({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ContractValue;
  onChange: (v: ContractValue) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ct-field">
      <span>{title}</span>
      <div className="ct-pair">
        <select
          aria-label={title}
          value={value.state}
          onChange={(e) =>
            onChange({
              state: e.target.value as ContractValue['state'],
              value: e.target.value === 'VALUE' ? '' : null,
            })
          }
        >
          {CONTRACT_STATES.map((s) => (
            <option key={s} value={s}>
              {message(t, stateKeys[s])}
            </option>
          ))}
        </select>
        {value.state === 'VALUE' && (
          <input
            aria-label={title + ' ' + t('ctValue')}
            type="text"
            inputMode="decimal"
            value={value.value ?? ''}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
function DateField({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ContractDate;
  onChange: (v: ContractDate) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ct-field">
      <span>{title}</span>
      <div className="ct-pair">
        <select
          aria-label={title}
          value={value.state}
          onChange={(e) =>
            onChange({
              state: e.target.value as ContractDate['state'],
              value: e.target.value === 'VALUE' ? '' : null,
            })
          }
        >
          {(['VALUE', 'UNKNOWN', 'NOT_STATED'] as const).map((s) => (
            <option key={s} value={s}>
              {message(t, stateKeys[s])}
            </option>
          ))}
        </select>
        {value.state === 'VALUE' && (
          <input
            aria-label={title + ' ' + t('ctValue')}
            type="date"
            value={value.value ?? ''}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
export function LocationField({
  title,
  value,
  onChange,
  lookups,
}: {
  title: string;
  value: ContractLocation | null;
  onChange: (v: ContractLocation | null) => void;
  lookups: ContractEditorLookupsDto;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="ct-location">
      <legend>{title}</legend>
      <Field title={t('ctSource')}>
        <select
          value={value?.sourceDocumentId ?? ''}
          onChange={(e) =>
            onChange(
              e.target.value
                ? {
                    sourceDocumentId: e.target.value,
                    location: value?.location ?? '',
                  }
                : null,
            )
          }
        >
          <option value="">{t('ctNoBinding')}</option>
          {lookups.sources.map((s) => (
            <option value={s.id} key={s.id}>
              {s.filename}
            </option>
          ))}
        </select>
      </Field>
      <Field title={t('ctLocation')}>
        <input
          value={value?.location ?? ''}
          onChange={(e) =>
            onChange({
              sourceDocumentId: value?.sourceDocumentId ?? '',
              location: e.target.value,
            })
          }
        />
      </Field>
    </fieldset>
  );
}
export function Editor({
  draft,
  change,
  lookups,
  step,
}: {
  draft: ContractDraft;
  change: (d: ContractDraft) => void;
  lookups: ContractEditorLookupsDto;
  step: number;
}) {
  const { t } = useI18n();
  const r = draft.revision;
  const update = (key: keyof typeof r, value: unknown) =>
    change({ ...draft, revision: { ...r, [key]: value } });
  const lineUpdate = (
    id: string,
    key: keyof ContractLineInput,
    value: unknown,
  ) =>
    update(
      'lines',
      r.lines.map((l) => (l.id === id ? { ...l, [key]: value } : l)),
    );
  const text = (
    key:
      | 'name'
      | 'originalNumber'
      | 'counterpartyRaw'
      | 'selfPartyRaw'
      | 'currency',
    label: MessageKey,
  ) => (
    <Field title={t(label)}>
      <input
        value={r[key] ?? ''}
        onChange={(e) =>
          update(key, key === 'name' ? e.target.value : e.target.value || null)
        }
      />
    </Field>
  );
  const company = (
    key: 'counterpartyCompanyId' | 'selfCompanyId',
    label: MessageKey,
  ) => (
    <Field title={t(label)}>
      <select
        value={r[key] ?? ''}
        onChange={(e) => update(key, e.target.value || null)}
      >
        <option value="">{t('ctNone')}</option>
        {lookups.companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <div className="ct-form">
      {step === 0 && (
        <>
          <div className="ct-grid">
            <Field title={t('ctCode')}>
              <input
                value={draft.identity.code}
                disabled={draft.version > 0}
                onChange={(e) =>
                  change({
                    ...draft,
                    identity: { ...draft.identity, code: e.target.value },
                  })
                }
              />
            </Field>
            <Field title={t('ctTitle')}>
              <select
                value={draft.identity.direction}
                disabled={draft.version > 0}
                onChange={(e) =>
                  change({
                    ...draft,
                    identity: {
                      ...draft.identity,
                      direction: e.target.value as 'INCOME' | 'EXPENDITURE',
                      expenditureSubtype:
                        e.target.value === 'INCOME' ? null : 'SUBCONTRACT',
                    },
                  })
                }
              >
                {lookups.directions.map((d) => (
                  <option key={d} value={d}>
                    {d === 'INCOME' ? t('ctIncome') : t('ctExpense')}
                  </option>
                ))}
              </select>
            </Field>
            {draft.identity.direction === 'EXPENDITURE' && (
              <Field title={t('ctExpense')}>
                <select
                  disabled={draft.version > 0}
                  value={draft.identity.expenditureSubtype ?? 'SUBCONTRACT'}
                  onChange={(e) =>
                    change({
                      ...draft,
                      identity: {
                        ...draft.identity,
                        expenditureSubtype: e.target.value as
                          'SUBCONTRACT' | 'PURCHASE',
                      },
                    })
                  }
                >
                  <option value="SUBCONTRACT">{t('ctSubcontract')}</option>
                  <option value="PURCHASE">{t('ctPurchase')}</option>
                </select>
              </Field>
            )}
          </div>
          {r.sources.map((s, i) => (
            <LocationField
              key={i}
              title={t('ctSource') + ' ' + String(i + 1)}
              value={s}
              lookups={lookups}
              onChange={(v) =>
                update(
                  'sources',
                  r.sources.map((x, j) =>
                    j === i ? (v ?? { sourceDocumentId: '', location: '' }) : x,
                  ),
                )
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              update('sources', [
                ...r.sources,
                { sourceDocumentId: '', location: '' },
              ])
            }
          >
            {t('ctAddSource')}
          </button>
          {draft.version > 0 && (
            <Field title={t('ctReason')}>
              <textarea
                value={draft.reason}
                onChange={(e) => change({ ...draft, reason: e.target.value })}
              />
            </Field>
          )}
        </>
      )}
      {step === 1 && (
        <>
          <div className="ct-grid">
            {text('name', 'ctName')}
            {text('originalNumber', 'ctOriginalNo')}
            {text('counterpartyRaw', 'ctParty')}
            {text('selfPartyRaw', 'ctSelf')}
            {company('counterpartyCompanyId', 'ctPartyCompany')}
            {company('selfCompanyId', 'ctSelfCompany')}
            <Field title={t('ctOwner')}>
              <select
                value={r.informationOwnerPersonId ?? ''}
                onChange={(e) =>
                  update('informationOwnerPersonId', e.target.value || null)
                }
              >
                <option value="">{t('ctNone')}</option>
                {lookups.people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <DateField
              title={t('ctSignedOn')}
              value={r.signedOn}
              onChange={(v) => update('signedOn', v)}
            />
            <DateField
              title={t('ctEffectiveOn')}
              value={r.effectiveOn}
              onChange={(v) => update('effectiveOn', v)}
            />
            <Field title={t('ctStatus')}>
              <select
                value={r.registrationStatus}
                onChange={(e) => update('registrationStatus', e.target.value)}
              >
                <option value="SIGNED_PENDING">{t('ctPending')}</option>
                <option value="EFFECTIVE">{t('ctEffective')}</option>
              </select>
            </Field>
            <ValueField
              title={t('ctTotal')}
              value={r.total}
              onChange={(v) => update('total', v)}
            />
            {text('currency', 'ctCurrency')}
            <Field title={t('ctTax')}>
              <select
                value={r.taxBasis}
                onChange={(e) => update('taxBasis', e.target.value)}
              >
                <option value="UNKNOWN">{t('ctUnknown')}</option>
                <option value="INCLUSIVE">{t('ctInclusive')}</option>
                <option value="EXCLUSIVE">{t('ctExclusive')}</option>
              </select>
            </Field>
          </div>
          {(['parties', 'dates', 'total'] as const).map((key, i) => (
            <LocationField
              key={key}
              title={message(
                t,
                (
                  ['ctPartiesSource', 'ctDatesSource', 'ctTotalSource'] as const
                )[i]!,
              )}
              value={r.headLocs[key]}
              lookups={lookups}
              onChange={(v) => update('headLocs', { ...r.headLocs, [key]: v })}
            />
          ))}
        </>
      )}
      {step === 2 && (
        <>
          {r.lines.map((l) => (
            <fieldset key={l.id} className="ct-line">
              <legend>
                {t('ctLineNo')} {l.lineNo}
              </legend>
              <div className="ct-grid">
                <Field title={t('ctLineNo')}>
                  <input
                    value={l.lineNo}
                    onChange={(e) => lineUpdate(l.id, 'lineNo', e.target.value)}
                  />
                </Field>
                <Field title={t('ctDescription')}>
                  <textarea
                    value={l.description}
                    onChange={(e) =>
                      lineUpdate(l.id, 'description', e.target.value)
                    }
                  />
                </Field>
                <ValueField
                  title={t('ctQuantity')}
                  value={l.quantity}
                  onChange={(v) => lineUpdate(l.id, 'quantity', v)}
                />
                <Field title={t('ctRawUnit')}>
                  <input
                    value={l.unitRaw}
                    onChange={(e) =>
                      lineUpdate(l.id, 'unitRaw', e.target.value)
                    }
                  />
                </Field>
                <Field title={t('ctMappedUnit')}>
                  <select
                    value={l.unit ?? ''}
                    onChange={(e) =>
                      lineUpdate(l.id, 'unit', e.target.value || null)
                    }
                  >
                    <option value="">{t('ctNoBinding')}</option>
                    {CONTRACT_UNITS.map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </Field>
                <Field title={t('ctPricing')}>
                  <select
                    value={l.pricingType}
                    onChange={(e) =>
                      lineUpdate(l.id, 'pricingType', e.target.value)
                    }
                  >
                    {CONTRACT_PRICING.map((p) => (
                      <option key={p} value={p}>
                        {message(t, priceKeys[p])}
                      </option>
                    ))}
                  </select>
                </Field>
                <ValueField
                  title={t('ctLineAmount')}
                  value={l.amount}
                  onChange={(v) => lineUpdate(l.id, 'amount', v)}
                />
                {(['includes', 'excludes', 'derivation'] as const).map(
                  (key, i) => (
                    <Field
                      key={key}
                      title={message(
                        t,
                        (['ctIncludes', 'ctExcludes', 'ctDerivation'] as const)[
                          i
                        ]!,
                      )}
                    >
                      <textarea
                        value={l[key]}
                        onChange={(e) => lineUpdate(l.id, key, e.target.value)}
                      />
                    </Field>
                  ),
                )}
              </div>
              <LocationField
                title={t('ctSource')}
                value={l.source}
                lookups={lookups}
                onChange={(v) => lineUpdate(l.id, 'source', v)}
              />
              <Field title={t('ctRemoved')}>
                <input
                  type="checkbox"
                  checked={l.removed}
                  onChange={(e) =>
                    change({
                      ...draft,
                      revision: {
                        ...r,
                        lines: r.lines.map((x) =>
                          x.id === l.id
                            ? {
                                ...x,
                                removed: e.target.checked,
                                removalSource: e.target.checked
                                  ? x.removalSource
                                  : null,
                              }
                            : x,
                        ),
                      },
                    })
                  }
                />
              </Field>
              {l.removed && (
                <LocationField
                  title={t('ctRemovalSource')}
                  value={l.removalSource}
                  lookups={lookups}
                  onChange={(v) => lineUpdate(l.id, 'removalSource', v)}
                />
              )}
            </fieldset>
          ))}
          <button
            type="button"
            onClick={() =>
              update('lines', [
                ...r.lines,
                {
                  id: crypto.randomUUID(),
                  lineNo: String(r.lines.length + 1),
                  description: '',
                  quantity: { state: 'UNKNOWN', value: null },
                  unitRaw: '',
                  unit: null,
                  pricingType: 'UNKNOWN',
                  amount: { state: 'UNKNOWN', value: null },
                  includes: '',
                  excludes: '',
                  derivation: '',
                  source: null,
                  removed: false,
                  removalSource: null,
                },
              ])
            }
          >
            {t('ctAddLine')}
          </button>
        </>
      )}
    </div>
  );
}
