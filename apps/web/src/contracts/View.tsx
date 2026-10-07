import type {
  ContractAmountDto,
  ContractEditorLookupsDto,
  ContractRevisionDto,
  ContractValue,
  ContractShareDto,
  ContractSourceDto,
} from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import { message } from './messages.js';
import { useI18n } from '../i18n.js';
import { stateKeys, priceKeys } from './Editor.js';
import type { ContractDraft } from './drafts.js';
export const basisKeys: Record<ContractShareDto['basis'], MessageKey> = {
  WHOLE: 'ctWhole',
  QUANTITY: 'ctQuantity',
  AREA: 'ctArea',
  NOTE: 'ctNote',
};
const allocationKeys: Record<
  ContractRevisionDto['lines'][number]['allocation']['state'],
  MessageKey
> = {
  UNALLOCATED: 'ctUnallocated',
  PARTIAL: 'ctPartial',
  ALLOCATED: 'ctAllocated',
  UNQUANTIFIED: 'ctUnquantified',
  RECONCILE: 'ctReconcile',
  RESTRICTED: 'ctRestricted',
};
export function ValueText({ value }: { value: ContractValue }) {
  const { t } = useI18n();
  return (
    <>
      {value.state === 'VALUE'
        ? value.value
        : message(t, stateKeys[value.state])}
    </>
  );
}
export function Amount({
  value,
  total = false,
}: {
  value: ContractAmountDto;
  total?: boolean;
}) {
  const { t } = useI18n();
  return (
    <>
      {value.visibility === 'restricted' ? (
        total && value.restriction === 'PROJECT_SCOPE' ? (
          t('ctProjectTotal')
        ) : (
          t('ctRestricted')
        )
      ) : value.state === 'VALUE' ? (
        <>
          {value.value} {value.currency}
        </>
      ) : value.state ? (
        message(t, stateKeys[value.state])
      ) : (
        t('ctUnknown')
      )}
    </>
  );
}
export function ShareView({
  share,
  lookups,
}: {
  share: ContractShareDto;
  lookups: ContractEditorLookupsDto;
}) {
  const { t } = useI18n();
  const project = lookups.projects.find((p) => p.id === share.projectId);
  return (
    <article className="ct-share">
      <strong>
        {project ? project.code + ' · ' + project.name : t('ctShares')}
      </strong>
      <p>
        {t('ctShareVersion', { n: share.version })} ·{' '}
        {t('ctPinnedVersion', { n: share.pinnedRevisionN })} ·{' '}
        {message(t, basisKeys[share.basis])}
        {share.quantity !== null
          ? ' · ' + share.quantity + ' ' + share.unitRaw
          : ''}
      </p>
      <p>{share.description}</p>
      {share.retired && <p>{t('ctRetired')}</p>}
      {share.needsReconciliation && (
        <p className="ct-warning">{t('ctReconcile')}</p>
      )}
      {share.internal.visibility === 'visible' && (
        <p>
          {share.internal.area} {share.internal.note} {share.internal.reason}
        </p>
      )}
      <p className="muted">{t('ctNoAutoAmount')}</p>
    </article>
  );
}
function SourceView({
  source,
  title,
}: {
  source: ContractSourceDto | null | undefined;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <p>
      <b>{title}: </b>
      {source ? source.filename + ' · ' + source.location : t('ctNoBinding')}
    </p>
  );
}
export function RevisionView({
  revision: r,
  lookups,
  inputPreview = false,
}: {
  revision: ContractRevisionDto;
  lookups: ContractEditorLookupsDto;
  inputPreview?: boolean;
}) {
  const { t } = useI18n();
  return (
    <section className="ct-revision">
      <h2>{r.name}</h2>
      <div className="ct-facts">
        <p>
          <b>{t('ctOriginalNo')}</b>
          <span>{r.originalNumber ?? t('ctNotStated')}</span>
        </p>
        <p>
          <b>{t('ctParty')}</b>
          <span>{r.counterpartyRaw ?? t('ctNotStated')}</span>
        </p>
        <p>
          <b>{t('ctSelf')}</b>
          <span>{r.selfPartyRaw ?? t('ctNotStated')}</span>
        </p>
        <p>
          <b>{t('ctOwner')}</b>
          <span>{r.informationOwnerDisplayName ?? t('ctNone')}</span>
        </p>
        <p>
          <b>{t('ctSignedOn')}</b>
          <span>
            {r.signedOn.state === 'VALUE'
              ? r.signedOn.value
              : message(t, stateKeys[r.signedOn.state])}
          </span>
        </p>
        <p>
          <b>{t('ctEffectiveOn')}</b>
          <span>
            {r.effectiveOn.state === 'VALUE'
              ? r.effectiveOn.value
              : message(t, stateKeys[r.effectiveOn.state])}
          </span>
        </p>
        <p>
          <b>{t('ctStatus')}</b>
          <span>
            {r.registrationStatus === 'EFFECTIVE'
              ? t('ctEffective')
              : t('ctPending')}
          </span>
        </p>
        <p>
          <b>{t('ctTotal')}</b>
          <span>
            <Amount value={r.total} total />
          </span>
        </p>
        {r.total.taxBasis && (
          <p>
            <b>{t('ctTax')}</b>
            <span>
              {r.total.taxBasis === 'UNKNOWN'
                ? t('ctUnknown')
                : r.total.taxBasis === 'INCLUSIVE'
                  ? t('ctInclusive')
                  : t('ctExclusive')}
            </span>
          </p>
        )}
      </div>
      {r.evidence.visibility === 'visible' && r.evidence.headLocs && (
        <>
          <SourceView
            title={t('ctPartiesSource')}
            source={r.evidence.headLocs.parties}
          />
          <SourceView
            title={t('ctDatesSource')}
            source={r.evidence.headLocs.dates}
          />
          <SourceView
            title={t('ctTotalSource')}
            source={r.evidence.headLocs.total}
          />
        </>
      )}
      {r.internal.visibility === 'visible' && r.internal.correctionReason && (
        <p>
          {t('ctReason')}: {r.internal.correctionReason}
        </p>
      )}
      {r.evidence.visibility === 'visible' && (
        <section>
          <h3>{t('ctSource')}</h3>
          {r.evidence.sources?.map((s, i) => (
            <p key={i}>
              {s.filename} · {s.location}
            </p>
          ))}
        </section>
      )}
      <h3>{t('ctStepLines')}</h3>
      {r.lines.map((l) => (
        <article className="ct-line" key={l.id}>
          <h4>
            {l.lineNo} · {l.description}
          </h4>
          <p>
            {t('ctQuantity')}: <ValueText value={l.quantity} /> {l.unitRaw}{' '}
            {l.unit && l.unit !== l.unitRaw ? '(' + l.unit + ')' : ''}
          </p>
          {l.removed && <p className="ct-warning">{t('ctRemoved')}</p>}
          <p>
            {t('ctLineAmount')}: <Amount value={l.amount} />
          </p>
          {l.sharedLineAmount && <p className="ct-warning">{t('ctShared')}</p>}
          {l.pricing.visibility === 'visible' && l.pricing.type && (
            <p>
              {t('ctPricing')}:{' '}
              {message(
                t,
                priceKeys[l.pricing.type as keyof typeof priceKeys] ??
                  'ctUnknown',
              )}
            </p>
          )}
          {l.internal.visibility === 'visible' && (
            <>
              <p>
                {t('ctIncludes')}: {l.internal.includes}
              </p>
              <p>
                {t('ctExcludes')}: {l.internal.excludes}
              </p>
              <p>
                {t('ctDerivation')}: {l.internal.derivation}
              </p>
            </>
          )}
          {l.evidence.visibility === 'visible' && (
            <>
              <SourceView title={t('ctSource')} source={l.evidence.source} />
              {l.removed && (
                <SourceView
                  title={t('ctRemovalSource')}
                  source={l.evidence.removalSource}
                />
              )}
            </>
          )}
          {!inputPreview && (
            <p>
              {message(t, allocationKeys[l.allocation.state])}
              {l.allocation.remaining !== null
                ? ' · ' + l.allocation.remaining + ' ' + l.unitRaw
                : ''}
            </p>
          )}
          {!inputPreview &&
            l.shares.map((s) => (
              <ShareView key={s.scopeId} share={s} lookups={lookups} />
            ))}
        </article>
      ))}
    </section>
  );
}
export function preview(
  draft: ContractDraft,
  lookups: ContractEditorLookupsDto,
): ContractRevisionDto {
  const r = draft.revision;
  const source = (loc: typeof r.headLocs.parties): ContractSourceDto | null =>
    loc
      ? {
          ...loc,
          filename:
            lookups.sources.find((s) => s.id === loc.sourceDocumentId)
              ?.filename ?? '',
          sha256:
            lookups.sources.find((s) => s.id === loc.sourceDocumentId)
              ?.sha256 ?? '',
        }
      : null;
  return {
    n: draft.version + 1,
    name: r.name,
    originalNumber: r.originalNumber,
    counterpartyRaw: r.counterpartyRaw,
    selfPartyRaw: r.selfPartyRaw,
    informationOwnerPersonId: r.informationOwnerPersonId,
    informationOwnerDisplayName:
      lookups.people.find((p) => p.id === r.informationOwnerPersonId)
        ?.displayName ?? null,
    registeredAt: '',
    signedOn: r.signedOn,
    effectiveOn: r.effectiveOn,
    registrationStatus: r.registrationStatus,
    total: {
      visibility: 'visible',
      ...r.total,
      currency: r.currency,
      taxBasis: r.taxBasis,
    },
    internal: { visibility: 'visible', correctionReason: draft.reason },
    evidence: {
      visibility: 'visible',
      headLocs: {
        parties: source(r.headLocs.parties),
        dates: source(r.headLocs.dates),
        total: source(r.headLocs.total),
      },
      sources: r.sources.map((s) => ({
        ...s,
        filename:
          lookups.sources.find((d) => d.id === s.sourceDocumentId)?.filename ??
          '',
        sha256:
          lookups.sources.find((d) => d.id === s.sourceDocumentId)?.sha256 ??
          '',
      })),
    },
    lines: r.lines.map((l) => ({
      ...l,
      amount: {
        visibility: 'visible',
        ...l.amount,
        currency: r.currency,
        taxBasis: r.taxBasis,
      },
      pricing: { visibility: 'visible', type: l.pricingType },
      internal: {
        visibility: 'visible',
        includes: l.includes,
        excludes: l.excludes,
        derivation: l.derivation,
      },
      evidence: {
        visibility: 'visible',
        source: source(l.source),
        removalSource: source(l.removalSource),
      },
      shares: [],
      allocation: { state: 'UNALLOCATED', remaining: null },
      sharedLineAmount: false,
      canMaintainShares: false,
    })),
  };
}
