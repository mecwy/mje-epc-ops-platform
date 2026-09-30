import { useEffect, useReducer, useRef, useState } from 'react';
import {
  CHALLENGE_CODE,
  FOREMAN_NOTE_MAX,
  type FieldMeDto,
  type ForemanReportDto,
} from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { NumInput, Sheet, TokenChips } from '../ui.js';
import { fmtDay, fmtNum, fmtStamp, fmtTime } from '../report/format.js';
import { locate } from '../report/geo.js';
import { KindText } from './CheckInCard.js';
import { ErrorText } from './ErrorText.js';
import type { DeviceApi } from './field-api.js';
import {
  checkDraft,
  draftFrom,
  qtyKind,
  reportDays,
  sendReport,
  type Draft,
  type ReportSend,
} from './foreman-report.js';
import { ProxyFlow, type ProxyPhase } from './proxy-flow.js';
import { CrewCommands } from './crew-commands.js';
import { OwnedCommands } from './owned-commands.js';
import { FieldSession } from './session.js';

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
type Member = NonNullable<FieldMeDto['foreman']>['members'][number];

/**
 * The foreman's crew (design §2, §3, C2): confirm or reject a member's pending phone with the
 * code shown on it, and check members in with the foreman's own fix. Only the foreman's
 * current crew is listed; the server re-checks authority on every request.
 */
export function CrewCard({
  api,
  me,
  session,
  onEnded,
}: {
  api: DeviceApi;
  me: FieldMeDto;
  session: FieldSession<FieldMeDto>;
  onEnded: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const tz = me.project.timezone;
  const [flow] = useState(
    () =>
      new ProxyFlow({
        api,
        deviceId: me.device.deviceId,
        timeZone: tz,
        storage: localStore(),
        locate: () => locate(navigator.geolocation),
        now: () => Date.now(),
        newKey: () => crypto.randomUUID(),
        onEnded,
        notify: rerender,
      }),
  );
  const [confirming, setConfirming] = useState<Member | null>(null);
  // Kept with the card (mounted for the page's life): an unresolved decision keeps its key.
  const [commands] = useState(() => new CrewCommands(session, api));
  const crew = me.foreman;
  const unresolvedName = commands.unresolved
    ? (crew?.members.find((m) => m.personId === commands.unresolved?.personId)
        ?.displayName ?? '—')
    : null;
  if (!crew) return null;
  return (
    <section className="card">
      <h2 className="blk">{t('fm_crewTitle', { crew: crew.crewName })}</h2>
      {unresolvedName && !confirming && (
        <div className="banner warn" role="alert">
          {t('fm_unresolvedFor', { name: unresolvedName })}
        </div>
      )}
      {crew.members.length === 0 && (
        <p className="muted small">{t('fm_crewEmpty')}</p>
      )}
      <ul className="plainlist">
        {crew.members.map((m) => {
          const self = m.personId === me.person.id;
          const done = flow.doneFor(m.personId);
          const mine = flow.person === m.personId;
          return (
            <li key={m.personId} className="devrow">
              <span className="grow">
                <b>{m.displayName}</b>
                <span className="muted small">
                  {m.pendingDevices > 0
                    ? t('fm_phonesWaiting', { n: m.pendingDevices })
                    : m.currentDeviceId
                      ? t('fm_phoneOk')
                      : t('fm_noPhone')}
                </span>
                {done && (
                  <span className="ok-t small">
                    {done.occurredAt
                      ? t('checkedInAt', {
                          t: fmtTime(done.occurredAt, locale, tz),
                        })
                      : t('already')}{' '}
                    · <KindText kind={done.kind} />
                  </span>
                )}
                {mine && <ProxyStatus phase={flow.phase} />}
              </span>
              {!self && (
                <span className="chips">
                  {(m.pendingDevices > 0 ||
                    commands.isUnresolved(m.personId)) && (
                    <button
                      type="button"
                      className="pill accent"
                      disabled={
                        !commands.canStart && !commands.isUnresolved(m.personId)
                      }
                      onClick={() => setConfirming(m)}
                    >
                      {t('fm_confirmPhone')}
                    </button>
                  )}
                  {mine && flow.phase.kind === 'unsettled' ? (
                    <button
                      type="button"
                      className="pill accent"
                      disabled={flow.busy}
                      onClick={() => void flow.retry()}
                    >
                      {t('retry')}
                    </button>
                  ) : (
                    !done && (
                      <button
                        type="button"
                        className="pill"
                        disabled={!flow.canStart(m.personId)}
                        onClick={() => void flow.checkIn(m.personId)}
                      >
                        {t('fm_checkInFor')}
                      </button>
                    )
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">{t('fm_proxyNote')}</p>
      {confirming && (
        <ConfirmSheet
          commands={commands}
          member={confirming}
          onClose={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

function ProxyStatus({ phase }: { phase: ProxyPhase }) {
  const { t } = useI18n();
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'locating':
      return <span className="muted small">{t('locating')}</span>;
    case 'sending':
      return <span className="muted small">{t('saving')}</span>;
    case 'noFix': {
      const key =
        phase.reason === 'denied'
          ? 'locDenied'
          : phase.reason === 'unsupported'
            ? 'locUnsupported'
            : 'locNoFix';
      return (
        <span className="warn-t small" role="alert">
          {t(key)}
        </span>
      );
    }
    case 'coarse':
      return (
        <span className="warn-t small" role="alert">
          {t('fd_coarse', { m: Math.round(Number(phase.accuracyM)) })}
        </span>
      );
    case 'stale':
      return (
        <span className="warn-t small" role="alert">
          <ErrorText code="FIX_TIME_INVALID" />
        </span>
      );
    case 'refused':
      return (
        <span className="warn-t small" role="alert">
          <ErrorText code={phase.code} />
        </span>
      );
    case 'unsettled':
      return (
        <span className="warn-t small" role="alert">
          {t('fd_checkinUnsettled')} <ErrorText code={phase.code} />
        </span>
      );
  }
}

/**
 * Confirm or reject by challenge (design §2, C2, C3): the foreman checks the name on the
 * member's phone and types its code; `expectedCurrentDeviceId` is the member's current phone
 * as the newest reading shows it when the command runs (an older view gets CONFIRM_STALE).
 */
export function ConfirmSheet({
  commands,
  member,
  onClose,
}: {
  commands: CrewCommands;
  member: Member;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  // This member's attempt while it runs or is unresolved: shown as sent, no input.
  const owned =
    commands.current?.personId === member.personId ? commands.current : null;
  const unresolved = owned !== null && commands.isUnresolved(member.personId);
  const busy = commands.busy;
  const settle = (r: { kind: string; code?: string }) => {
    if (r.kind === 'ok') onClose();
    else setError(r.code ?? null);
  };
  return (
    <Sheet title={t('fm_confirmPhone')} onClose={() => !busy && onClose()}>
      <p className="big">{member.displayName}</p>
      {owned ? (
        <>
          <div className="kv">
            <span>{t('pm_code')}</span>
            <b className="num">{owned.code}</b>
          </div>
          {unresolved ? (
            <div className="banner warn" role="alert">
              {t('fm_attemptUnresolved')}{' '}
              <ErrorText code={error ?? commands.error ?? 'NETWORK'} />
            </div>
          ) : (
            <p className="muted small">{t('saving')}</p>
          )}
          {unresolved && (
            <div className="row2">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  commands.discard();
                  setError(null);
                }}
              >
                {t('pm_giveUp')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void commands.retry().then(settle)}
              >
                {t('retry')}
              </button>
            </div>
          )}
        </>
      ) : (
        <CrewCodeEdit
          // A fresh, empty code whenever an attempt's ownership ended.
          key={commands.generation}
          commands={commands}
          error={error}
          onRun={(what, code) => {
            setError(null);
            void commands
              .run({ personId: member.personId, what, code })
              .then(settle);
          }}
        />
      )}
    </Sheet>
  );
}

function CrewCodeEdit({
  commands,
  error,
  onRun,
}: {
  commands: CrewCommands;
  error: string | null;
  onRun: (what: 'confirm' | 'reject', code: string) => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const ok = CHALLENGE_CODE.test(code) && commands.canStart;
  return (
    <>
      <p className="para muted small">{t('pm_confirmHint')}</p>
      <label className="field">
        <span>{t('pm_code')}</span>
        <input
          className="num codein"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <div className="row2">
        <button
          type="button"
          className="ghost"
          disabled={!ok}
          onClick={() => onRun('reject', code)}
        >
          {t('pm_reject')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ok}
          onClick={() => onRun('confirm', code)}
        >
          {t('pm_confirm')}
        </button>
      </div>
    </>
  );
}

/**
 * The foreman's quantity report (design §4): per item a decimal, an explicit 0, unknown,
 * n/a or blank (kept as blank), for the site's today or yesterday. Form state = the owned
 * send's payload (AGENTS.md): while a send runs or is unresolved, only its rows are shown,
 * read-only, with Retry / Give up. A send carries the revision it was edited from
 * (expectedRevision); after REVISION_CONFLICT editing restarts from the latest revision, and
 * each item where the refused draft differs shows what was typed. No hours.
 */
export function ReportCard({
  api,
  me,
  onEnded,
}: {
  api: DeviceApi;
  me: FieldMeDto;
  onEnded: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const days = reportDays(me.project.timezone, new Date());
  const [day, setDay] = useState(days[0]);
  // Per site day, for the card's life: the read, its owned sends, the last refused draft.
  const entries = useRef(
    new Map<
      string,
      {
        session: FieldSession<ForemanReportDto>;
        sends: OwnedCommands<ForemanReportDto, ReportSend>;
        refused: ReportSend | null;
      }
    >(),
  );
  let entry = entries.current.get(day);
  if (!entry) {
    const session = new FieldSession<ForemanReportDto>(
      () => api.report(day),
      rerender,
      { onEnded },
    );
    entry = { session, sends: new OwnedCommands(session), refused: null };
    entries.current.set(day, entry);
  }
  const e = entry;
  const s = e.session;
  useEffect(() => {
    if (!s.data && !s.readError) void s.load();
  }, [s]);
  const owned = e.sends.current;
  const send = async (payload: ReportSend) => {
    e.refused = null;
    const r = await sendReport(e.sends, api, day, payload);
    if (r.kind === 'rejected') e.refused = payload;
    rerender();
  };
  return (
    <section className="card">
      <h2 className="blk">{t('fm_reportTitle')}</h2>
      <div className="seg" role="tablist">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={day === d}
            className={day === d ? 'on' : ''}
            onClick={() => setDay(d)}
          >
            {i === 0 ? t('fm_today') : t('fm_yesterday')} · {fmtDay(d, locale)}
          </button>
        ))}
      </div>
      {owned && s.data ? (
        <OwnedReport data={s.data} sends={e.sends} payload={owned} />
      ) : s.data ? (
        <ReportForm
          // Edited from this read; restarts from the latest read whenever a send ends.
          key={`${day}:${s.data.n}:${e.sends.generation}`}
          data={s.data}
          timeZone={me.project.timezone}
          sends={e.sends}
          refused={e.refused}
          onSend={(p) => void send(p)}
        />
      ) : s.readError ? (
        <>
          <div className="banner err" role="alert">
            <ErrorText code={s.readError} />
          </div>
          <button type="button" className="ghost" onClick={() => void s.load()}>
            {t('retry')}
          </button>
        </>
      ) : (
        <p className="muted">{t('loading')}</p>
      )}
    </section>
  );
}

function useQtyText() {
  const { t, locale } = useI18n();
  return (raw: string) => {
    const k = qtyKind(raw);
    if (k === 'blank') return t('fm_blank');
    if (k === 'unknown' || k === 'na') return t(k);
    return fmtNum(raw, locale);
  };
}

/** An owned send, shown as sent: its rows read-only, Retry (same rows, same key) / Give up. */
export function OwnedReport({
  data,
  sends,
  payload,
}: {
  data: ForemanReportDto;
  sends: OwnedCommands<ForemanReportDto, ReportSend>;
  payload: ReportSend;
}) {
  const { t, label } = useI18n();
  const text = useQtyText();
  const unresolved = sends.unresolved !== null;
  const busy = sends.session.busy;
  const labelOf = (k: string) => {
    const it = data.items.find((i) => i.key === k);
    return it ? label(it.label) : k;
  };
  return (
    <>
      {payload.rows.map((r) => (
        <div className="kv" key={r.itemKey}>
          <span>{labelOf(r.itemKey)}</span>
          <span className="num">{text(r.qty)}</span>
        </div>
      ))}
      {payload.note && <p className="para small">{payload.note}</p>}
      {unresolved ? (
        <div className="banner warn" role="alert">
          {t('fm_sendUnresolved')}
        </div>
      ) : (
        <p className="muted small">{t('saving')}</p>
      )}
      {unresolved && (
        <div className="row2">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => sends.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="primary big"
            disabled={busy}
            onClick={() => void sends.retry()}
          >
            {t('retry')}
          </button>
        </div>
      )}
    </>
  );
}

export function ReportForm({
  data,
  timeZone,
  sends,
  refused,
  onSend,
}: {
  data: ForemanReportDto;
  timeZone: string;
  sends: OwnedCommands<ForemanReportDto, ReportSend>;
  refused: ReportSend | null;
  onSend: (p: ReportSend) => void;
}) {
  const { t, label, locale } = useI18n();
  const text = useQtyText();
  // Always edited from the latest read (this form restarts when a send ends).
  const [draft, setDraft] = useState<Draft>(() => draftFrom(data));
  const [note, setNote] = useState(data.note);
  const [invalid, setInvalid] = useState<string[]>([]);
  const latest = draftFrom(data);
  // After a refusal: the items where what was typed differs from the latest revision.
  const typed = new Map(
    (refused?.rows ?? [])
      .filter((r) => (latest[r.itemKey] ?? '').trim() !== r.qty.trim())
      .map((r) => [r.itemKey, r.qty]),
  );
  const submit = () => {
    const check = checkDraft(data, draft);
    if (!check.ok) return setInvalid(check.invalid);
    setInvalid([]);
    onSend({ rows: check.rows, note: note.trim(), editedFrom: data.n });
  };
  return (
    <>
      <p className="muted small">
        {data.n > 0 && data.receivedAt
          ? t('fm_revision', {
              n: data.n,
              t: fmtStamp(data.receivedAt, locale, timeZone),
            })
          : t('fm_notReported')}
      </p>
      {sends.refusal && (
        <div className="banner err" role="alert">
          <ErrorText code={sends.refusal} />
        </div>
      )}
      {data.items.length === 0 && (
        <p className="muted small">{t('fm_noItems')}</p>
      )}
      {data.items.map((it) => {
        const v = draft[it.key] ?? '';
        const bad = invalid.includes(it.key);
        const was = typed.get(it.key);
        return (
          <div key={it.key} className={`qline fmrow${bad ? ' bad' : ''}`}>
            <div className="blk-row">
              <span className="grow">
                <b>{label(it.label)}</b>
                <span className="muted small">{label(it.unit)}</span>
              </span>
              <NumInput
                value={v}
                label={label(it.label)}
                onChange={(x) => setDraft({ ...draft, [it.key]: x })}
              />
            </div>
            <TokenChips
              value={v}
              onSet={(x) => setDraft({ ...draft, [it.key]: x })}
            />
            {was !== undefined && (
              <span className="warn-t small">
                {t('fm_youTyped', { v: text(was) })}
              </span>
            )}
            {bad && (
              <span className="warn-t small" role="alert">
                {t('numberInvalid')}
              </span>
            )}
          </div>
        );
      })}
      <label className="field">
        <span>{t('noteOptional')}</span>
        <textarea
          rows={2}
          maxLength={FOREMAN_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p className="muted small">{t('fm_reportNote')}</p>
      <button
        type="button"
        className="primary big"
        disabled={!sends.canStart || data.items.length === 0}
        onClick={submit}
      >
        {t('fm_send')}
      </button>
    </>
  );
}
