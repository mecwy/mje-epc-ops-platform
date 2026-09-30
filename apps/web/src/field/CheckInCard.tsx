import { useEffect, useState } from 'react';
import type {
  CaptureFixDto,
  CheckInFlag,
  CheckInResultDto,
  FieldMeDto,
  SelfieUploadDto,
} from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { fmtTime, siteToday } from '../report/format.js';
import { locate, type NoFixReason } from '../report/geo.js';
import { resizeJpeg } from '../report/thumbnail.js';
import {
  attempt,
  checkFix,
  checkInEvent,
  recallToday,
  rememberToday,
  type TodayCheckIn,
} from './checkin.js';
import { ErrorText } from './ErrorText.js';
import { FieldApiError, type DeviceApi } from './field-api.js';
import type { FieldSession, Outcome } from './session.js';

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
type Phase =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'noFix'; reason: NoFixReason }
  | { kind: 'coarse'; fix: CaptureFixDto }
  | { kind: 'stale' }
  | { kind: 'sending'; fix: CaptureFixDto | null }
  | { kind: 'refused'; code: string; fix: CaptureFixDto | null }
  | {
      kind: 'unsettled';
      code: string;
      what: 'checkin' | 'selfie';
      fix: CaptureFixDto | null;
    };
type Unsettled = Extract<Phase, { kind: 'unsettled' }>;

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
 * lost answer is resent unchanged. The site area is judged only by the server.
 */
export function CheckInCard({
  api,
  me,
  session,
}: {
  api: DeviceApi;
  me: FieldMeDto;
  session: FieldSession<FieldMeDto>;
}) {
  const { t, locale } = useI18n();
  const tz = me.project.timezone;
  const today = siteToday(tz);
  const [done, setDone] = useState<TodayCheckIn | null>(() =>
    recallToday(localStore(), me.device.deviceId, today),
  );
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [selfie, setSelfie] = useState<{ url: string; image: Blob } | null>(
    null,
  );
  const [staged, setStaged] = useState<SelfieUploadDto | null>(null);
  const [selfieOff, setSelfieOff] = useState(false);
  useEffect(
    () => () => {
      if (selfie) URL.revokeObjectURL(selfie.url);
    },
    [selfie],
  );
  const busy =
    session.busy || phase.kind === 'locating' || phase.kind === 'sending';

  const finish = (fix: CaptureFixDto | null, r: Outcome<CheckInResultDto>) => {
    if (r.kind === 'ok') {
      const v = r.value;
      const record: TodayCheckIn = {
        businessDate: v.businessDate,
        occurredAt: v.occurredAt,
        kind: v.kind,
        flags: v.flags,
        hasSelfie: v.hasSelfie,
        afterSubmission: v.afterSubmission,
        accuracyM: fix?.accuracyM ?? null,
      };
      rememberToday(localStore(), me.device.deviceId, record);
      setDone(record);
      setSelfie(null);
      setStaged(null);
      setPhase({ kind: 'idle' });
    } else if (r.kind === 'failed')
      setPhase({ kind: 'unsettled', code: r.code, what: 'checkin', fix });
    else {
      const existing =
        r.error instanceof FieldApiError ? r.error.existing : null;
      if (r.code === 'ALREADY_CHECKED_IN' && existing) {
        const record: TodayCheckIn = {
          businessDate: today,
          occurredAt: existing.occurredAt,
          kind: existing.kind,
          flags: [],
          hasSelfie: false,
          afterSubmission: false,
          accuracyM: null,
        };
        rememberToday(localStore(), me.device.deviceId, record);
        setDone(record);
      }
      // An expired or used selfie cannot be attached again: take a new one or go without.
      if (r.code === 'SELFIE_EXPIRED') setStaged(null);
      if (r.code === 'FEATURE_OFF') {
        setSelfieOff(true);
        setStaged(null);
        setSelfie(null);
      }
      setPhase({ kind: 'refused', code: r.code, fix });
    }
  };

  const checkIn = async () => {
    setPhase({ kind: 'locating' });
    const located = await locate(navigator.geolocation);
    if (!located.fix)
      return setPhase({ kind: 'noFix', reason: located.reason });
    const fix = located.fix;
    const now = Date.now();
    const check = checkFix(fix, now);
    if (check === 'coarse') return setPhase({ kind: 'coarse', fix });
    if (check === 'stale') return setPhase({ kind: 'stale' });
    const usable =
      staged && Date.parse(staged.expiresAt) > now ? staged.selfieId : null;
    const event = checkInEvent(fix, tz, now, usable);
    const key = crypto.randomUUID();
    setPhase({ kind: 'sending', fix });
    finish(
      fix,
      await session.act(
        () => ({
          key,
          send: () => api.checkIn(key, () => attempt(key, event, Date.now())),
        }),
        false,
      ),
    );
  };
  /** Resend the kept command unchanged (same key and event). */
  const retry = async (p: Unsettled) => {
    if (p.what === 'selfie')
      return afterUpload(await session.retry<SelfieUploadDto>());
    setPhase({ kind: 'sending', fix: p.fix });
    finish(p.fix, await session.retry<CheckInResultDto>());
  };
  const afterUpload = (r: Outcome<SelfieUploadDto>) => {
    if (r.kind === 'ok') {
      setStaged(r.value);
      setPhase({ kind: 'idle' });
    } else if (r.kind === 'failed')
      setPhase({ kind: 'unsettled', code: r.code, what: 'selfie', fix: null });
    else {
      if (r.code === 'FEATURE_OFF') {
        setSelfieOff(true);
        setSelfie(null);
      }
      setPhase({ kind: 'refused', code: r.code, fix: null });
    }
  };
  const pickSelfie = async (file: File | undefined) => {
    if (!file) return;
    setStaged(null);
    const image = await resizeJpeg(file, SELFIE_EDGE, SELFIE_MAX_BYTES, 0.8);
    if (!image)
      return setPhase({
        kind: 'refused',
        code: 'UNSUPPORTED_MEDIA',
        fix: null,
      });
    setSelfie({ url: URL.createObjectURL(image), image });
    const key = crypto.randomUUID();
    afterUpload(
      await session.act(
        () => ({ key, send: () => api.uploadSelfie(key, image) }),
        false,
      ),
    );
  };

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

  const selfieOn = me.settings.selfieEnabled && !selfieOff;
  return (
    <section className="card">
      <h2 className="blk">{t('checkinTitle')}</h2>
      {selfieOn && (
        <div className="selfie">
          {selfie && <img src={selfie.url} alt="" />}
          <label className={`ghost small${busy ? ' off' : ''}`}>
            {selfie ? t('fd_selfieRetake') : t('fd_selfieOptional')}
            <input
              type="file"
              accept="image/*"
              capture="user"
              hidden
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                void pickSelfie(f);
              }}
            />
          </label>
          {selfie && (
            <span className="muted small">
              {staged ? t('fd_selfieReady') : t('uploading')}
            </span>
          )}
        </div>
      )}
      <Status phase={phase} />
      {phase.kind === 'unsettled' ? (
        <button
          type="button"
          className="primary big"
          disabled={session.busy}
          onClick={() => void retry(phase)}
        >
          {t('retry')}
        </button>
      ) : (
        <button
          type="button"
          className="primary big"
          disabled={busy || (selfie !== null && !staged)}
          onClick={() => void checkIn()}
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

function Status({ phase }: { phase: Phase }) {
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
          <ErrorText code={phase.code} />
        </div>
      );
    case 'unsettled': {
      const key =
        phase.what === 'selfie' ? 'fd_selfieUnsettled' : 'fd_checkinUnsettled';
      return (
        <div className="banner warn" role="alert">
          {t(key)} <ErrorText code={phase.code} />
        </div>
      );
    }
  }
}
