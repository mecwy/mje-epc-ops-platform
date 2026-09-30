import { useEffect, useState } from 'react';
import {
  CHALLENGE_CODE,
  FOREMAN_NOTE_MAX,
  type FieldMeDto,
  type ForemanReportDto,
} from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { NumInput, Sheet, TokenChips } from '../ui.js';
import { fmtDay, fmtNum, fmtStamp, fmtTime } from '../report/format.js';
import { KindText } from './CheckInCard.js';
import { ErrorText } from './ErrorText.js';
import {
  checkDraft,
  draftFrom,
  qtyKind,
  type ReportDay,
  reportDays,
  reportPayload,
  type Draft,
  type ReportSend,
} from './foreman-report.js';
import type { ProxyFlow, ProxyPhase } from './proxy-flow.js';
import type { CrewCommands } from './crew-commands.js';
import type { Outcome } from './session.js';
import type { ForemanOwners } from './foreman-owners.js';

type Member = NonNullable<FieldMeDto['foreman']>['members'][number];

/**
 * The foreman's crew (design §2, §3, C2): confirm or reject a member's pending phone with the
 * code shown on it, and check members in with the foreman's own fix. Only the foreman's
 * current crew is listed; the server re-checks authority on every request.
 */
export function CrewCard({
  me,
  owners,
}: {
  me: FieldMeDto;
  /** Kept by the device page (foreman-owners.ts): they outlive this card and the role. */
  owners: ForemanOwners;
}) {
  const [confirming, setConfirming] = useState<Member | null>(null);
  return (
    <CrewList
      me={me}
      commands={owners.crew}
      flow={owners.proxy}
      confirming={confirming}
      onConfirming={setConfirming}
    />
  );
}

/** The crew list with each member's controls, and any owned attempt's controls. */
export function CrewList({
  me,
  commands,
  flow,
  confirming,
  onConfirming,
}: {
  me: FieldMeDto;
  commands: CrewCommands;
  flow: ProxyFlow;
  confirming: Member | null;
  onConfirming: (m: Member | null) => void;
}) {
  const { t, locale } = useI18n();
  const tz = me.project.timezone;
  const crew = me.foreman;
  const unresolvedName = commands.unresolved?.name ?? null;
  if (!crew) return null;
  // An owned attempt (confirmation or check-in) keeps its row, and so its Retry / Give up,
  // after its person has left the crew: the server decides the retry.
  const inCrew = (id: string) => crew.members.some((m) => m.personId === id);
  const gone: Member[] = [];
  const keep = (personId: string, displayName: string) => {
    if (!inCrew(personId) && !gone.some((g) => g.personId === personId))
      gone.push({
        personId,
        displayName,
        currentDeviceId: null,
        pendingDevices: 0,
      });
  };
  if (commands.current) keep(commands.current.personId, commands.current.name);
  // A crew check-in keeps its row while unresolved (Retry / Give up) and with its refusal.
  if (flow.person && (flow.queue.pending || flow.phase.kind === 'refused'))
    keep(flow.person, flow.personName);
  const rows = [...crew.members, ...gone];
  // A sheet for someone who has left stays open only while their attempt is owned.
  const open =
    confirming &&
    (inCrew(confirming.personId) ||
      commands.current?.personId === confirming.personId)
      ? confirming
      : null;
  // The last refused confirmation stays named on the card whenever its sheet is not open:
  // after the sheet closed, after its person left, and after the role was lost and restored
  // (the sheet's own state is gone then; the owner keeps the result). Dismissed by the user.
  const lastRefused =
    commands.refused && commands.refusal && !open ? commands.refused : null;
  return (
    <section className="card">
      <h2 className="blk">{t('fm_crewTitle', { crew: crew.crewName })}</h2>
      {unresolvedName && !open && (
        <div className="banner warn" role="alert">
          {t('fm_unresolvedFor', { name: unresolvedName })}
        </div>
      )}
      {lastRefused && (
        <div className="banner warn" role="alert">
          <b>{lastRefused.name}</b>:{' '}
          <ErrorText
            code={commands.refusal}
            write
            uncertain={commands.refusalUncertain}
          />{' '}
          <button
            type="button"
            className="textbtn"
            onClick={() => commands.clearRefusal()}
          >
            {t('close')}
          </button>
        </div>
      )}
      {rows.length === 0 && <p className="muted small">{t('fm_crewEmpty')}</p>}
      <ul className="plainlist">
        {rows.map((m) => {
          const self = m.personId === me.person.id;
          const left = !inCrew(m.personId);
          const done = flow.doneFor(m.personId);
          const mine = flow.person === m.personId;
          return (
            <li key={m.personId} className="devrow">
              <span className="grow">
                <b>{m.displayName}</b>
                <span className="muted small">
                  {left
                    ? t('fm_leftCrew')
                    : m.pendingDevices > 0
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
                    commands.current?.personId === m.personId) && (
                    <button
                      type="button"
                      className="pill accent"
                      disabled={
                        !commands.canStart && !commands.isUnresolved(m.personId)
                      }
                      onClick={() => onConfirming(m)}
                    >
                      {t('fm_confirmPhone')}
                    </button>
                  )}
                  {mine && flow.phase.kind === 'unsettled' ? (
                    <>
                      <button
                        type="button"
                        className="pill"
                        disabled={flow.busy}
                        onClick={() => flow.discard()}
                      >
                        {t('pm_giveUp')}
                      </button>
                      <button
                        type="button"
                        className="pill accent"
                        disabled={flow.busy}
                        onClick={() => void flow.retry()}
                      >
                        {t('retry')}
                      </button>
                    </>
                  ) : (
                    !done &&
                    !left && (
                      <button
                        type="button"
                        className="pill"
                        disabled={!flow.canStart(m.personId)}
                        onClick={() =>
                          void flow.checkIn(m.personId, m.displayName)
                        }
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
      {open && (
        <ConfirmSheet
          commands={commands}
          member={open}
          onClose={() => onConfirming(null)}
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
          <ErrorText code={phase.code} write uncertain={phase.uncertain} />
        </span>
      );
    case 'unsettled':
      return (
        <span className="warn-t small" role="alert">
          <ErrorText code={phase.code} write /> {t('fm_proxyGiveUpHint')}
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
  const [error, setError] = useState<{
    code: string;
    uncertain: boolean;
  } | null>(null);
  // This member's attempt while it runs or is unresolved: shown as sent, no input.
  const owned =
    commands.current?.personId === member.personId ? commands.current : null;
  const unresolved = owned !== null && commands.isUnresolved(member.personId);
  const busy = commands.busy;
  const settle = (r: Outcome<unknown>) => {
    if (r.kind === 'ok') onClose();
    else
      setError({
        code: r.code,
        uncertain: r.kind === 'rejected' && r.uncertain,
      });
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
              <ErrorText code={commands.error ?? 'NETWORK'} write />
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
              .run({
                personId: member.personId,
                name: member.displayName,
                what,
                code,
              })
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
  error: { code: string; uncertain: boolean } | null;
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
          <ErrorText code={error.code} write uncertain={error.uncertain} />
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
  me,
  owners,
}: {
  me: FieldMeDto;
  /** Kept by the device page: each day's read and owned send outlive this card and the role. */
  owners: ForemanOwners;
}) {
  const { t, locale } = useI18n();
  const days = reportDays(me.project.timezone, new Date());
  const [picked, setDay] = useState(days[0]);
  // New reports only for the site's today and yesterday: a day that has left that window
  // (site midnight passed) is not offered any more; its retained attempt is shown below.
  const day = days.includes(picked) ? picked : days[0];
  const e = owners.reports.get(day);
  useEffect(() => {
    if (!e.session.data && !e.session.readError) void e.session.load();
  }, [e]);
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
      <ReportDayBody report={e} timeZone={me.project.timezone} />
      <RetainedReports owners={owners} window={days} />
    </section>
  );
}

/**
 * Report attempts for days outside the selectable window (the site's today and yesterday),
 * kept by the device-level owner: a send that is running or unresolved keeps its payload,
 * original key and body, and Retry / Give up; the server decides (a day now too old is refused
 * TOO_LATE, a certain refusal). The last refusal stays shown until dismissed.
 */
export function RetainedReports({
  owners,
  window,
}: {
  owners: ForemanOwners;
  window: readonly string[];
}) {
  const { t, locale } = useI18n();
  const retained = owners.reports
    .all()
    .filter(
      (d) =>
        !window.includes(d.day) &&
        (d.sends.current !== null || d.sends.refusal !== null),
    );
  if (retained.length === 0) return null;
  return (
    <div className="retained">
      {retained.map((d) => {
        const owned = d.sends.current;
        return (
          <div key={d.day} className="qline">
            <b>{t('fm_actReport', { day: fmtDay(d.day, locale) })}</b>
            {owned ? (
              <OwnedReport data={d.session.data} report={d} payload={owned} />
            ) : (
              <div className="banner err" role="alert">
                <ErrorText
                  code={d.sends.refusal}
                  write
                  uncertain={d.sends.refusalUncertain}
                />{' '}
                <button
                  type="button"
                  className="textbtn"
                  onClick={() => d.sends.clearRefusal()}
                >
                  {t('close')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One day's report: the owned send as sent, or the form edited from the latest read. */
export function ReportDayBody({
  report,
  timeZone,
}: {
  report: ReportDay;
  timeZone: string;
}) {
  const { t } = useI18n();
  const s = report.session;
  const owned = report.sends.current;
  if (owned && s.data)
    return <OwnedReport data={s.data} report={report} payload={owned} />;
  if (s.data)
    return (
      <ReportForm
        // Edited from this read; restarts from the latest read whenever a send ends.
        key={`${report.day}:${s.data.crewId}:${s.data.n}:${report.sends.generation}`}
        data={s.data}
        timeZone={timeZone}
        sends={report.sends}
        refused={report.refused}
        onSend={(p) => void report.send(p)}
      />
    );
  if (s.readError)
    return (
      <>
        <div className="banner err" role="alert">
          <ErrorText code={s.readError} />
        </div>
        <button type="button" className="ghost" onClick={() => void s.load()}>
          {t('retry')}
        </button>
      </>
    );
  return <p className="muted">{t('loading')}</p>;
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
  report,
  payload,
}: {
  /** The read the labels come from (null for a retained day never read in this view). */
  data: ForemanReportDto | null;
  report: ReportDay;
  payload: ReportSend;
}) {
  const { t, label } = useI18n();
  const text = useQtyText();
  const unresolved = report.sends.unresolved !== null;
  const busy = report.session.busy;
  const labelOf = (k: string) => {
    const it = data?.items.find((i) => i.key === k);
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
          {t('fm_sendUnresolved')}{' '}
          <ErrorText code={report.session.error ?? 'NETWORK'} write />
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
            onClick={() => report.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="primary big"
            disabled={busy}
            // The same settlement as a first send (ReportDay): a conflict keeps the hints.
            onClick={() => void report.retry()}
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
  sends: ReportDay['sends'];
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
  // After a refusal: the items where what was typed differs from the latest revision (only
  // for the same crew and day; a draft for another crew is never shown as this crew's).
  const same =
    refused?.crewId === data.crewId &&
    refused.businessDate === data.businessDate;
  const typed = new Map(
    (same ? refused.rows : [])
      .filter((r) => (latest[r.itemKey] ?? '').trim() !== r.qty.trim())
      .map((r) => [r.itemKey, r.qty]),
  );
  const submit = () => {
    const check = checkDraft(data, draft);
    if (!check.ok) return setInvalid(check.invalid);
    setInvalid([]);
    onSend(reportPayload(data, check.rows, note.trim()));
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
          <ErrorText
            code={sends.refusal}
            write
            uncertain={sends.refusalUncertain}
          />
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

/**
 * The owned attempts while this phone's person is not a foreman (the role was removed while an
 * attempt was running or unresolved): each keeps Retry / Give up, and the server decides
 * whether a retry is still allowed. A result that ends an attempt stays shown here.
 */
export function OwnedActionsBar({ owners }: { owners: ForemanOwners }) {
  const { t, locale } = useI18n();
  const { crew, proxy, reports } = owners;
  const rows: {
    key: string;
    what: string;
    running: boolean;
    unresolved: boolean;
    code: string | null;
    uncertain: boolean;
    retry: () => void;
    giveUp: () => void;
  }[] = [];
  const crewShown = crew.current ?? crew.refused;
  if (crewShown)
    rows.push({
      key: 'crew',
      what: t('fm_actConfirm', { name: crewShown.name }),
      running: crew.current !== null && crew.busy,
      unresolved: crew.unresolved !== null,
      code: crew.current ? crew.error : crew.refusal,
      uncertain: crew.current ? true : crew.refusalUncertain,
      retry: () => void crew.retry(),
      giveUp: () => crew.discard(),
    });
  if (proxy.person && proxy.phase.kind !== 'idle')
    rows.push({
      key: 'proxy',
      what: t('fm_actProxy', { name: proxy.personName }),
      running: proxy.busy,
      unresolved: proxy.phase.kind === 'unsettled',
      code:
        proxy.phase.kind === 'unsettled' || proxy.phase.kind === 'refused'
          ? proxy.phase.code
          : null,
      uncertain: proxy.phase.kind === 'refused' && proxy.phase.uncertain,
      retry: () => void proxy.retry(),
      giveUp: () => proxy.discard(),
    });
  for (const d of reports.all())
    if (d.sends.current || d.sends.refusal)
      rows.push({
        key: `report:${d.day}`,
        what: t('fm_actReport', { day: fmtDay(d.day, locale) }),
        running: d.sends.current !== null && d.session.busy,
        unresolved: d.sends.unresolved !== null,
        code: d.sends.current ? d.session.error : d.sends.refusal,
        uncertain: d.sends.current ? true : d.sends.refusalUncertain,
        retry: () => void d.retry(),
        giveUp: () => d.discard(),
      });
  if (rows.length === 0) return null;
  return (
    <section className="card">
      <h2 className="blk">{t('fm_unresolvedTitle')}</h2>
      <p className="muted small">{t('fm_unresolvedRoleNote')}</p>
      <ul className="plainlist">
        {rows.map((r) => (
          <li key={r.key} className="devrow">
            <span className="grow">
              <b>{r.what}</b>
              <span className="warn-t small" role="alert">
                {r.running ? (
                  t('saving')
                ) : r.code ? (
                  <ErrorText code={r.code} write uncertain={r.uncertain} />
                ) : null}
              </span>
            </span>
            {r.unresolved && (
              <span className="chips">
                <button
                  type="button"
                  className="pill"
                  disabled={r.running}
                  onClick={r.giveUp}
                >
                  {t('pm_giveUp')}
                </button>
                <button
                  type="button"
                  className="pill accent"
                  disabled={r.running}
                  onClick={r.retry}
                >
                  {t('retry')}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The foreman parts of the device page: the crew and report cards while this person is a
 * foreman, otherwise the owned-attempts bar. The owners come from the device page and outlive
 * both (AGENTS.md), so losing and regaining the role never orphans an attempt.
 */
export function ForemanArea({
  me,
  owners,
  tab,
}: {
  me: FieldMeDto;
  owners: ForemanOwners;
  tab: 'me' | 'crew' | 'report';
}) {
  if (!me.foreman) return <OwnedActionsBar owners={owners} />;
  return (
    <>
      <div hidden={tab !== 'crew'}>
        <CrewCard me={me} owners={owners} />
      </div>
      <div hidden={tab !== 'report'}>
        <ReportCard me={me} owners={owners} />
      </div>
    </>
  );
}
