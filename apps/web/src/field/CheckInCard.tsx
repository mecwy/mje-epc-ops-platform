import { useEffect, useMemo, useReducer, useState } from 'react';
import type { CheckInFlag, FieldMeDto } from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { fmtTime } from '../report/format.js';
import { locate } from '../report/geo.js';
import { resizeJpeg } from '../report/thumbnail.js';
import { CheckInFlow, type Phase } from './checkin-flow.js';
import { ErrorText } from './ErrorText.js';
import type { DeviceApi } from './field-api.js';

/** The server's selfie limit (C25); the image is re-encoded smaller on the phone first. */
const SELFIE_MAX_BYTES = 3 * 1024 * 1024;
const SELFIE_EDGE = 1280;

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function FlagChips({ flags }: { flags: readonly CheckInFlag[] }) {
  const { t } = useI18n();
  return (
    <>
      {flags.map((f) => {
        const key = `fd_flag_${f}` as const;
        return (
          <span key={f} className="chip warn">
            {t(key)}
          </span>
        );
      })}
    </>
  );
}
export function KindText({ kind }: { kind: string }) {
  const { t } = useI18n();
  const key =
    kind === 'FOREMAN_PROXY'
      ? 'fd_kind_FOREMAN_PROXY'
      : kind === 'PM_PROXY'
        ? 'fd_kind_PM_PROXY'
        : 'fd_kind_SELF';
  return <>{t(key)}</>;
}

/**
 * Self check-in (design §3): one per person and site day. The phone takes a fix (accuracy
 * shown), refuses to send one coarser than 100 m, and sends the event once under one key; a
 * lost answer is resent unchanged. The site area is judged only by the server. The state
 * lives in CheckInFlow (tested without a DOM); this component only renders it.
 */
export function CheckInCard({
  api,
  me,
  onEnded,
}: {
  api: DeviceApi;
  me: FieldMeDto;
  /** A command was refused because the device ended. */
  onEnded: (code: string) => void;
}) {
  const { t, locale } = useI18n();
  const tz = me.project.timezone;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [flow] = useState(
    () =>
      new CheckInFlow({
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
  const selfie = flow.selfie;
  const preview = useMemo(
    () => (selfie ? URL.createObjectURL(selfie.image) : null),
    [selfie],
  );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const pickSelfie = async (file: File | undefined) => {
    if (!file || !flow.canChooseSelfie) return;
    const image = await resizeJpeg(file, SELFIE_EDGE, SELFIE_MAX_BYTES, 0.8);
    if (!image) return flow.unreadable();
    await flow.chooseSelfie(image);
  };
  const phase = flow.phase;
  const done = flow.doneToday();

  if (done)
    return (
      <section className="card">
        <div className="checked">
          <b>
            {done.occurredAt
              ? t('checkedInAt', { t: fmtTime(done.occurredAt, locale, tz) })
              : t('already')}
          </b>
          <span className="muted small">
            <KindText kind={done.kind} />
            {done.accuracyM && ` · ±${Math.round(Number(done.accuracyM))} m`}
          </span>
        </div>
        {(done.flags.length > 0 || done.hasSelfie) && (
          <div className="chips">
            <FlagChips flags={done.flags} />
            {done.hasSelfie && (
              <span className="chip">{t('fd_withSelfie')}</span>
            )}
          </div>
        )}
        {done.afterSubmission && (
          <p className="muted small">{t('fd_afterSubmission')}</p>
        )}
        <p className="muted small">{t('fd_checkinNote')}</p>
      </section>
    );

  const selfieOn = me.settings.selfieEnabled && !flow.selfieOff;
  const canChoose = flow.canChooseSelfie;
  return (
    <section className="card">
      <h2 className="blk">{t('checkinTitle')}</h2>
      {selfieOn && (
        <div className="selfie">
          {preview && <img src={preview} alt="" />}
          <label className={`ghost small${canChoose ? '' : ' off'}`}>
            {selfie ? t('fd_selfieRetake') : t('fd_selfieOptional')}
            <input
              type="file"
              accept="image/*"
              capture="user"
              hidden
              disabled={!canChoose}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                void pickSelfie(f);
              }}
            />
          </label>
          {selfie && (
            <button
              type="button"
              className="pill"
              disabled={flow.uploads.busy || flow.checkins.pending !== null}
              onClick={() => flow.removeSelfie()}
            >
              {t('fd_selfieRemove')}
            </button>
          )}
          {selfie && flow.staged && (
            <span className="muted small">{t('fd_selfieReady')}</span>
          )}
          {selfie && flow.uploads.busy && (
            <span className="muted small">{t('fd_selfieUploading')}</span>
          )}
        </div>
      )}
      <CheckInStatus phase={phase} />
      {phase.kind === 'unsettled' ? (
        <button
          type="button"
          className="primary big"
          disabled={flow.busy}
          onClick={() => void flow.retry()}
        >
          {t('retry')}
        </button>
      ) : (
        <button
          type="button"
          className="primary big"
          disabled={!flow.canCheckIn}
          onClick={() => void flow.checkIn()}
        >
          {phase.kind === 'noFix' ||
          phase.kind === 'coarse' ||
          phase.kind === 'stale'
            ? t('retryLocation')
            : t('checkin')}
        </button>
      )}
      <p className="muted small">{t('fd_checkinNote')}</p>
    </section>
  );
}

export function CheckInStatus({ phase }: { phase: Phase }) {
  const { t } = useI18n();
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'locating':
      return <p className="muted">{t('locating')}</p>;
    case 'noFix': {
      const key =
        phase.reason === 'denied'
          ? 'locDenied'
          : phase.reason === 'unsupported'
            ? 'locUnsupported'
            : 'locNoFix';
      return (
        <div className="banner err" role="alert">
          {t(key)}
        </div>
      );
    }
    case 'coarse':
      return (
        <div className="banner err" role="alert">
          {t('fd_coarse', { m: Math.round(Number(phase.fix.accuracyM)) })}
        </div>
      );
    case 'stale':
      return (
        <div className="banner err" role="alert">
          <ErrorText code="FIX_TIME_INVALID" />
        </div>
      );
    case 'sending':
      return phase.fix ? (
        <p className="muted">
          {t('located', { m: Math.round(Number(phase.fix.accuracyM)) })} ·{' '}
          {t('saving')}
        </p>
      ) : (
        <p className="muted">{t('saving')}</p>
      );
    case 'refused':
      return (
        <div className="banner err" role="alert">
          {phase.fix && (
            <>
              {t('located', { m: Math.round(Number(phase.fix.accuracyM)) })}
              <br />
            </>
          )}
          <ErrorText code={phase.code} write />
        </div>
      );
    case 'unsettled': {
      const key =
        phase.what === 'selfie' ? 'fd_selfieUnsettled' : 'fd_checkinUnsettled';
      return (
        <div className="banner warn" role="alert">
          {t(key)} <ErrorText code={phase.code} write />
        </div>
      );
    }
  }
}
