import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ReportItemDto } from '@mje/contracts';
import { ROLE_KEYS, dec, decText, type Coverage } from '@mje/domain/rules';
import type { DayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { NumInput, TokenChips } from '../ui.js';
import { outcomeKey, UNKNOWN_OUTCOME } from '../field/errors.js';
import { CHECKED_NO_ISSUES, narrativeText, type MessageKey } from '@mje/ui';
import { fmtNum, fmtShort } from './format.js';
import { CheckInsBeside, PmFieldContext } from './CheckInsBeside.js';
import { ReviewFacts } from './ReviewFacts.js';
import { ForemanLine } from './ForemanLine.js';
import {
  activeWork,
  byKind,
  cumulativeChecks,
  cumulativeSuggestion,
  target,
} from './model.js';
import type { DayHandle, SaveState } from './useDay.js';
import { leaf } from './draft.js';
import { FillIssues } from './Issues.js';
import type { IssuesHandle } from './useIssues.js';
import { PhotoLine, PhotosCard, UnlinkedReminder } from './Photos.js';
import type { PhotosHandle } from './usePhotos.js';
import {
  QuantityEntrySheet,
  type QuantityEntryHandle,
} from './QuantityEntrySheet.js';

const ROLE_LABEL = {
  manager: 'role_manager',
  safetyOfficer: 'role_safetyOfficer',
  supervisor: 'role_supervisor',
  subManager: 'role_subManager',
  installer: 'role_installer',
} as const satisfies Record<(typeof ROLE_KEYS)[number], MessageKey>;

/** Notice for a day action after its mandatory fresh read; it has no owned Retry button. */
export function dayCommandNotice(code: string, uncertain: boolean): MessageKey {
  const key = outcomeKey(code, { write: true, uncertain });
  // DayStore has already attempted a fresh read. Unlike owned field commands this surface
  // cannot promise an unchanged Retry; ask the user to inspect the authoritative readback.
  return Object.values(UNKNOWN_OUTCOME).some((value) => value === key)
    ? 'dayCommandCheckLatest'
    : key;
}

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

/**
 * Inputs a conflict reload set aside (another person saved this day first): each is shown
 * beside the value the day holds now, and only the user's "fill in again" writes it back.
 */
function RetainedCard({
  h,
  day,
  locked,
}: {
  h: DayHandle;
  day: DayView;
  locked: boolean;
}) {
  const { t, label, lang } = useI18n();
  const f = h.facts;
  if (h.retained.length === 0 || !f) return null;
  // A narrative preset is stored as its code; show its text, as the editor does.
  const show = (path: string, v: string | undefined) => {
    if (v === undefined || v === '') return t('emptyValue');
    if (path.startsWith('narrative.')) return narrativeText(v, lang);
    if (v === 'unknown') return t('unknown');
    if (v === 'na') return t('na');
    if (path.startsWith('presence.')) {
      if (v === 'present') return t('present');
      if (v === 'absent') return t('absent');
    }
    return v;
  };
  const name = (path: string) => {
    const [head, key = ''] = path.split('.');
    const item = day.items.find((i) => i.key === key);
    const itemName = item ? label(item.label) : key;
    switch (head) {
      case 'qty':
        return `${itemName} · ${t('today')}`;
      case 'cumulative':
        return `${itemName} · ${t('cumulative')}`;
      case 'machinery':
      case 'materials':
        return itemName;
      case 'people': {
        if (!(key in ROLE_LABEL)) return key;
        const roleLabel = ROLE_LABEL[key as keyof typeof ROLE_LABEL];
        return t(roleLabel);
      }
      case 'narrative':
        return key === 'construction' || key === 'quality' || key === 'safety'
          ? t(key)
          : key;
      case 'presence':
        return `${t('presence')} · ${key}`;
      case 'weather':
      case 'temperature':
        return t(head);
      default:
        return path;
    }
  };
  return (
    <div className="banner warn retained" role="status">
      <b>{t('retainedTitle')}</b>
      {h.retained.map((r) => (
        <div className="qline" key={r.path}>
          <span className="grow small">
            <b>{name(r.path)}</b>{' '}
            {t('retainedLine', {
              mine: show(r.path, r.mine),
              now: show(r.path, leaf(f, r.path)),
            })}
          </span>
          <button
            type="button"
            className="pill"
            disabled={locked}
            onClick={() => h.refill(r.path)}
          >
            {t('refill')}
          </button>
          <button
            type="button"
            className="pill"
            onClick={() => h.dismiss(r.path)}
          >
            {t('dismissRetained')}
          </button>
        </div>
      ))}
    </div>
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
  const quantityEntry = useRef<QuantityEntryHandle>(null);
  const f = h.facts!;
  const b = target(day, it.key);
  const q = f.qty[it.key];
  const sug = cumulativeSuggestion(day.cumulativeBase[it.key], q);
  const cur = f.cumulative[it.key];
  const unit = it.unit ? label(`u_${it.unit}`).replace(/^u_/, '') : '';
  return (
    <div className="qrow">
      <div className="qline">
        <div className="grow">
          {locked ? (
            <div className="fill-quantity-trigger">
              <span className="qname">{label(it.label)}</span>
              {b && (
                <span className="muted small">
                  {t('baselineN', { n: fmtNum(b, locale) })}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="fill-quantity-trigger"
              onClick={() => quantityEntry.current?.open()}
            >
              <span className="qname">{label(it.label)}</span>
              {b && (
                <span className="muted small">
                  {t('baselineN', { n: fmtNum(b, locale) })}
                </span>
              )}
            </button>
          )}
        </div>
        <NumInput
          id={`q-${it.key}`}
          label={label(it.label)}
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
      <QuantityEntrySheet
        ref={quantityEntry}
        scope={JSON.stringify([
          day.projectId,
          day.businessDate,
          it.key,
          it.unit ?? null,
        ])}
        title={label(it.label)}
        unit={unit}
        value={q}
        locked={locked}
        onConfirm={(value) => h.edit(`qty.${it.key}`, value)}
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

/** Entry visibility only; never copies a crew claim into the manager's facts. */
export function entryWork(
  content: Parameters<typeof activeWork>[0],
  foreman: import('../api.js').ForemanDayView | null,
) {
  const { active, others } = activeWork(content);
  const expected = others.filter((item) =>
    Object.values(foreman?.items[item.key]?.crews ?? {}).some(
      (crew) => crew.expected,
    ),
  );
  return {
    active: [...active, ...expected],
    others: others.filter((item) => !expected.includes(item)),
  };
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
  const pm = useContext(PmFieldContext);
  const { active, others } = entryWork(
    { ...day, facts: h.facts! },
    pm?.foreman ?? null,
  );
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
          {set(`narrative.${m.key}`, CHECKED_NO_ISSUES, t('noCheckFound'))}
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

const FILL_SECTIONS = ['progress', 'materials', 'people', 'machinery'] as const;
type FillSection = (typeof FILL_SECTIONS)[number];
/** Reveal the existing input's section before focusing; never creates another editor/session. */
export function fillSectionForFocus(id: string): FillSection | null {
  if (id.startsWith('mat-')) return 'materials';
  if (id.startsWith('m-')) return 'machinery';
  if (id.startsWith('p-')) return 'people';
  if (
    id.startsWith('q-') ||
    id.startsWith('c-') ||
    id.startsWith('ph-') ||
    id === 'f-construction'
  )
    return 'progress';
  return null;
}

/** One request spans reveal + focus commits, then ends even if its control is absent. */
export function resolveFillFocus(
  id: string,
  section: FillSection,
  ports: {
    reveal: (section: FillSection) => void;
    find: (id: string) => Pick<HTMLElement, 'scrollIntoView' | 'focus'> | null;
    resolved: () => void;
  },
) {
  const target = fillSectionForFocus(id);
  if (target !== null && target !== section) {
    ports.reveal(target);
    return;
  }
  const el = ports.find(id);
  el?.scrollIntoView({ block: 'center' });
  el?.focus();
  ports.resolved();
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
  weatherControls,
  weatherControlsPending,
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
  weatherControls?: ReactNode;
  weatherControlsPending?: boolean;
}) {
  const { t, label, locale, lang } = useI18n();
  const [section, setSection] = useState<FillSection>('progress');
  const [locationControlsOpen, setLocationControlsOpen] = useState(false);
  const [requestedFocus, setRequestedFocus] = useState<string | null>(null);
  const f = h.facts!;
  const locked = day.state === 'submitted' || busy || !canWrite;
  useEffect(() => {
    const id = requestedFocus ?? focus;
    if (!id) return;
    resolveFillFocus(id, section, {
      reveal: setSection,
      find: (targetId) => document.getElementById(targetId),
      resolved: () => {
        setRequestedFocus(null);
        if (focus) onFocused();
      },
    });
  }, [focus, requestedFocus, section, onFocused]);
  const any = ROLE_KEYS.some((r) => dec(f.people[r]) !== null);
  const total = ROLE_KEYS.reduce((a, r) => a + (dec(f.people[r]) ?? 0n), 0n);
  const narrative = (k: 'quality' | 'safety') => (
    <>
      <label className="field">
        <span>{t(k)}</span>
        <textarea
          id={`f-${k}`}
          rows={2}
          value={narrativeText(f.narrative[k], lang)}
          disabled={locked}
          onChange={(e) => h.edit(`narrative.${k}`, e.target.value)}
        />
      </label>
      {!f.narrative[k].trim() && !locked && (
        <div className="chips">
          <button
            type="button"
            className="pill"
            onClick={() => h.edit(`narrative.${k}`, CHECKED_NO_ISSUES)}
          >
            {t('noCheckFound')}
          </button>
        </div>
      )}
    </>
  );
  return (
    <div className="entry-workspace entry-manager fill-workbench">
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
        <button
          type="button"
          className="ghost fill-save"
          disabled={locked}
          onClick={() => void h.flush()}
        >
          {t('fillSaveDraft')}
        </button>
        <button
          type="button"
          className="primary fill-preview"
          disabled={busy}
          onClick={onCheck}
        >
          {t('fillPreview')}
        </button>
      </header>
      <main className="page task-page">
        <div className="fwrap">
          <div className="fmain">
            <RetainedCard h={h} day={day} locked={locked} />
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
            <section
              className="card fill-day-status"
              aria-label={t('fillDayStatus')}
            >
              <div>
                <span className="report-eyebrow">{t('fillDayStatus')}</span>
                <h2>
                  {day.state === 'correcting'
                    ? t('correcting')
                    : day.state === 'submitted'
                      ? t('submittedLocked')
                      : t('draft')}
                </h2>
              </div>
              <strong className={cov.missing.length ? 'warn-t' : ''}>
                {cov.missing.length
                  ? t('missingN', { n: cov.missing.length })
                  : t('allFilled')}
              </strong>
            </section>
            <div className="fill-business">
              <section className="card fill-manual-weather">
                <h2 className="blk">{t('weather')}</h2>
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
                {weatherControls && (
                  <details
                    className="fill-guidance"
                    open={weatherControlsPending || locationControlsOpen}
                  >
                    <summary
                      onClick={(event) => {
                        event.preventDefault();
                        if (!weatherControlsPending)
                          setLocationControlsOpen((open) => !open);
                      }}
                    >
                      {t('weatherLocation_position')}
                    </summary>
                    {weatherControls}
                  </details>
                )}
              </section>
              <section className="card fill-sections">
                <div
                  className="report-section-tabs fill-section-tabs"
                  role="group"
                  aria-label={t('fillSections')}
                >
                  {FILL_SECTIONS.map((key) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={section === key}
                      onClick={() => setSection(key)}
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
                <section
                  hidden={section !== 'progress'}
                  className="fill-section"
                  aria-label={t('progress')}
                >
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
                <section
                  hidden={section !== 'people'}
                  className="fill-section"
                  aria-label={t('people')}
                >
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
                </section>
                <section
                  hidden={section !== 'machinery'}
                  className="fill-section"
                  aria-label={t('machinery')}
                >
                  <h2 className="blk">{t('machinery')}</h2>
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
                </section>
                <section
                  hidden={section !== 'materials'}
                  className="fill-section"
                  aria-label={t('materials')}
                >
                  <h2 className="blk">{t('materials')}</h2>
                  {byKind(day.items, 'material').map((m) => {
                    const total = day.materialsCumulative[m.key];
                    return (
                      <div className="qline" key={`mat-${m.key}`}>
                        <label htmlFor={`mat-${m.key}`} className="grow">
                          <span className="qname">{label(m.label)}</span>
                          <span className="muted small">
                            {t('cumulative')}{' '}
                            {total?.value ? fmtNum(total.value, locale) : '—'}
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
                </section>
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
          <aside className="checkpanel">
            <details className="fill-guidance">
              <summary>{t('fillCheckGuidance')}</summary>
              <p className="entry-context">{t('entryCompletenessOnly')}</p>
            </details>
            <CheckList
              cov={cov}
              h={h}
              day={day}
              busy={busy}
              panel
              onSubmit={onSubmit}
              onFocus={setRequestedFocus}
            />
          </aside>
        </div>
      </main>
      <div className="foot fill-foot">
        <button
          type="button"
          className="primary wide"
          disabled={busy}
          onClick={onCheck}
        >
          {day.state === 'correcting' ? t('checkCorrect') : t('checkSubmit')}
        </button>
      </div>
    </div>
  );
}

export function CheckPage({
  projectName,
  h,
  day,
  cov,
  onBack,
  onFocus,
  onSubmit,
  busy,
  photos,
}: {
  projectName: string;
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
  return (
    <div className="entry-workspace entry-manager">
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
        <ReviewFacts
          facts={f}
          items={day.items}
          projectName={projectName}
          roles={ROLE_KEYS.map((key) => {
            const roleLabel = ROLE_LABEL[key];
            return { key, label: t(roleLabel) };
          })}
        />
        <CheckList
          cov={cov}
          h={h}
          day={day}
          busy={busy}
          onSubmit={onSubmit}
          onFocus={onFocus}
        />
        {photos.counts && photos.counts.total > 0 && (
          <section className="card">
            <div className="crow">
              <Icon.camera />
              <span className="grow">{t('photos')}</span>
              <span className="muted">
                {photos.counts.total}
                {photos.unlinked
                  ? ` · ${t('unlinkedN', { n: photos.unlinked })}`
                  : ''}
              </span>
            </div>
          </section>
        )}
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
    </div>
  );
}
