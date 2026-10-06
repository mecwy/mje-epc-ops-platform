import type { ReactNode } from 'react';
import type { DayFactsDto, ReportItemDto } from '@mje/contracts';
import { narrativeText } from '@mje/ui';
import { useI18n } from '../i18n.js';
import { byKind } from './model.js';
import { shown } from './format.js';

function Value({ raw, unit = '' }: { raw: string | undefined; unit?: string }) {
  const { t, locale } = useI18n();
  const value = shown(raw, locale);
  if (value.kind === 'blank')
    return <span className="miss">{t('notFilled')}</span>;
  if (value.kind === 'token') return <span>{t(value.token)}</span>;
  return (
    <span className={value.kind === 'invalid' ? 'miss' : 'num'}>
      {value.kind === 'number' ? value.text : value.raw}
      {unit && ` ${unit}`}
    </span>
  );
}

/** The current draft's declarations, without deriving totals or changing its facts. */
export function ReviewFacts({
  facts,
  items,
  projectName,
  roles,
}: {
  facts: DayFactsDto;
  items: ReportItemDto[];
  projectName: string;
  roles: ReadonlyArray<{ key: string; label: string }>;
}) {
  const { t, label, lang } = useI18n();
  const unit = (it: ReportItemDto) =>
    it.unit ? label(`u_${it.unit}`).replace(/^u_/, '') : '';
  const entered = (raw: string | undefined) => (raw ?? '').trim() !== '';
  const work = byKind(items, 'work').filter(
    (it) => entered(facts.qty[it.key]) || entered(facts.cumulative[it.key]),
  );
  const people = roles.filter((role) => entered(facts.people[role.key]));
  function section(title: string, contents: ReactNode) {
    return (
      <section className="card review-facts" aria-label={title}>
        <h2 className="blk">{title}</h2>
        {contents}
      </section>
    );
  }
  function resources(kind: 'machinery' | 'material') {
    const values = kind === 'material' ? facts.materials : facts.machinery;
    const rows = byKind(items, kind).filter((it) => entered(values[it.key]));
    if (!rows.length) return null;
    return section(
      kind === 'material' ? t('materials') : t('machinery'),
      <dl>
        {rows.map((it) => (
          <div className="review-facts-row" key={it.key}>
            <dt>{label(it.label)}</dt>
            <dd>
              <Value raw={values[it.key]} unit={unit(it)} />
            </dd>
          </div>
        ))}
      </dl>,
    );
  }
  return (
    <>
      {section(t('project'), <p>{projectName}</p>)}
      {facts.reportLocationRef &&
        section(
          t('weatherLocation_savedLocation'),
          <dl>
            <div className="review-facts-row">
              <dt>{t('weatherLocation_accuracy')}</dt>
              <dd>{facts.reportLocationRef.accuracyM} m</dd>
            </div>
            <div className="review-facts-row">
              <dt>{t('weatherLocation_device')}</dt>
              <dd>{facts.reportLocationRef.deviceFixAt ?? t('unknown')}</dd>
            </div>
            <div className="review-facts-row">
              <dt>{t('weatherLocation_acquired')}</dt>
              <dd>{facts.reportLocationRef.acquiredAt}</dd>
            </div>
          </dl>,
        )}
      {section(
        t('weather'),
        <dl>
          <div className="review-facts-row">
            <dt>{t('weather')}</dt>
            <dd>
              {facts.weather || <span className="miss">{t('notFilled')}</span>}
            </dd>
          </div>
          {facts.temperature !== '' && (
            <div className="review-facts-row">
              <dt>{t('temperature')}</dt>
              <dd>{facts.temperature}</dd>
            </div>
          )}
        </dl>,
      )}
      {section(
        t('progress'),
        work.length ? (
          <dl>
            {work.map((it) => (
              <div className="review-facts-row" key={it.key}>
                <dt>{label(it.label)}</dt>
                <dd>
                  <Value raw={facts.qty[it.key]} unit={unit(it)} />
                  {entered(facts.cumulative[it.key]) && (
                    <small>
                      {t('cumulative')}{' '}
                      <Value raw={facts.cumulative[it.key]} unit={unit(it)} />
                    </small>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="miss">{t('notFilled')}</span>
        ),
      )}
      {section(
        t('people'),
        people.length ? (
          <dl>
            {people.map((role) => (
              <div className="review-facts-row" key={role.key}>
                <dt>{role.label}</dt>
                <dd>
                  <Value raw={facts.people[role.key]} unit={t('persons')} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="miss">{t('notFilled')}</span>
        ),
      )}
      {resources('material')}
      {resources('machinery')}
      {(['construction', 'quality', 'safety'] as const).map((key) =>
        facts.narrative[key] ? (
          <section className="card review-facts" key={key} aria-label={t(key)}>
            <h2 className="blk">{t(key)}</h2>
            <p>{narrativeText(facts.narrative[key], lang)}</p>
          </section>
        ) : null,
      )}
    </>
  );
}
