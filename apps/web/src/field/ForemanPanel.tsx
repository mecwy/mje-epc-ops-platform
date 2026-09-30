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
  changedOnServer,
  checkDraft,
  draftFrom,
  qtyKind,
  reportDays,
  type Draft,
} from './foreman-report.js';
import { ProxyFlow, type ProxyPhase } from './proxy-flow.js';
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
  const crew = me.foreman;
  if (!crew) return null;
  return (
    <section className="card">
      <h2 className="blk">{t('fm_crewTitle', { crew: crew.crewName })}</h2>
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
                  {m.pendingDevices > 0 && (
                    <button
                      type="button"
                      className="pill accent"
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
          api={api}
          member={confirming}
          session={session}
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
function ConfirmSheet({
  api,
  member,
  session,
  onClose,
}: {
  api: DeviceApi;
  member: Member;
  session: FieldSession<FieldMeDto>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = CHALLENGE_CODE.test(code);
  const run = async (what: 'confirm' | 'reject') => {
    setBusy(true);
    setError(null);
    const r = session.pending
      ? await session.retry()
      : await session.act((me) => {
          const m = me?.foreman?.members.find(
            (x) => x.personId === member.personId,
          );
          if (!m) return null;
          const key = crypto.randomUUID();
          return {
            key,
            send: () =>
              what === 'confirm'
                ? api.confirmCrew({
                    clientMutationId: key,
                    personId: m.personId,
                    code,
                    expectedCurrentDeviceId: m.currentDeviceId,
                  })
                : api.rejectCrew({
                    clientMutationId: key,
                    personId: m.personId,
                    code,
                  }),
          };
        });
    setBusy(false);
    if (r.kind === 'ok') onClose();
    else setError(r.code);
  };
  return (
    <Sheet title={t('fm_confirmPhone')} onClose={() => !busy && onClose()}>
      <p className="big">{member.displayName}</p>
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
          disabled={busy || (!ok && !session.pending)}
          onClick={() => void run('reject')}
        >
          {t('pm_reject')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || (!ok && !session.pending)}
          onClick={() => void run('confirm')}
        >
          {session.pending ? t('retry') : t('pm_confirm')}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * The foreman's quantity report (design §4): per item a decimal, an explicit 0, unknown,
 * n/a or blank (kept as blank), for the site's today or yesterday. Each send is a new
 * revision against `expectedRevision`; after REVISION_CONFLICT the latest values are shown
 * beside the draft and nothing is sent until the foreman sends again. No hours.
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
  const sessions = useRef(new Map<string, FieldSession<ForemanReportDto>>());
  let session = sessions.current.get(day);
  if (!session) {
    session = new FieldSession<ForemanReportDto>(
      () => api.report(day),
      rerender,
      {
        onEnded,
      },
    );
    sessions.current.set(day, session);
  }
  const s = session;
  useEffect(() => {
    if (!s.data && !s.readError) void s.load();
  }, [s]);
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
      {s.data ? (
        <ReportForm
          key={day}
          api={api}
          session={s}
          data={s.data}
          day={day}
          timeZone={me.project.timezone}
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

function ReportForm({
  api,
  session,
  data,
  day,
  timeZone,
}: {
  api: DeviceApi;
  timeZone: string;
  session: FieldSession<ForemanReportDto>;
  data: ForemanReportDto;
  day: string;
}) {
  const { t, label, locale } = useI18n();
  // The draft and the server values it started from; a conflict moves only the base.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(data));
  const [note, setNote] = useState(data.note);
  const [base, setBase] = useState<Draft>(() => draftFrom(data));
  const [changed, setChanged] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const latest = draftFrom(data);
  const send = async () => {
    setError(null);
    setSent(false);
    if (!session.pending) {
      const check = checkDraft(data, draft);
      if (!check.ok) return setInvalid(check.invalid);
    }
    setInvalid([]);
    const r = session.pending
      ? await session.retry()
      : await session.act((d) => {
          const rows = d ? checkDraft(d, draft) : null;
          if (!d || !rows?.ok) return null;
          const key = crypto.randomUUID();
          const command = {
            clientMutationId: key,
            businessDate: day,
            crewId: d.crewId,
            // The revision this one replaces, from the newest reading when it runs.
            expectedRevision: d.n,
            rows: rows.rows,
            note: note.trim(),
            occurredAt: new Date().toISOString(),
          };
          return { key, send: () => api.submitReport(command) };
        });
    const now = session.data;
    if (r.kind === 'ok') {
      if (now) {
        setBase(draftFrom(now));
        setDraft(draftFrom(now));
      }
      setChanged([]);
      setSent(true);
      return;
    }
    setError(r.code);
    if (r.code === 'REVISION_CONFLICT' && now) {
      const fresh = draftFrom(now);
      setChanged(changedOnServer(base, fresh));
      setBase(fresh);
    }
  };
  const shownQty = (raw: string) => {
    const k = qtyKind(raw);
    if (k === 'blank') return t('fm_blank');
    if (k === 'unknown' || k === 'na') return t(k);
    return fmtNum(raw, locale);
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
      {data.items.length === 0 && (
        <p className="muted small">{t('fm_noItems')}</p>
      )}
      {data.items.map((it) => {
        const v = draft[it.key] ?? '';
        const bad = invalid.includes(it.key);
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
                disabled={session.busy}
              />
            </div>
            <TokenChips
              value={v}
              disabled={session.busy}
              onSet={(x) => setDraft({ ...draft, [it.key]: x })}
            />
            {changed.includes(it.key) && (
              <span className="warn-t small">
                {t('fm_latest', { v: shownQty(latest[it.key] ?? '') })}
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
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      {sent && <p className="ok-t">{t('fm_sent', { n: data.n })}</p>}
      <button
        type="button"
        className="primary big"
        disabled={session.busy || data.items.length === 0}
        onClick={() => void send()}
      >
        {session.pending ? t('retry') : t('fm_send')}
      </button>
    </>
  );
}
