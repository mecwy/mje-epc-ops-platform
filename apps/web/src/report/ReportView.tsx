import { useState } from 'react';
import type { ReportItemDto } from '@mje/contracts';
import { ROLE_GROUP, ROLE_KEYS, dec, decText, pct } from '@mje/domain/rules';
import type { DayView, ReportContent, RevisionMeta } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip, Kv } from '../ui.js';
import { fmtNum, fmtTime, shown } from './format.js';
import { activeWork, byKind, target } from './model.js';

function Val({ raw }: { raw: string | undefined }) {
  const { t, locale } = useI18n();
  const s = shown(raw, locale);
  if (s.kind === 'blank') return <span className="miss">{t('notFilled')}</span>;
  if (s.kind === 'token') return <span>{t(s.token)}</span>;
  if (s.kind === 'invalid') return <span className="miss">{s.raw}</span>;
  return <b className="num">{s.text}</b>;
}
const unitOf = (label: (s: string) => string, it?: ReportItemDto) =>
  it?.unit ? label(`u_${it.unit}`).replace(/^u_/, '') : '';

function Progress({ c }: { c: ReportContent }) {
  const { t, label, locale } = useI18n();
  const f = c.facts;
  const { active } = activeWork(c);
  const items = byKind(c.items, 'work');
  const tomorrow =
    c.nextPlan.status === 'none'
      ? []
      : c.nextPlan.rows.filter((r) => r.target !== '');
  return (
    <section className="card">
      <h2 className="blk">{t('progress')}</h2>
      {active.length === 0 && <p className="miss">{t('notFilled')}</p>}
      {active.map((it, n) => {
        const q = f.qty[it.key];
        const b = target(c, it.key);
        const p = pct(dec(q), dec(b));
        const cum = f.cumulative[it.key];
        const cp = pct(dec(cum), dec(it.designQty));
        return (
          <div key={it.key} className={`prog${n === 0 ? ' lead' : ''}`}>
            <div className="prog-top">
              <span className="prog-name">{label(it.label)}</span>
              <span className="prog-val">
                <Val raw={q} />
                {b && (
                  <span className="muted">
                    {' '}
                    / {t('baselineN', { n: fmtNum(b, locale) })}
                  </span>
                )}{' '}
                <span className="muted">{unitOf(label, it)}</span>
              </span>
              {p && <span className="pct">{p}%</span>}
            </div>
            {p && (
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${Math.min(100, Number(p))}%` }}
                />
              </div>
            )}
            {cum && (
              <div className="muted small">
                {t('cumulative')} {fmtNum(cum, locale)}
                {it.designQty ? ` / ${fmtNum(it.designQty, locale)}` : ''}
                {cp ? ` · ${cp}%` : ''}
              </div>
            )}
          </div>
        );
      })}
      <p className="para">
        {f.narrative.construction.trim() || (
          <span className="miss">
            {t('construction')} · {t('notFilled')}
          </span>
        )}
      </p>
      <Kv label={t('tomorrow')} top>
        {tomorrow.length ? (
          tomorrow
            .map((r) => {
              const it = items.find((i) => i.key === r.item);
              return `${it ? label(it.label) : r.item} ${fmtNum(r.target, locale)} ${unitOf(label, it)}`;
            })
            .join(' · ')
        ) : (
          <span className="miss">{t('notPlanned')}</span>
        )}{' '}
        {c.nextPlan.status === 'confirmed' && (
          <Chip tone="ok">{t('confirmedN', { n: c.nextPlan.n ?? 0 })}</Chip>
        )}
        {c.nextPlan.status === 'draft' && <Chip>{t('draft')}</Chip>}
      </Kv>
    </section>
  );
}

function Resources({ c }: { c: ReportContent }) {
  const { t, label, locale } = useI18n();
  const f = c.facts;
  const numeric = ROLE_KEYS.filter((r) => dec(f.people[r]) !== null);
  const roles = ROLE_KEYS.map((r) => (f.people[r] ?? '').trim());
  // A total is complete only when every role is a number or n/a; otherwise say it is partial.
  const partial = ROLE_KEYS.some(
    (r) => dec(f.people[r]) === null && f.people[r] !== 'na',
  );
  const sum = (groups: string[]) =>
    ROLE_KEYS.filter((r) => groups.includes(ROLE_GROUP[r])).reduce(
      (a, r) => a + (dec(f.people[r]) ?? 0n),
      0n,
    );
  const machinery = byKind(c.items, 'machinery');
  const materials = byKind(c.items, 'material');
  const value = (m: ReportItemDto) => (f.materials[m.key] ?? '').trim();
  const blank = materials.filter((m) => value(m) === '').length;
  const unknown = materials.filter((m) => value(m) === 'unknown').length;
  const arrived = materials.filter((m) => (dec(value(m)) ?? 0n) > 0n);
  // "No deliveries" only when every material is an explicit zero or n/a.
  const noneArrived = materials.every(
    (m) => value(m) === 'na' || dec(value(m)) === 0n,
  );
  return (
    <section className="card">
      <h2 className="blk">{t('resources')}</h2>
      <Kv label={t('people')}>
        {numeric.length ? (
          <>
            <b className="num">{decText(sum(['gc', 'sub', 'worker']))}</b>{' '}
            {t('persons')} · {t('mgmtN', { n: decText(sum(['gc', 'sub'])) })} ·{' '}
            {t('installN', { n: decText(sum(['worker'])) })}
            {partial && <span className="miss"> · {t('incomplete')}</span>}
          </>
        ) : roles.every((r) => r === '') ? (
          <span className="miss">{t('notFilled')}</span>
        ) : roles.every((r) => r === 'na') ? (
          t('na')
        ) : (
          <span className="miss">
            {t('unknown')}
            {roles.some((r) => r === '') &&
              ` · ${t('nBlank', { n: roles.filter((r) => r === '').length })}`}
          </span>
        )}
      </Kv>
      {machinery.length > 0 && (
        <Kv label={t('machinery')}>
          {machinery.map((m, i) => (
            <span key={m.key}>
              {i > 0 && ' · '}
              {label(m.label)}{' '}
              {f.machinery[m.key] === '0' ? (
                t('unused')
              ) : (
                <Val raw={f.machinery[m.key]} />
              )}
            </span>
          ))}
        </Kv>
      )}
      {materials.length > 0 && (
        <Kv label={t('materials')}>
          {blank === materials.length ? (
            <span className="miss">{t('notFilled')}</span>
          ) : (
            <>
              {arrived.length > 0 &&
                arrived
                  .map(
                    (m) =>
                      `${label(m.label)} +${fmtNum(value(m), locale)} ${unitOf(label, m)}`,
                  )
                  .join(' · ')}
              {noneArrived && t('noArrival')}
              {unknown > 0 && (
                <span className="miss">
                  {arrived.length ? ' · ' : ''}
                  {t('unknown')} {unknown}
                </span>
              )}
              {blank > 0 && (
                <span className="miss">
                  {arrived.length || unknown ? ' · ' : ''}
                  {t('nBlank', { n: blank })}
                </span>
              )}
            </>
          )}
        </Kv>
      )}
    </section>
  );
}

function Issues({ c }: { c: ReportContent }) {
  const { t } = useI18n();
  const n = c.facts.narrative;
  return (
    <section className="card">
      <h2 className="blk">{t('issues')}</h2>
      <Kv label={t('quality')}>
        {n.quality.trim() || <span className="miss">{t('notFilled')}</span>}
      </Kv>
      <Kv label={t('safety')}>
        {n.safety.trim() || <span className="miss">{t('notFilled')}</span>}
      </Kv>
    </section>
  );
}

function Details({ c }: { c: ReportContent }) {
  const { t, label, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const f = c.facts;
  return (
    <>
      <button
        type="button"
        className="linkrow"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="grow">{t('allDetails')}</span>
        {open ? <Icon.down /> : <Icon.right />}
      </button>
      {open && (
        <section className="card details">
          <h3>{t('progress')}</h3>
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('today')}</th>
                <th>{t('cumulative')}</th>
                <th>{t('design')}</th>
              </tr>
            </thead>
            <tbody>
              {byKind(c.items, 'work').map((it) => (
                <tr key={it.key}>
                  <td>{label(it.label)}</td>
                  <td>
                    <Val raw={f.qty[it.key]} />
                  </td>
                  <td>
                    {f.cumulative[it.key]
                      ? fmtNum(f.cumulative[it.key], locale)
                      : '—'}
                  </td>
                  <td>
                    {fmtNum(it.designQty, locale)} {unitOf(label, it)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{t('materials')}</h3>
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('today')}</th>
                <th>{t('cumulative')}</th>
                <th>{t('design')}</th>
              </tr>
            </thead>
            <tbody>
              {byKind(c.items, 'material').map((m) => {
                const total = c.materialsCumulative[m.key];
                return (
                  <tr key={m.key}>
                    <td>{label(m.label)}</td>
                    <td>
                      <Val raw={f.materials[m.key]} />
                    </td>
                    <td>
                      {total?.value ? fmtNum(total.value, locale) : '—'}
                      {total && !total.complete && (
                        <span className="miss"> · {t('incomplete')}</span>
                      )}
                    </td>
                    <td>
                      {fmtNum(m.designQty, locale)} {unitOf(label, m)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function ReportBody({
  c,
  version,
  timeZone,
}: {
  c: ReportContent;
  version: RevisionMeta | null;
  timeZone: string;
}) {
  const { t, locale, label } = useI18n();
  const f = c.facts;
  const weather = [f.weather, f.temperature].filter(Boolean).join(' · ');
  return (
    <>
      {(version || weather) && (
        <div className="status-row">
          {version && (
            <Chip tone="ok">
              {t('submittedAt', { t: fmtTime(version.at, locale, timeZone) })}
            </Chip>
          )}
          {version && version.n > 1 && (
            <Chip tone="warn">{t('corrected', { n: version.n })}</Chip>
          )}
          {weather && <span className="muted">{weather}</span>}
        </div>
      )}
      <div className="rgrid">
        <div className="rcol">
          {f.noWork ? (
            <section className="card">
              <h2 className="blk">{t('progress')}</h2>
              <p className="big">{t('noWork')}</p>
              <p>
                {label(`nw_${f.noWork.reason}`)}
                {f.noWork.note ? ` · ${f.noWork.note}` : ''}
              </p>
            </section>
          ) : (
            <Progress c={c} />
          )}
        </div>
        <div className="rcol">
          {!f.noWork && <Resources c={c} />}
          <Issues c={c} />
        </div>
      </div>
      <Details c={c} />
    </>
  );
}

/** The report tab: frozen revision when submitted, live content otherwise. */
export function ReportView({
  day,
  read,
  canWrite,
  missing,
  onFill,
  onNoWork,
}: {
  day: DayView;
  read: ReportContent;
  canWrite: boolean;
  missing: number;
  onFill: () => void;
  onNoWork: () => void;
}) {
  const { t } = useI18n();
  if (day.state === 'submitted')
    return (
      <ReportBody
        c={read}
        version={day.revisions.at(-1) ?? null}
        timeZone={day.siteTimezone}
      />
    );
  // Readers see a day once it is submitted; a draft being written is not a report yet.
  if (!canWrite)
    return (
      <section className="card empty">
        <h2>{t('notSubmitted')}</h2>
      </section>
    );
  if (day.state === 'empty')
    return (
      <section className="card empty">
        <h2>{t('noRecord')}</h2>
        {canWrite && (
          <div className="row2">
            <button type="button" className="primary" onClick={onFill}>
              {t('startFill')}
            </button>
            <button type="button" className="ghost" onClick={onNoWork}>
              {t('noWork')}
            </button>
          </div>
        )}
      </section>
    );
  return (
    <>
      {canWrite && (
        <section className="card due">
          {day.state === 'correcting' ? (
            <>
              <div className="due-row">
                <Chip tone="warn">{t('correcting')}</Chip>
                <span className="muted">{day.correctionReason}</span>
              </div>
              <button type="button" className="primary wide" onClick={onFill}>
                {t('continueCorrect')}
              </button>
            </>
          ) : (
            <>
              <div className="due-row">
                <strong>{t('tonightDue', { n: missing })}</strong>
              </div>
              <div className="row2">
                <button type="button" className="primary" onClick={onFill}>
                  {t('continueFill')}
                </button>
                <button type="button" className="ghost" onClick={onNoWork}>
                  {t('noWork')}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <ReportBody c={read} version={null} timeZone={day.siteTimezone} />
    </>
  );
}
