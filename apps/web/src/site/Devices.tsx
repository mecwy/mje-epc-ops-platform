import { useEffect, useState } from 'react';
import { CHALLENGE_CODE, type FieldDeviceDto } from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import type { Project } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtStamp } from '../report/format.js';
import { groupDevices } from './site-form.js';
import type { DeviceCommands, SiteSessions } from './site-sessions.js';
import { useSessions } from './use-sessions.js';

/** The sheet being shown: which device and which action (the code is typed in the sheet). */
type Action = { kind: 'confirm' | 'reject' | 'revoke'; device: FieldDeviceDto };

/**
 * The PM's device list (design §2, §6; U4): pending phones are confirmed with the code shown
 * on the worker's phone (the PM never picks a row for the ceremony), rejected, or revoked
 * once confirmed. Foreman confirmations are marked for spot checks. Rows only; never a token.
 */
export function DevicesCard({
  sessions,
  project,
}: {
  sessions: SiteSessions;
  project: Project;
}) {
  const { t, locale } = useI18n();
  useSessions(sessions);
  const commands = sessions.devices;
  const session = commands.session;
  useEffect(() => void session.load(), [session]);
  const unresolved = commands.unresolved;
  const [action, setAction] = useState<Action | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const devices = session.data ?? [];
  const groups = groupDevices(devices);
  const nameOf = (personId: string) =>
    devices.find((d) => d.personId === personId)?.displayName ?? null;
  const when = (iso: string) => fmtStamp(iso, locale, project.timezone);

  const row = (d: FieldDeviceDto) => (
    <li key={d.id} className="devrow">
      <span className="grow">
        <b>{d.displayName}</b>
        <span className="muted small">
          {d.effectiveState === 'PENDING'
            ? t('pm_boundAt', { t: when(d.createdAt) })
            : d.effectiveState === 'CONFIRMED'
              ? t('pm_lastSeen', { t: when(d.lastSeenAt) })
              : t('pm_boundAt', { t: when(d.createdAt) })}
        </span>
        {d.effectiveState === 'CONFIRMED' && d.confirmedBy && (
          <span className="chips">
            {d.confirmedBy.kind === 'FOREMAN' ? (
              <span className="chip warn">
                {t('pm_byForeman', {
                  name: nameOf(d.confirmedBy.personId) ?? '—',
                })}
              </span>
            ) : (
              <span className="chip">{t('pm_byPm')}</span>
            )}
          </span>
        )}
        {d.effectiveState !== 'PENDING' && d.effectiveState !== 'CONFIRMED' && (
          <span className="muted small">
            <EndText reason={d.endReason} />
          </span>
        )}
      </span>
      {d.effectiveState === 'PENDING' && (
        <span className="chips">
          <button
            type="button"
            className="pill accent"
            disabled={!commands.canStart}
            onClick={() => setAction({ kind: 'confirm', device: d })}
          >
            {t('pm_confirm')}
          </button>
          <button
            type="button"
            className="pill"
            disabled={!commands.canStart}
            onClick={() => setAction({ kind: 'reject', device: d })}
          >
            {t('pm_reject')}
          </button>
        </span>
      )}
      {d.effectiveState === 'CONFIRMED' && (
        <button
          type="button"
          className="pill"
          disabled={!commands.canStart}
          onClick={() => setAction({ kind: 'revoke', device: d })}
        >
          {t('pm_revoke')}
        </button>
      )}
    </li>
  );
  return (
    <section className="card noprint">
      <div className="blk-row">
        <h2 className="blk">{t('pm_devicesTitle')}</h2>
        <button
          type="button"
          className="textbtn"
          onClick={() => void session.load()}
        >
          {t('pm_reload')}
        </button>
      </div>
      {unresolved && !action && (
        <div className="banner warn" role="alert">
          <UnresolvedText
            kind={unresolved.kind}
            name={unresolved.device.displayName}
          />{' '}
          <ErrorText code={session.error} />
          <div className="chips">
            <button
              type="button"
              className="pill accent"
              disabled={session.busy}
              onClick={() => void commands.retry()}
            >
              {t('retry')}
            </button>
            <button
              type="button"
              className="pill"
              disabled={session.busy}
              onClick={() => commands.discard()}
            >
              {t('pm_giveUp')}
            </button>
          </div>
        </div>
      )}
      {session.readError && (
        <div className="banner err" role="alert">
          <ErrorText code={session.readError} />
        </div>
      )}
      {!session.data && !session.readError && (
        <p className="muted">{t('loading')}</p>
      )}
      {session.data && (
        <>
          <h3>{t('pm_pendingN', { n: groups.pending.length })}</h3>
          {groups.pending.length > 0 ? (
            <ul className="plainlist">{groups.pending.map(row)}</ul>
          ) : (
            <p className="muted small">{t('pm_nonePending')}</p>
          )}
          <h3>{t('pm_activeN', { n: groups.active.length })}</h3>
          {groups.active.length > 0 && (
            <ul className="plainlist">{groups.active.map(row)}</ul>
          )}
          {groups.ended.length > 0 && (
            <button
              type="button"
              className="textbtn"
              aria-expanded={showEnded}
              onClick={() => setShowEnded(!showEnded)}
            >
              {t('pm_endedN', { n: groups.ended.length })}
            </button>
          )}
          {showEnded && <ul className="plainlist">{groups.ended.map(row)}</ul>}
        </>
      )}
      {action && (
        <ActionSheet
          action={action}
          commands={commands}
          onClose={() => setAction(null)}
        />
      )}
    </section>
  );
}

const END_REASONS = {
  REJECTED: 'pm_end_REJECTED',
  SUPERSEDED: 'pm_end_SUPERSEDED',
  REVOKED: 'pm_end_REVOKED',
  RELEASED: 'pm_end_RELEASED',
  REPLACED: 'pm_end_REPLACED',
  UNASSIGNED: 'pm_end_UNASSIGNED',
  PENDING_TIMEOUT: 'pm_end_PENDING_TIMEOUT',
  LIFETIME: 'pm_end_LIFETIME',
  IDLE: 'pm_end_IDLE',
} as const satisfies Record<string, MessageKey>;
/** Why a device ended; an expiry the server has not persisted yet shows as expired. */
function EndText({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  const key =
    reason && Object.hasOwn(END_REASONS, reason)
      ? END_REASONS[reason as keyof typeof END_REASONS]
      : 'pm_end_EXPIRED';
  return <>{t(key)}</>;
}

function UnresolvedText({
  kind,
  name,
}: {
  kind: Action['kind'];
  name: string;
}) {
  const { t } = useI18n();
  const key =
    kind === 'confirm'
      ? 'pm_unresolvedConfirm'
      : kind === 'reject'
        ? 'pm_unresolvedReject'
        : 'pm_unresolvedRevoke';
  return <>{t(key, { name })}</>;
}

/**
 * One device's action. Only started when nothing is unresolved (DeviceCommands); if its own
 * command becomes unresolved, the sheet offers the retry of exactly that command.
 */
function ActionSheet({
  action,
  commands,
  onClose,
}: {
  action: Action;
  commands: DeviceCommands;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const session = commands.session;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const d = action.device;
  const codeOk = CHALLENGE_CODE.test(code);
  // A retry here is offered only for this sheet's own unresolved command.
  const mine =
    commands.unresolved?.device.id === d.id &&
    commands.unresolved.kind === action.kind;
  const run = async () => {
    setError(null);
    const r = mine
      ? await commands.retry()
      : await commands.run(
          action.kind === 'confirm'
            ? { kind: 'confirm', device: d, code }
            : { kind: action.kind, device: d },
        );
    if (r.kind === 'ok') onClose();
    else setError(r.code);
  };
  const title =
    action.kind === 'confirm'
      ? 'pm_confirmTitle'
      : action.kind === 'reject'
        ? 'pm_rejectTitle'
        : 'pm_revokeTitle';
  return (
    <Sheet title={t(title)} onClose={() => !session.busy && onClose()}>
      <p className="big">{d.displayName}</p>
      {action.kind === 'confirm' ? (
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
        </>
      ) : (
        <p className="para">
          {action.kind === 'reject' ? t('pm_rejectWarn') : t('pm_revokeWarn')}
        </p>
      )}
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      <button
        type="button"
        className={`primary wide${action.kind === 'revoke' ? ' danger' : ''}`}
        disabled={
          session.busy ||
          (!mine && !commands.canStart) ||
          (!mine && action.kind === 'confirm' && !codeOk)
        }
        onClick={() => void run()}
      >
        {mine ? t('retry') : t(title)}
      </button>
    </Sheet>
  );
}
