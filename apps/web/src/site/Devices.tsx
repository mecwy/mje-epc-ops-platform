import { useEffect, useReducer, useState } from 'react';
import { CHALLENGE_CODE, type FieldDeviceDto } from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import { FieldSession } from '../field/session.js';
import { fmtStamp } from '../report/format.js';
import { currentDevice, groupDevices } from './site-form.js';

type Action =
  | { kind: 'confirm'; device: FieldDeviceDto }
  | { kind: 'reject'; device: FieldDeviceDto }
  | { kind: 'revoke'; device: FieldDeviceDto };

/**
 * The PM's device list (design §2, §6; U4): pending phones are confirmed with the code shown
 * on the worker's phone (the PM never picks a row for the ceremony), rejected, or revoked
 * once confirmed. Foreman confirmations are marked for spot checks. Rows only; never a token.
 */
export function DevicesCard({
  api,
  project,
}: {
  api: ReportApi;
  project: Project;
}) {
  const { t, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [session] = useState(
    () => new FieldSession(() => api.devices(project.id), rerender),
  );
  useEffect(() => void session.load(), [session]);
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
            onClick={() => setAction({ kind: 'confirm', device: d })}
          >
            {t('pm_confirm')}
          </button>
          <button
            type="button"
            className="pill"
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
          api={api}
          project={project}
          session={session}
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

function ActionSheet({
  action,
  api,
  project,
  session,
  onClose,
}: {
  action: Action;
  api: ReportApi;
  project: Project;
  session: FieldSession<FieldDeviceDto[]>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const d = action.device;
  const codeOk = CHALLENGE_CODE.test(code);
  const run = async () => {
    setError(null);
    const r = session.pending
      ? await session.retry()
      : await session.act((list) => {
          const key = crypto.randomUUID();
          if (action.kind === 'confirm')
            return {
              key,
              send: () =>
                api.confirmDevice({
                  projectId: project.id,
                  clientMutationId: key,
                  personId: d.personId,
                  code,
                  // Built from the newest list when it runs; an older view gets CONFIRM_STALE.
                  expectedCurrentDeviceId: currentDevice(
                    list ?? [],
                    d.personId,
                  ),
                }),
            };
          // Reject and revoke act on the row at its current version.
          const now = list?.find((x) => x.id === d.id);
          if (!now) return null;
          const c = {
            projectId: project.id,
            clientMutationId: key,
            deviceId: d.id,
            expectedVersion: now.version,
          };
          return {
            key,
            send: () =>
              action.kind === 'reject'
                ? api.rejectDevice(c)
                : api.revokeDevice(c),
          };
        });
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
        disabled={session.busy || (action.kind === 'confirm' && !codeOk)}
        onClick={() => void run()}
      >
        {session.pending ? t('retry') : t(title)}
      </button>
    </Sheet>
  );
}
