import { message } from '../contracts/messages.js';
import type { ReactNode } from 'react';
import {
  OPPORTUNITY_STATES,
  OPPORTUNITY_PARTY_ROLES,
  type OpportunityValue,
  type OpportunityScale,
  type OpportunityFacts,
  type OpportunityLookupsDto,
} from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import { useI18n } from '../i18n.js';
import { stateKeys } from '../contracts/Editor.js';
import type { OpportunityDraft } from './drafts.js';
export const factLabels: Record<keyof OpportunityFacts, MessageKey> = {
  name: 'opName',
  businessLine: 'opLine',
  customerGroup: 'opGroup',
  informationOwnerPersonId: 'opOwner',
  assistantPersonIds: 'opAssistants',
  parties: 'opParties',
  ownerProject: 'opOwnerProject',
  proposedScopes: 'opOurScope',
  dates: 'opDates',
  stageRaw: 'opStage',
  probabilityRaw: 'opProbability',
  mustWinRaw: 'opMustWin',
  internalNote: 'opNote',
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
export function ValueInput({
  title,
  value,
  onChange,
  type = 'text',
}: {
  title: string;
  value: OpportunityValue;
  onChange: (v: OpportunityValue) => void;
  type?: 'text' | 'date';
}) {
  const { t } = useI18n();
  return (
    <div className="ct-field">
      <span>{title}</span>
      <div className="ct-pair">
        <select
          aria-label={title + ' ' + t('opState')}
          value={value.state}
          onChange={(e) =>
            onChange({
              state: e.target.value as OpportunityValue['state'],
              value: e.target.value === 'VALUE' ? '' : null,
            })
          }
        >
          {OPPORTUNITY_STATES.map((s) => (
            <option key={s} value={s}>
              {message(t, stateKeys[s])}
            </option>
          ))}
        </select>
        {value.state === 'VALUE' && (
          <input
            aria-label={title}
            type={type}
            value={value.value ?? ''}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
          />
        )}
      </div>
    </div>
  );
}
function ScaleInput({
  value,
  onChange,
}: {
  value: OpportunityScale;
  onChange: (v: OpportunityScale) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ct-grid">
      <ValueInput
        title={t('opScale')}
        value={value.value}
        onChange={(v) => onChange({ ...value, value: v })}
      />
      <Field title={t('opUnit')}>
        <input
          value={value.unitRaw ?? ''}
          onChange={(e) =>
            onChange({ ...value, unitRaw: e.target.value || null })
          }
        />
      </Field>
      <ValueInput
        title={t('opBasis')}
        value={value.basis}
        onChange={(v) => onChange({ ...value, basis: v })}
      />
    </div>
  );
}
export function PersonInput({
  title,
  value,
  onChange,
  lookups,
}: {
  title: string;
  value: string | null;
  onChange: (id: string | null) => void;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n();
  return (
    <Field title={title}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{t('opUnassigned')}</option>
        {lookups.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function Form({
  draft: d,
  onChange: change,
  lookups,
}: {
  draft: OpportunityDraft;
  onChange: (d: OpportunityDraft) => void;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n(),
    f = d.facts,
    text = d.baseline?.capabilities.restrictedText ?? false;
  const set = <K extends keyof OpportunityDraft>(
    k: K,
    v: OpportunityDraft[K],
  ) => change({ ...d, [k]: v });
  const fact = <K extends keyof OpportunityFacts>(
    k: K,
    v: OpportunityFacts[K],
  ) => set('facts', { ...f, [k]: v });
  const ownerEditable =
    !d.baseline ||
    d.baseline.revision.facts.ownerProject.conditions.every(
      (c) => c.basis.visibility === 'visible',
    );
  const emptyValue: OpportunityValue = { state: 'UNKNOWN', value: null };
  const blankScale = (): OpportunityScale => ({
    value: { ...emptyValue },
    unitRaw: null,
    basis: { state: 'BLANK', value: null },
  });
  const source = (
    <details>
      <summary>{t('opSource')}</summary>
      <div className="ct-grid">
        <Field title={t('opSource')}>
          <select
            value={d.sourceDocumentId ?? ''}
            onChange={(e) => set('sourceDocumentId', e.target.value || null)}
          >
            <option value="">{t('opUnassigned')}</option>
            {lookups.sources.map((s) => (
              <option value={s.id} key={s.id}>
                {s.filename}
              </option>
            ))}
          </select>
        </Field>
        <Field title={t('opEvidence')}>
          <input
            value={d.sourceReference}
            onChange={(e) => set('sourceReference', e.target.value)}
          />
        </Field>
        <Field title={t('opLocation')}>
          <input
            value={d.sourceLocation}
            onChange={(e) => set('sourceLocation', e.target.value)}
          />
        </Field>
      </div>
    </details>
  );
  const occurrence = (
    <details>
      <summary>{t('opOccurred')}</summary>
      <div className="ct-grid">
        <Field title={t('opOccurred')}>
          <input
            value={d.occurredAt}
            onChange={(e) => set('occurredAt', e.target.value)}
            placeholder="2026-10-03T08:00:00Z"
          />
        </Field>
        <Field title={t('opTimezone')}>
          <input
            value={d.timezone}
            onChange={(e) => set('timezone', e.target.value)}
          />
        </Field>
        <Field title={t('opBusinessDate')}>
          <input
            type="date"
            value={d.businessDate}
            onChange={(e) => set('businessDate', e.target.value)}
          />
        </Field>
      </div>
    </details>
  );
  if (d.kind === 'create')
    return (
      <div className="ct-grid">
        <Field title={t('opName')}>
          <input
            autoFocus
            value={f.name}
            onChange={(e) => fact('name', e.target.value)}
            maxLength={300}
          />
        </Field>
        <Field title={t('opCode')}>
          <input
            value={d.code}
            onChange={(e) => set('code', e.target.value)}
            maxLength={80}
          />
        </Field>
      </div>
    );
  if (d.kind === 'request')
    return (
      <>
        <div className="ct-grid">
          <PersonInput
            title={t('opRequestedPerson')}
            value={d.requestedPerson}
            onChange={(v) => set('requestedPerson', v)}
            lookups={lookups}
          />
          <ValueInput
            title={t('opDue')}
            value={d.requestDue}
            type="date"
            onChange={(v) => set('requestDue', v)}
          />
        </div>
        <Field title={t('opExplanation')}>
          <textarea
            value={d.explanation}
            onChange={(e) => set('explanation', e.target.value)}
          />
        </Field>
        {source}
      </>
    );
  if (d.kind === 'decide')
    return (
      <>
        <p className="muted">{t('opNoAuthority')}</p>
        <div className="ct-grid">
          <Field title={t('opDecide')}>
            <select
              value={d.decisionKind}
              onChange={(e) =>
                set(
                  'decisionKind',
                  e.target.value as OpportunityDraft['decisionKind'],
                )
              }
            >
              {(['CONTINUE', 'PAUSE', 'EXIT'] as const).map((k) => (
                <option key={k} value={k}>
                  {message(
                    t,
                    k === 'CONTINUE'
                      ? 'opContinue'
                      : k === 'PAUSE'
                        ? 'opPause'
                        : 'opExit',
                  )}
                </option>
              ))}
            </select>
          </Field>
          <PersonInput
            title={t('opActualDecider')}
            value={d.actualPerson || null}
            onChange={(v) => set('actualPerson', v ?? '')}
            lookups={lookups}
          />
          {d.decisionKind === 'PAUSE' && (
            <>
              <Field title={t('opResume')}>
                <input
                  value={d.resumeCondition}
                  onChange={(e) => set('resumeCondition', e.target.value)}
                />
              </Field>
              <ValueInput
                title={t('opReviewDate')}
                value={d.reviewOn}
                type="date"
                onChange={(v) => set('reviewOn', v)}
              />
            </>
          )}
          {d.decisionKind === 'EXIT' && (
            <>
              <Field title={t('opExitReason')}>
                <input
                  value={d.exitReason}
                  onChange={(e) => set('exitReason', e.target.value)}
                />
              </Field>
              <Field title={t('opReentry')}>
                <input
                  value={d.reentryCondition}
                  onChange={(e) => set('reentryCondition', e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        <Field title={t('opDecisionText')}>
          <textarea
            value={d.decisionText}
            onChange={(e) => set('decisionText', e.target.value)}
          />
        </Field>
        <Field title={t('opEvidence')}>
          <textarea
            value={d.decisionBasis}
            onChange={(e) => set('decisionBasis', e.target.value)}
          />
        </Field>
        {d.actualPerson !== lookups.personId && (
          <div className="ct-grid">
            <Field title={t('opProxyBasis')}>
              <textarea
                value={d.proxyBasis}
                onChange={(e) => set('proxyBasis', e.target.value)}
              />
            </Field>
            <ValueInput
              title={t('opProxyFrom')}
              type="date"
              value={d.proxyFrom}
              onChange={(v) => set('proxyFrom', v)}
            />
            <ValueInput
              title={t('opProxyUntil')}
              type="date"
              value={d.proxyUntil}
              onChange={(v) => set('proxyUntil', v)}
            />
          </div>
        )}
        {occurrence}
        {source}
      </>
    );
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={d.noMaterialChange}
          onChange={(e) => set('noMaterialChange', e.target.checked)}
        />
        {t('opNoChange')}
      </label>
      {!d.noMaterialChange && (
        <Field title={t('opFact')}>
          <textarea
            value={d.newFact}
            onChange={(e) => set('newFact', e.target.value)}
          />
        </Field>
      )}
      {text && (
        <div className="ct-grid">
          <Field title={t('opEvidence')}>
            <textarea
              value={d.evidence}
              onChange={(e) => set('evidence', e.target.value)}
            />
          </Field>
          <Field title={t('opObstacle')}>
            <textarea
              value={d.obstacle}
              onChange={(e) => set('obstacle', e.target.value)}
            />
          </Field>
        </div>
      )}
      <fieldset>
        <legend>{t('opNext')}</legend>
        <Field title={t('opNext')}>
          <select
            value={d.nextMode}
            onChange={(e) =>
              set('nextMode', e.target.value as OpportunityDraft['nextMode'])
            }
          >
            <option value="KEEP">{t('opKeep')}</option>
            <option value="REPLACE">{t('opReplace')}</option>
            <option value="COMPLETE_AND_ADD" disabled={!d.baseline?.nextStep}>
              {t('opCompleteAdd')}
            </option>
          </select>
        </Field>
        {d.nextMode !== 'KEEP' && (
          <div className="ct-grid">
            <Field title={t('opAction')}>
              <textarea
                value={d.nextAction}
                onChange={(e) => set('nextAction', e.target.value)}
              />
            </Field>
            <PersonInput
              title={t('opOwner')}
              value={d.nextOwner}
              onChange={(v) => set('nextOwner', v)}
              lookups={lookups}
            />
            <ValueInput
              title={t('opDue')}
              type="date"
              value={d.nextDue}
              onChange={(v) => set('nextDue', v)}
            />
          </div>
        )}
      </fieldset>
      <details>
        <summary>{t('opFacts')}</summary>
        <div className="ct-grid">
          <Field title={t('opName')}>
            <input
              value={f.name}
              onChange={(e) => fact('name', e.target.value)}
            />
          </Field>
          <ValueInput
            title={t('opLine')}
            value={f.businessLine}
            onChange={(v) => fact('businessLine', v)}
          />
          <Field title={t('opGroup')}>
            <select
              value={
                f.customerGroup.state === 'VALUE'
                  ? (f.customerGroup.value ?? '')
                  : f.customerGroup.state
              }
              onChange={(e) =>
                fact(
                  'customerGroup',
                  e.target.value === 'INTERNAL' || e.target.value === 'EXTERNAL'
                    ? { state: 'VALUE', value: e.target.value }
                    : {
                        state: e.target.value as OpportunityValue['state'],
                        value: null,
                      },
                )
              }
            >
              <option value="BLANK">{t('ctBlank')}</option>
              <option value="UNKNOWN">{t('ctUnknown')}</option>
              <option value="NA">{t('ctNA')}</option>
              <option value="NOT_STATED">{t('ctNotStated')}</option>
              <option value="INTERNAL">{t('opInternal')}</option>
              <option value="EXTERNAL">{t('opExternal')}</option>
            </select>
          </Field>
          <PersonInput
            title={t('opOwner')}
            value={f.informationOwnerPersonId}
            onChange={(v) => fact('informationOwnerPersonId', v)}
            lookups={lookups}
          />
          <Field title={t('opAssistants')}>
            <select
              multiple
              value={f.assistantPersonIds}
              onChange={(e) =>
                fact(
                  'assistantPersonIds',
                  Array.from(e.target.selectedOptions).map((x) => x.value),
                )
              }
            >
              {lookups.people.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <ValueInput
            title={t('opStage')}
            value={f.stageRaw}
            onChange={(v) => fact('stageRaw', v)}
          />
          <ValueInput
            title={t('opProbability')}
            value={f.probabilityRaw}
            onChange={(v) => fact('probabilityRaw', v)}
          />
          <ValueInput
            title={t('opMustWin')}
            value={f.mustWinRaw}
            onChange={(v) => fact('mustWinRaw', v)}
          />
          {(
            [
              'tender',
              'expectedSigning',
              'expectedStart',
              'expectedCompletion',
            ] as const
          ).map((k, i) => (
            <ValueInput
              key={k}
              title={message(
                t,
                (['opTender', 'opSigning', 'opStart', 'opCompletion'] as const)[
                  i
                ]!,
              )}
              value={f.dates[k]}
              type="date"
              onChange={(v) => fact('dates', { ...f.dates, [k]: v })}
            />
          ))}
        </div>
        <fieldset>
          <legend>{t('opParties')}</legend>
          {f.parties.map((p, index) => (
            <div className="ct-grid" key={p.id}>
              <Field title={t('opPartyRole')}>
                <select
                  value={p.role}
                  onChange={(e) =>
                    fact(
                      'parties',
                      f.parties.map((x, i) =>
                        i === index
                          ? { ...x, role: e.target.value as typeof p.role }
                          : x,
                      ),
                    )
                  }
                >
                  {OPPORTUNITY_PARTY_ROLES.map((role) => (
                    <option value={role} key={role}>
                      {message(t, partyKeys[role])}
                    </option>
                  ))}
                </select>
              </Field>
              <ValueInput
                title={t('opRawName')}
                value={p.rawName}
                onChange={(v) =>
                  fact(
                    'parties',
                    f.parties.map((x, i) =>
                      i === index ? { ...x, rawName: v } : x,
                    ),
                  )
                }
              />
              <Field title={t('opCompany')}>
                <select
                  value={p.companyId ?? ''}
                  onChange={(e) =>
                    fact(
                      'parties',
                      f.parties.map((x, i) =>
                        i === index
                          ? { ...x, companyId: e.target.value || null }
                          : x,
                      ),
                    )
                  }
                >
                  <option value="">{t('opUnassigned')}</option>
                  {lookups.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                onClick={() =>
                  fact(
                    'parties',
                    f.parties.filter((x) => x.id !== p.id),
                  )
                }
              >
                {t('opRemove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              fact('parties', [
                ...f.parties,
                {
                  id: crypto.randomUUID(),
                  role: 'OWNER',
                  rawName: { state: 'BLANK', value: null },
                  companyId: null,
                },
              ])
            }
          >
            {t('opAddParty')}
          </button>
        </fieldset>
        <fieldset disabled={!ownerEditable}>
          <legend>{t('opOwnerProject')}</legend>
          {!ownerEditable && <p>{t('opProtectedEdit')}</p>}
          <div className="ct-grid">
            {(['projectType', 'country', 'city'] as const).map((k, i) => (
              <ValueInput
                key={k}
                title={message(
                  t,
                  (['opType', 'opCountry', 'opCity'] as const)[i]!,
                )}
                value={f.ownerProject[k]}
                onChange={(v) =>
                  fact('ownerProject', { ...f.ownerProject, [k]: v })
                }
              />
            ))}
          </div>
          <ScaleInput
            value={f.ownerProject.reportedScale}
            onChange={(v) =>
              fact('ownerProject', { ...f.ownerProject, reportedScale: v })
            }
          />
          {f.ownerProject.conditions.map((c, index) => (
            <div key={c.id} className="ct-grid">
              <Field title={t('opCondition')}>
                <input
                  value={c.summary}
                  onChange={(e) =>
                    fact('ownerProject', {
                      ...f.ownerProject,
                      conditions: f.ownerProject.conditions.map((x, i) =>
                        i === index ? { ...x, summary: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <ValueInput
                title={t('opResponsibleRaw')}
                value={c.responsibleRaw}
                onChange={(v) =>
                  fact('ownerProject', {
                    ...f.ownerProject,
                    conditions: f.ownerProject.conditions.map((x, i) =>
                      i === index ? { ...x, responsibleRaw: v } : x,
                    ),
                  })
                }
              />
              <Field title={t('ctStatus')}>
                <select
                  value={c.status}
                  onChange={(e) =>
                    fact('ownerProject', {
                      ...f.ownerProject,
                      conditions: f.ownerProject.conditions.map((x, i) =>
                        i === index
                          ? { ...x, status: e.target.value as typeof c.status }
                          : x,
                      ),
                    })
                  }
                >
                  {(
                    ['UNMET', 'MET', 'NA', 'UNKNOWN', 'NOT_STATED'] as const
                  ).map((k) => (
                    <option key={k} value={k}>
                      {message(t, conditionKeys[k])}
                    </option>
                  ))}
                </select>
              </Field>
              {text && (
                <Field title={t('opEvidence')}>
                  <textarea
                    value={c.basis ?? ''}
                    onChange={(e) =>
                      fact('ownerProject', {
                        ...f.ownerProject,
                        conditions: f.ownerProject.conditions.map((x, i) =>
                          i === index
                            ? { ...x, basis: e.target.value || null }
                            : x,
                        ),
                      })
                    }
                  />
                </Field>
              )}
              <button
                type="button"
                onClick={() =>
                  fact('ownerProject', {
                    ...f.ownerProject,
                    conditions: f.ownerProject.conditions.filter(
                      (x) => x.id !== c.id,
                    ),
                  })
                }
              >
                {t('opRemove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              fact('ownerProject', {
                ...f.ownerProject,
                conditions: [
                  ...f.ownerProject.conditions,
                  {
                    id: crypto.randomUUID(),
                    summary: '',
                    responsibleRaw: { state: 'UNKNOWN', value: null },
                    status: 'UNKNOWN',
                    basis: null,
                  },
                ],
              })
            }
          >
            {t('opAddCondition')}
          </button>
        </fieldset>
        <fieldset>
          <legend>{t('opOurScope')}</legend>
          {f.proposedScopes.map((p, index) => (
            <div key={p.id} className="op-scope">
              <div className="ct-grid">
                <ValueInput
                  title={t('opScopeRole')}
                  value={p.roleRaw}
                  onChange={(v) =>
                    fact(
                      'proposedScopes',
                      f.proposedScopes.map((x, i) =>
                        i === index ? { ...x, roleRaw: v } : x,
                      ),
                    )
                  }
                />
                <ValueInput
                  title={t('opScopeSummary')}
                  value={p.summary}
                  onChange={(v) =>
                    fact(
                      'proposedScopes',
                      f.proposedScopes.map((x, i) =>
                        i === index ? { ...x, summary: v } : x,
                      ),
                    )
                  }
                />
              </div>
              <ScaleInput
                value={p.scale}
                onChange={(v) =>
                  fact(
                    'proposedScopes',
                    f.proposedScopes.map((x, i) =>
                      i === index ? { ...x, scale: v } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  fact(
                    'proposedScopes',
                    f.proposedScopes.filter((x) => x.id !== p.id),
                  )
                }
              >
                {t('opRemove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              fact('proposedScopes', [
                ...f.proposedScopes,
                {
                  id: crypto.randomUUID(),
                  roleRaw: { state: 'BLANK', value: null },
                  summary: { state: 'BLANK', value: null },
                  scale: blankScale(),
                },
              ])
            }
          >
            {t('opAddScope')}
          </button>
        </fieldset>
        {text && (
          <ValueInput
            title={t('opNote')}
            value={f.internalNote}
            onChange={(v) => fact('internalNote', v)}
          />
        )}
        <Field title={t('opChangeReason')}>
          <textarea
            value={d.reason}
            onChange={(e) => set('reason', e.target.value)}
          />
        </Field>
      </details>
      {occurrence}
      {text && source}
    </>
  );
}
export const partyKeys: Record<
  (typeof OPPORTUNITY_PARTY_ROLES)[number],
  MessageKey
> = {
  OWNER: 'opPartyOwner',
  INVESTOR: 'opPartyInvestor',
  EPC_CONTRACTOR: 'opPartyEpc',
  CUSTOMER: 'opPartyCustomer',
  PAYER: 'opPartyPayer',
  REFERRER: 'opPartyReferrer',
  COMPETITOR: 'opPartyCompetitor',
  OTHER: 'opPartyOther',
};
export const conditionKeys: Record<
  OpportunityFacts['ownerProject']['conditions'][number]['status'],
  MessageKey
> = {
  UNMET: 'opUnmet',
  MET: 'opMet',
  NA: 'ctNA',
  UNKNOWN: 'ctUnknown',
  NOT_STATED: 'ctNotStated',
};
