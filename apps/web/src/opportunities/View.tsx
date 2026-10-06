import { message } from '../contracts/messages.js';
import type {
  OpportunityFacts,
  OpportunityFactsDto,
  OpportunityFieldValueDto,
  OpportunityHistoryDto,
  OpportunityItemDto,
  OpportunityLookupsDto,
  OpportunityProjected,
  OpportunityScale,
  OpportunitySourceDto,
  OpportunityUpdateDto,
  OpportunityValue,
} from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { stateKeys } from '../contracts/Editor.js';
import { factLabels, partyKeys, conditionKeys } from './Form.js';
export function ValueText({ value }: { value: OpportunityValue }) {
  const { t } = useI18n();
  return (
    <>
      {value.state === 'VALUE'
        ? value.value
        : message(t, stateKeys[value.state])}
    </>
  );
}
export function ProtectedText({
  value,
}: {
  value: OpportunityProjected<string | null | OpportunityValue>;
}) {
  const { t } = useI18n();
  return (
    <>
      {value.visibility === 'restricted' ? (
        t('ctRestricted')
      ) : value.value === null ? (
        t('ctBlank')
      ) : typeof value.value === 'object' && 'state' in value.value ? (
        <ValueText value={value.value} />
      ) : (
        String(value.value)
      )}
    </>
  );
}
export const personName = (
  id: string | null,
  lookups: OpportunityLookupsDto,
  unassigned: string,
) =>
  id
    ? (lookups.people.find((x) => x.id === id)?.displayName ?? id)
    : unassigned;
function Scale({ value }: { value: OpportunityScale }) {
  const { t } = useI18n();
  return (
    <>
      <ValueText value={value.value} />
      {value.unitRaw && <> {value.unitRaw}</>} · {t('opBasis')}:{' '}
      <ValueText value={value.basis} />
    </>
  );
}
export function FieldValue({
  field,
  value,
  lookups,
}: {
  field: keyof OpportunityFacts;
  value: OpportunityFieldValueDto | OpportunityFacts[keyof OpportunityFacts];
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n();
  if (value === null) return <>{t('opUnassigned')}</>;
  if (typeof value === 'string')
    return (
      <>
        {field === 'informationOwnerPersonId'
          ? personName(value, lookups, t('opUnassigned'))
          : value}
      </>
    );
  if (Array.isArray(value)) {
    if (!value.length) return <>{t('ctBlank')}</>;
    return (
      <ul>
        {value.map((x, index) => {
          if (typeof x === 'string')
            return <li key={x}>{personName(x, lookups, t('opUnassigned'))}</li>;
          if ('companyId' in x)
            return (
              <li key={x.id}>
                {message(t, partyKeys[x.role])}: <ValueText value={x.rawName} />{' '}
                ·{' '}
                {x.companyId
                  ? (lookups.companies.find((c) => c.id === x.companyId)
                      ?.name ?? x.companyId)
                  : t('opUnassigned')}
              </li>
            );
          return (
            <li key={x.id ?? index}>
              <ValueText value={x.roleRaw} /> · <ValueText value={x.summary} />{' '}
              · <Scale value={x.scale} />
            </li>
          );
        })}
      </ul>
    );
  }
  if ('state' in value) return <ValueText value={value} />;
  if ('tender' in value)
    return (
      <dl className="op-facts">
        {(
          [
            'tender',
            'expectedSigning',
            'expectedStart',
            'expectedCompletion',
          ] as const
        ).map((k, i) => (
          <div key={k}>
            <dt>
              {message(
                t,
                (['opTender', 'opSigning', 'opStart', 'opCompletion'] as const)[
                  i
                ]!,
              )}
            </dt>
            <dd>
              <ValueText value={value[k]} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <>
      <dl className="op-facts">
        {(['projectType', 'country', 'city'] as const).map((k, i) => (
          <div key={k}>
            <dt>
              {message(t, (['opType', 'opCountry', 'opCity'] as const)[i]!)}
            </dt>
            <dd>
              <ValueText value={value[k]} />
            </dd>
          </div>
        ))}
        <div>
          <dt>{t('opScale')}</dt>
          <dd>
            <Scale value={value.reportedScale} />
          </dd>
        </div>
      </dl>
      <ul>
        {value.conditions.map((c) => (
          <li key={c.id}>
            {c.summary} · <ValueText value={c.responsibleRaw} /> ·{' '}
            {message(t, conditionKeys[c.status])} ·{' '}
            {typeof c.basis === 'object' && c.basis !== null ? (
              <ProtectedText value={c.basis} />
            ) : (
              (c.basis ?? t('ctBlank'))
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
export function FactsView({
  facts: f,
  lookups,
}: {
  facts: OpportunityFactsDto;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n();
  return (
    <>
      <dl className="op-facts">
        {(
          [
            'businessLine',
            'customerGroup',
            'informationOwnerPersonId',
            'assistantPersonIds',
            'stageRaw',
          ] as const
        ).map((k) => (
          <div key={k}>
            <dt>{message(t, factLabels[k])}</dt>
            <dd>
              <FieldValue field={k} value={f[k]} lookups={lookups} />
            </dd>
          </div>
        ))}
        <div>
          <dt>{t('opProbability')}</dt>
          <dd>
            <ProtectedText value={f.probabilityRaw} />
          </dd>
        </div>
        <div>
          <dt>{t('opMustWin')}</dt>
          <dd>
            <ProtectedText value={f.mustWinRaw} />
          </dd>
        </div>
      </dl>
      <FieldValue field="dates" value={f.dates} lookups={lookups} />
      <details>
        <summary>{t('opParties')}</summary>
        <FieldValue field="parties" value={f.parties} lookups={lookups} />
      </details>
      <details>
        <summary>{t('opOwnerProject')}</summary>
        <FieldValue
          field="ownerProject"
          value={f.ownerProject}
          lookups={lookups}
        />
      </details>
      <details>
        <summary>{t('opOurScope')}</summary>
        <FieldValue
          field="proposedScopes"
          value={f.proposedScopes}
          lookups={lookups}
        />
      </details>
      <details>
        <summary>{t('opNote')}</summary>
        <ProtectedText value={f.internalNote} />
      </details>
    </>
  );
}
function Sources({
  sources,
}: {
  sources: OpportunityProjected<OpportunitySourceDto[]>;
}) {
  const { t } = useI18n();
  return sources.visibility === 'restricted' ? (
    <p>{t('ctRestricted')}</p>
  ) : (
    <ul>
      {sources.value.map((s, i) => (
        <li key={i}>
          {s.reference} · {s.location}
          {s.filename && (
            <>
              {' '}
              · {s.filename} · <span className="op-reference">{s.sha256}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
export function UpdateView({
  update: u,
  lookups,
}: {
  update: OpportunityUpdateDto;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n();
  return (
    <article className="op-record">
      <p>
        <time>{u.recordedAt}</time> ·{' '}
        {personName(u.recordedByPersonId, lookups, t('opUnassigned'))}
      </p>
      <p>{u.noMaterialChange ? t('opNoChange') : u.newFact}</p>
      <p>
        {t('opEvidence')}: <ProtectedText value={u.evidence} />
      </p>
      <p>
        {t('opObstacle')}: <ProtectedText value={u.obstacle} />
      </p>
      {u.occurrence.occurredAt && (
        <p>
          {t('opOccurred')}: {u.occurrence.occurredAt} · {u.occurrence.timezone}
        </p>
      )}
      {u.occurrence.businessDate && (
        <p>
          {t('opBusinessDate')}: {u.occurrence.businessDate}
        </p>
      )}
      {u.nextStep && (
        <p>
          {t('opNext')}: {u.nextStep.action} ·{' '}
          {personName(u.nextStep.ownerPersonId, lookups, t('opUnassigned'))} ·{' '}
          <ValueText value={u.nextStep.dueOn} />
        </p>
      )}
      {u.changes.map((c) => (
        <div key={c.field}>
          <h4>{message(t, factLabels[c.field])}</h4>
          <div className="op-compare">
            <div>
              {c.before.visibility === 'visible' ? (
                <FieldValue
                  field={c.field}
                  value={c.before.value}
                  lookups={lookups}
                />
              ) : (
                t('ctRestricted')
              )}
            </div>
            <span aria-label={t('opFacts')}>→</span>
            <div>
              {c.after.visibility === 'visible' ? (
                <FieldValue
                  field={c.field}
                  value={c.after.value}
                  lookups={lookups}
                />
              ) : (
                t('ctRestricted')
              )}
            </div>
          </div>
          <p>
            {t('opChangeReason')}: <ProtectedText value={c.reason} />
          </p>
          {c.dateChange && (
            <p>
              {message(
                t,
                c.dateChange === 'RESCHEDULE' ? 'opReschedules' : 'opCertainty',
              )}
            </p>
          )}
        </div>
      ))}
      <details>
        <summary>{t('opSource')}</summary>
        <Sources sources={u.sources} />
      </details>
    </article>
  );
}
export function HistoryView({
  history: h,
  lookups,
}: {
  history: OpportunityHistoryDto;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n();
  return (
    <section>
      <h3>{t('opHistory')}</h3>
      {h.updates.map((u) => (
        <UpdateView key={u.id} update={u} lookups={lookups} />
      ))}
      {h.requests.map((r) => (
        <article key={r.id} className="op-record">
          <h4>{t('opRequest')}</h4>
          <p>
            {r.recordedAt} ·{' '}
            {personName(r.raisedByPersonId, lookups, t('opUnassigned'))} →{' '}
            {personName(r.requestedPersonId, lookups, t('opUnassigned'))}
          </p>
          <ProtectedText value={r.explanation} />
        </article>
      ))}
      {h.decisions.map((d) => (
        <article key={d.n} className="op-record">
          <h4>{t('opDecide')}</h4>
          <p>
            {message(
              t,
              d.previous.kind === 'CONTINUE'
                ? 'opContinue'
                : d.previous.kind === 'PAUSE'
                  ? 'opPause'
                  : 'opExit',
            )}{' '}
            →{' '}
            {message(
              t,
              d.current.kind === 'CONTINUE'
                ? 'opContinue'
                : d.current.kind === 'PAUSE'
                  ? 'opPause'
                  : 'opExit',
            )}
          </p>
          <p>
            {d.recordedAt} · {t('opActualDecider')}:{' '}
            {personName(d.actualDecisionPersonId, lookups, t('opUnassigned'))} ·{' '}
            {t('opRecordedBy')}:{' '}
            {personName(d.recordedByPersonId, lookups, t('opUnassigned'))}
          </p>
          <p>
            <ProtectedText value={d.recordText} />
          </p>
          <p>
            <ProtectedText value={d.basis} />
          </p>
          {d.proxy.visibility === 'visible' && d.proxy.value && (
            <p>
              {d.proxy.value.basis} · <ValueText value={d.proxy.value.from} /> →{' '}
              <ValueText value={d.proxy.value.until} />
            </p>
          )}
          {d.proxy.visibility === 'restricted' && <p>{t('ctRestricted')}</p>}
        </article>
      ))}
      <details>
        <summary>{t('opFacts')}</summary>
        {h.revisions.map((r) => (
          <article key={r.n} className="op-record">
            <p>{r.recordedAt}</p>
            <FactsView facts={r.facts} lookups={lookups} />
            <Sources sources={r.sources} />
          </article>
        ))}
      </details>
    </section>
  );
}
export function ItemView({
  item,
  lookups,
}: {
  item: OpportunityItemDto;
  lookups: OpportunityLookupsDto;
}) {
  const { t } = useI18n(),
    kind = item.effectiveDecision.kind;
  return (
    <>
      <h2>{item.revision.facts.name}</h2>
      <p className="op-reference">{item.code}</p>
      <p className="op-status">
        {item.decisionIsDefault
          ? t('opDefault')
          : message(
              t,
              kind === 'CONTINUE'
                ? 'opContinue'
                : kind === 'PAUSE'
                  ? 'opPause'
                  : 'opExit',
            )}
      </p>
      {item.effectiveDecision.resumeCondition && (
        <p>
          {t('opResume')}: {item.effectiveDecision.resumeCondition}
        </p>
      )}
      {kind === 'PAUSE' && (
        <p>
          {t('opReviewDate')}:{' '}
          <ValueText value={item.effectiveDecision.reviewOn} />
        </p>
      )}
      {item.effectiveDecision.exitReason && (
        <p>
          {t('opExitReason')}: {item.effectiveDecision.exitReason}
        </p>
      )}
      {item.effectiveDecision.reentryCondition && (
        <p>
          {t('opReentry')}: {item.effectiveDecision.reentryCondition}
        </p>
      )}
      <p>
        {t('opLastContact')}: {item.lastContact?.recordedAt ?? t('ctUnknown')}
      </p>
      <p>
        {t('opLastProgress')}:{' '}
        {item.lastSubstantiveProgress?.recordedAt ?? t('ctUnknown')}
      </p>
      <p>
        {t('opReschedules')}: {item.rescheduleCount}
      </p>
      {item.nextStep && (
        <div className="op-callout">
          <strong>{t('opNext')}</strong>
          <p>
            {item.nextStep.action} ·{' '}
            {personName(
              item.nextStep.ownerPersonId,
              lookups,
              t('opUnassigned'),
            )}{' '}
            · <ValueText value={item.nextStep.dueOn} />
          </p>
        </div>
      )}
      {item.pendingRequest && (
        <div className="op-callout">
          <strong>{t('opPending')}</strong>
          <p>
            {personName(
              item.pendingRequest.requestedPersonId,
              lookups,
              t('opUnassigned'),
            )}{' '}
            · <ValueText value={item.pendingRequest.dueOn} />
          </p>
          <ProtectedText value={item.pendingRequest.explanation} />
        </div>
      )}
      <FactsView facts={item.revision.facts} lookups={lookups} />
    </>
  );
}
