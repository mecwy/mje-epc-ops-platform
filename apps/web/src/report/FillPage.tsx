import { useEffect, useState } from 'react';
import type { ReportItemDto } from '@mje/contracts';
import { ROLE_KEYS, dec, decText, type Coverage } from '@mje/domain/rules';
import type { DayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { NumInput, TokenChips } from '../ui.js';
import type { MessageKey } from '@mje/ui';
import { fmtNum, fmtShort } from './format.js';
import { CheckInsBeside } from './CheckInsBeside.js';
import { ForemanLine } from './ForemanLine.js';
import {
  activeWork,
  byKind,
  cumulativeChecks,
  cumulativeSuggestion,
  target,
} from './model.js';
import type { DayHandle, SaveState } from './useDay.js';
import { FillIssues } from './Issues.js';
import type { IssuesHandle } from './useIssues.js';
import { PhotoLine, PhotosCard, UnlinkedReminder } from './Photos.js';
import type { PhotosHandle } from './usePhotos.js';

const ROLE_LABEL = {
  manager: 'role_manager',
  safetyOfficer: 'role_safetyOfficer',
  supervisor: 'role_supervisor',
  subManager: 'role_subManager',
  installer: 'role_installer',
} as const satisfies Record<(typeof ROLE_KEYS)[number], MessageKey>;

export function SaveBadge({ save }: { save: SaveState }) {
  const { t } = useI18n();
  if (save === 'idle') return null;
  const text =
    save === 'saving'
      ? t('saving')
      : save === 'saved'
        ? t('saved')
        : save === 'invalid'
          ? t('numberInvalid')
          : t('saveFail');
  return (
    <span
      className={`saved${save === 'failed' || save === 'invalid' ? ' bad' : ''}`}
      role="status"
    >
      {text}
    </span>
  );
}

function QtyRow({
  it,
  h,
  day,
  locked,
  compact,
}: {
  it: ReportItemDto;
  h: DayHandle;
  day: DayView;
  locked: boolean;
  compact?: boolean | undefined;
}) {
  const { t, label, locale } = useI18n();
  const f = h.facts!;
  const b = target(day, it.key);
  const q = f.qty[it.key];
  const sug = cumulativeSuggestion(day.cumulativeBase[it.key], q);
  const cur = f.cumulative[it.key];
  const unit = it.unit ? label(`u_${it.unit}`).replace(/^u_/, '') : '';
  return (
    <div className="qrow">
      <div className="qline">
        <label htmlFor={`q-${it.key}`} className="grow">
          <span className="qname">{label(it.label)}</span>
          {b && (
            <span className="muted small">
              {t('baselineN', { n: fmtNum(b, locale) })}
            </span>
          )}
        </label>
        <NumInput
          id={`q-${it.key}`}
          value={q}
          disabled={locked}
          onChange={(v) => h.edit(`qty.${it.key}`, v)}
        />
        <span className="unit">{unit}</span>
      </div>
      <TokenChips
        value={q}
        disabled={locked}
        onSet={(v) => h.edit(`qty.${it.key}`, v)}
      />
      <ForemanLine itemKey={it.key} />
      {!compact && (dec(q) !== null || cur) && (
        <>
          {/* The declared cumulative is always visible and editable; the suggestion sits apart. */}
          <label className="calc">
            <span className="grow">{t('cumulative')}</span>
            <NumInput
              id={`c-${it.key}`}
              size="cum"
              value={cur}
              disabled={locked}
              label={t('cumulative')}
              onChange={(v) => h.edit(`cumulative.${it.key}`, v)}
            />
            {sug && cur === sug.sum && (
              <span className="ok-t">
                <Icon.check />
              </span>
            )}
          </label>
          {dec(q) !== null && dec(cur) !== null && dec(cur)! < dec(q)! && (
            <p className="warn-t small">{t('cumBelowToday')}</p>
          )}
          {sug && cur !== sug.sum && (
            <div className="calc">
              <span className="grow">
                {fmtNum(sug.base, locale)} + {fmtNum(sug.qty, locale)} ={' '}
                <b className="num">{fmtNum(sug.sum, locale)}</b>
                <span className="muted small">
                  {' '}
                  · {t('asOf', { d: fmtShort(sug.asOf, locale) })}
                </span>
              </span>
              {!locked && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => h.edit(`cumulative.${it.key}`, sug.sum)}
                >
                  {t('adopt')}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {!compact && (
        <PhotoLine
          link={{ type: 'item', id: it.key }}
          buttonId={`ph-${it.key}`}
        />
      )}
    </div>
  );
}

export function WorkRows({
  h,
  day,
  locked,
  compact,
}: {
  h: DayHandle;
  day: DayView;
  locked: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [showOthers, setShowOthers] = useState(false);
  const { active, others } = activeWork({ ...day, facts: h.facts! });
  if (!active.length && !others.length)
    return <p className="muted">{t('noItems')}</p>;
  return (
    <>
      {active.map((it) => (
        <QtyRow
          key={it.key}
          it={it}
          h={h}
          day={day}
          locked={locked}
          compact={compact}
        />
      ))}
      {others.length > 0 && (
        <button
          type="button"
          className="linkrow"
          aria-expanded={showOthers}
          onClick={() => setShowOthers(!showOthers)}
        >
          <span className="grow">{t('othersNoQty', { n: others.length })}</span>
          {showOthers ? <Icon.down /> : <Icon.right />}
        </button>
      )}
      {showOthers &&
        others.map((it) => (
          <QtyRow
            key={it.key}
            it={it}
            h={h}
            day={day}
            locked={locked}
            compact={compact}
          />
        ))}
    </>
  );
}

/** Missing items with one-tap fixes. Missing never blocks; only invalid numbers do. */
export function CheckList({
  cov,
  h,
  day,
  onFocus,
  onSubmit,
  busy,
  panel,
}: {
  cov: Coverage;
  h: DayHandle;
  day: DayView;
  onFocus: (id: string) => void;
  onSubmit: () => void;
  busy: boolean;
  panel?: boolean;
}) {
  const { t, label, locale } = useI18n();
  const items = day.items;
  const name = (key?: string) => {
    const it = items.find((i) => i.kind === 'work' && i.key === key);
    return it ? label(it.label) : (key ?? '');
  };
  const correcting = day.state === 'correcting';
  const rows = cov.missing.map((m, i) => {
    const go = (id: string) => (
      <button type="button" className="ghost small" onClick={() => onFocus(id)}>
        {t('fill')}
      </button>
    );
    const set = (path: string, v: string, text: string) => (
      <button type="button" className="pill" onClick={() => h.edit(path, v)}>
        {text}
      </button>
    );
    let text = '';
    let actions = null;
    if (m.key === 'weather') [text, actions] = [t('weather'), go('f-weather')];
    else if (m.key === 'qty')
      [text, actions] = [
        `${name(m.item)} · ${t('today')}`,
        <>
          {go(`q-${m.item}`)}
          {set(`qty.${m.item}`, 'unknown', t('markUnknown'))}
        </>,
      ];
    else if (m.key === 'cumulative') {
      const s = cumulativeSuggestion(
        day.cumulativeBase[m.item!],
        h.facts!.qty[m.item!],
      );
      [text, actions] = [
        `${name(m.item)} · ${t('cumulative')}`,
        s ? (
          set(
            `cumulative.${m.item}`,
            s.sum,
            t('adoptN', { n: fmtNum(s.sum, locale) }),
          )
        ) : (
          <>
            {go(`c-${m.item}`)}
            {set(`cumulative.${m.item}`, 'unknown', t('markUnknown'))}
          </>
        ),
      ];
    } else if (m.key === 'construction')
      [text, actions] = [t('construction'), go('f-construction')];
    else if (m.key === 'photo')
      // A reminder only (rule 5): it never blocks, and nothing marks it done but a photo.
      [text, actions] = [
        `${name(m.item)} · ${t('photos')}`,
        <button
          type="button"
          className="ghost small"
          onClick={() => onFocus(`ph-${m.item}`)}
        >
          {t('takePhoto')}
        </button>,
      ];
    else if (m.key === 'quality' || m.key === 'safety')
      [text, actions] = [
        t(m.key),
        <>
          {go(`f-${m.key}`)}
          {set(`narrative.${m.key}`, t('noCheckFound'), t('noCheckFound'))}
        </>,
      ];
    else if (m.key === 'people')
      [text, actions] = [t('people'), go('p-manager')];
    else if (m.key === 'machinery')
      [text, actions] = [
        t('machineryN', { n: m.n ?? 0 }),
        <button
          type="button"
          className="pill"
          onClick={() =>
            byKind(items, 'machinery').forEach(
              (x) =>
                !h.facts!.machinery[x.key] &&
                h.edit(`machinery.${x.key}`, 'unknown'),
            )
          }
        >
          {t('markUnknown')}
        </button>,
      ];
    else if (m.key === 'materials')
      [text, actions] = [
        t('materialsN', { n: m.n ?? 0 }),
        <>
          <button
            type="button"
            className="pill"
            onClick={() =>
              byKind(items, 'material').forEach(
                (x) =>
                  !h.facts!.materials[x.key] &&
                  h.edit(`materials.${x.key}`, '0'),
              )
            }
          >
            {t('noArrival')}
          </button>
          <button
            type="button"
            className="pill"
            onClick={() =>
              byKind(items, 'material').forEach(
                (x) =>
                  !h.facts!.materials[x.key] &&
                  h.edit(`materials.${x.key}`, 'unknown'),
              )
            }
          >
            {t('markUnknown')}
          </button>
        </>,
      ];
    return (
      <div className="crow" key={`${m.key}:${m.item ?? i}`}>
        <span className="grow">{text}</span>
        <span className="chips">{actions}</span>
      </div>
    );
  });
  // Cumulatives that disagree with today's quantity: reminders, never a block.
  const checks = cumulativeChecks(
    { items, facts: h.facts! },
    day.cumulativeBase,
  );
  const checkRows = checks.map((c) => (
    <div className="crow" key={`check:${c.item}`}>
      <span className="grow">
        {name(c.item)} ·{' '}
        {c.kind === 'belowToday'
          ? t('cumBelowToday')
          : t('cumNotSuggested', { n: fmtNum(c.sum, locale) })}
      </span>
      <span className="chips">
        {c.kind === 'notSuggested' ? (
          <button
            type="button"
            className="pill"
            onClick={() => h.edit(`cumulative.${c.item}`, c.sum)}
          >
            {t('adoptN', { n: fmtNum(c.sum, locale) })}
          </button>
        ) : (
          <button
            type="button"
            className="ghost small"
            onClick={() => onFocus(`c-${c.item}`)}
          >
            {t('fill')}
          </button>
        )}
      </span>
    </div>
  ));
  return (
    <section className="card">
      <h2 className={`blk${rows.length ? ' warn-t' : ''}`}>
        {rows.length ? t('missingN', { n: rows.length }) : t('allFilled')}
      </h2>
      {checkRows.length > 0 && (
        <>
          <h3 className="warn-t">{t('reviewN', { n: checkRows.length })}</h3>
          <fieldset className="bare" disabled={busy}>
            {checkRows}
          </fieldset>
        </>
      )}
      {cov.invalid.length > 0 && (
        <div className="banner err">{t('numberInvalid')}</div>
      )}
      {/* While an action runs every fix is disabled; the hook also refuses edits then. */}
      <fieldset className="bare" disabled={busy}>
        {rows}
      </fieldset>
      <UnlinkedReminder />
      {panel && (
        <button
          type="button"
          className="primary wide"
          disabled={busy || cov.invalid.length > 0}
          onClick={onSubmit}
        >
          {correcting ? t('submitCorrect') : t('submitReport')}
        </button>
      )}
    </section>
  );
}

export function FillPage({
  h,
  day,
  cov,
  focus,
  onFocused,
  onBack,
  onCheck,
  onPlan,
  onSubmit,
  busy,
  tomorrowText,
  issues,
  canWrite,
}: {
  h: DayHandle;
  day: DayView;
  cov: Coverage;
  focus: string | null;
  onFocused: () => void;
  onBack: () => void;
  onCheck: () => void;
  onPlan: () => void;
  onSubmit: () => void;
  busy: boolean;
  tomorrowText: string;
  issues: IssuesHandle;
  canWrite: boolean;
}) {
  const { t, label, locale } = useI18n();
  const [mm, setMm] = useState(false);
  const f = h.facts!;
  const locked = day.state === 'submitted' || busy;
  useEffect(() => {
    if (!focus) return;
    if (focus.startsWith('m-')) setMm(true);
    const el = document.getElementById(focus);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      (el as HTMLInputElement).focus();
      onFocused();
    }
  }, [focus, onFocused, mm]);
  const any = ROLE_KEYS.some((r) => dec(f.people[r]) !== null);
  const total = ROLE_KEYS.reduce((a, r) => a + (dec(f.people[r]) ?? 0n), 0n);
  const narrative = (k: 'quality' | 'safety') => (
    <>
      <label className="field">
        <span>{t(k)}</span>
        <textarea
          id={`f-${k}`}
          rows={2}
          value={f.narrative[k]}
          disabled={locked}
          onChange={(e) => h.edit(`narrative.${k}`, e.target.value)}
        />
      </label>
      {!f.narrative[k].trim() && !locked && (
        <div className="chips">
          <button
            type="button"
            className="pill"
            onClick={() => h.edit(`narrative.${k}`, t('noCheckFound'))}
          >
            {t('noCheckFound')}
          </button>
        </div>
      )}
    </>
  );
  return (
    <>
      <header className="bar task">
        <button
          type="button"
          className="icon"
          aria-label={t('back')}
          onClick={onBack}
        >
          <Icon.back />
        </button>
        <span className="bar-h">
          {t('reportOf', { d: fmtShort(day.businessDate, locale) })}
        </span>
        <SaveBadge save={h.save} />
      </header>
      <main className="page task-page">
        <div className="fwrap">
          <div className="fmain">
            {day.state === 'correcting' && (
              <div className="banner warn">
                {t('correctingBanner', {
                  a: day.currentRevisionNumber,
                  b: day.currentRevisionNumber + 1,
                })}{' '}
                · {day.correctionReason}
              </div>
            )}
            {f.noWork && (
              <div className="banner warn">
                <span>
                  {t('noWork')}
                  {f.noWork.note ? ` · ${f.noWork.note}` : ''}
                </span>{' '}
                {!locked && (
                  <button
                    type="button"
                    className="pill"
                    onClick={() => h.edit('noWork', null)}
                  >
                    {t('clear')}
                  </button>
                )}
              </div>
            )}
            <div className="fgrid">
              <div className="fcol">
                <section className="card">
                  <div className="row2">
                    <label className="field">
                      <span>{t('weather')}</span>
                      <input
                        id="f-weather"
                        value={f.weather}
                        disabled={locked}
                        onChange={(e) => h.edit('weather', e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>{t('temperature')}</span>
                      <input
                        value={f.temperature}
                        disabled={locked}
                        onChange={(e) => h.edit('temperature', e.target.value)}
                      />
                    </label>
                  </div>
                </section>
                <section className="card">
                  <h2 className="blk">{t('progress')}</h2>
                  <WorkRows h={h} day={day} locked={locked} />
                  <label className="field">
                    <span>{t('construction')}</span>
                    <textarea
                      id="f-construction"
                      rows={3}
                      value={f.narrative.construction}
                      disabled={locked}
                      onChange={(e) =>
                        h.edit('narrative.construction', e.target.value)
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="rowbtn inset"
                    onClick={onPlan}
                  >
                    <span className="grow">
                      <b>{t('tomorrowPlan')}</b>
                      <span className="muted small">{tomorrowText}</span>
                    </span>
                    <Icon.right />
                  </button>
                </section>
              </div>
              <div className="fcol">
                <section className="card">
                  <div className="blk-row">
                    <h2 className="blk">{t('resources')}</h2>
                    <span className="small">
                      {t('peopleTotal')}{' '}
                      <b className="num">{any ? decText(total) : '—'}</b>{' '}
                      <CheckInsBeside />
                    </span>
                  </div>
                  <div className="grid2">
                    {ROLE_KEYS.map((r) => {
                      const roleLabel = ROLE_LABEL[r];
                      return (
                        <label className="mini" key={r}>
                          <span>{t(roleLabel)}</span>
                          <NumInput
                            id={`p-${r}`}
                            size="sm"
                            value={f.people[r]}
                            disabled={locked}
                            onChange={(v) => h.edit(`people.${r}`, v)}
                          />
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    className="rowbtn inset"
                    aria-expanded={mm}
                    onClick={() => setMm(!mm)}
                  >
                    <span className="grow">
                      <b>{t('machineryMaterials')}</b>
                    </span>
                    {mm ? <Icon.down /> : <Icon.right />}
                  </button>
                  {mm && (
                    <div className="sub">
                      {byKind(day.items, 'machinery').map((m) => (
                        <div className="qline" key={`m-${m.key}`}>
                          <label htmlFor={`m-${m.key}`} className="grow">
                            <span className="qname">{label(m.label)}</span>
                          </label>
                          <NumInput
                            id={`m-${m.key}`}
                            size="sm"
                            value={f.machinery[m.key]}
                            disabled={locked}
                            onChange={(v) => h.edit(`machinery.${m.key}`, v)}
                          />
                        </div>
                      ))}
                      {byKind(day.items, 'material').map((m) => {
                        const total = day.materialsCumulative[m.key];
                        return (
                          <div className="qline" key={`mat-${m.key}`}>
                            <label htmlFor={`mat-${m.key}`} className="grow">
                              <span className="qname">{label(m.label)}</span>
                              <span className="muted small">
                                {t('cumulative')}{' '}
                                {total?.value
                                  ? fmtNum(total.value, locale)
                                  : '—'}
                                {m.designQty
                                  ? ` / ${fmtNum(m.designQty, locale)}`
                                  : ''}
                                {total && !total.complete
                                  ? ` · ${t('incomplete')}`
                                  : ''}
                              </span>
                            </label>
                            <NumInput
                              id={`mat-${m.key}`}
                              size="sm"
                              value={f.materials[m.key]}
                              disabled={locked}
                              onChange={(v) => h.edit(`materials.${m.key}`, v)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
                <section className="card">
                  <FillIssues
                    handle={issues}
                    items={day.items}
                    canWrite={canWrite}
                  />
                  {narrative('quality')}
                  {narrative('safety')}
                </section>
                <PhotosCard />
              </div>
            </div>
          </div>
          <aside className="checkpanel">
            <CheckList
              cov={cov}
              h={h}
              day={day}
              busy={busy}
              panel
              onSubmit={onSubmit}
              onFocus={(id) => document.getElementById(id)?.focus()}
            />
          </aside>
        </div>
      </main>
      <div className="foot fill-foot">
        <button type="button" className="primary wide" onClick={onCheck}>
          {day.state === 'correcting' ? t('checkCorrect') : t('checkSubmit')}
        </button>
      </div>
    </>
  );
}

export function CheckPage({
  h,
  day,
  cov,
  onBack,
  onFocus,
  onSubmit,
  busy,
  photos,
}: {
  h: DayHandle;
  day: DayView;
  cov: Coverage;
  onBack: () => void;
  onFocus: (id: string) => void;
  onSubmit: () => void;
  busy: boolean;
  photos: PhotosHandle;
}) {
  const { t, locale } = useI18n();
  const f = h.facts!;
  const withQty = byKind(day.items, 'work').filter(
    (i) => dec(f.qty[i.key]) !== null,
  ).length;
  return (
    <>
      <header className="bar task">
        <button
          type="button"
          className="icon"
          aria-label={t('back')}
          onClick={onBack}
        >
          <Icon.back />
        </button>
        <span className="bar-h">
          {t('checkTitle', { d: fmtShort(day.businessDate, locale) })}
        </span>
        <SaveBadge save={h.save} />
      </header>
      <main className="page">
        <CheckList
          cov={cov}
          h={h}
          day={day}
          busy={busy}
          onSubmit={onSubmit}
          onFocus={onFocus}
        />
        <section className="card">
          <div className="crow">
            <Icon.check />
            <span className="grow">{t('progress')}</span>
            <span className="muted">{t('itemsWithQty', { n: withQty })}</span>
          </div>
          {photos.photos && (
            <div className="crow">
              <Icon.camera />
              <span className="grow">{t('photos')}</span>
              <span className="muted">
                {/* Counted only from a complete list (PhotoSession.counts). */}
                {photos.counts ? photos.counts.total : ''}
                {photos.unlinked
                  ? ` · ${t('unlinkedN', { n: photos.unlinked })}`
                  : ''}
              </span>
            </div>
          )}
        </section>
      </main>
      <div className="foot row2">
        <button type="button" className="ghost" onClick={onBack}>
          {t('continueFill')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || cov.invalid.length > 0}
          onClick={onSubmit}
        >
          {day.state === 'correcting' ? t('submitCorrect') : t('submitReport')}
        </button>
      </div>
    </>
  );
}
