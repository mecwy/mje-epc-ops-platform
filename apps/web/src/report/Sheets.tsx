import { useState } from 'react';
import { NO_WORK_REASONS, type NoWorkReason } from '@mje/contracts';
import { LANGS, isLang, type MessageKey } from '@mje/ui';
import type { RevisionMeta } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { fmtTime } from './format.js';

const REASON_LABEL = {
  rest: 'nw_rest',
  weather: 'nw_weather',
  permit: 'nw_permit',
  other: 'nw_other',
} as const satisfies Record<NoWorkReason, MessageKey>;

export function NoWorkSheet({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (r: NoWorkReason, note: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState<NoWorkReason>('rest');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={t('noWork')} onClose={onClose}>
      <div className="seg" role="radiogroup" aria-label={t('noWork')}>
        {NO_WORK_REASONS.map((r) => {
          const reasonLabel = REASON_LABEL[r];
          return (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              className={reason === r ? 'on' : ''}
              onClick={() => setReason(r)}
            >
              {t(reasonLabel)}
            </button>
          );
        })}
      </div>
      <label className="field">
        <span>{t('noteOptional')}</span>
        <textarea
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary wide"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onSubmit(reason, note.trim());
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('submit')}
      </button>
    </Sheet>
  );
}

export function CorrectionSheet({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (reason: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={t('startCorrect')} onClose={onClose}>
      <label className="field">
        <span>{t('correctionReason')}</span>
        <textarea
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary wide"
        disabled={busy || !reason.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await onStart(reason.trim());
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        {t('startCorrect')}
      </button>
    </Sheet>
  );
}

export function MenuSheet({
  onClose,
  canCorrect,
  canCancel,
  revisions,
  timeZone,
  onCorrect,
  onCancel,
  onSignOut,
}: {
  onClose: () => void;
  canCorrect: boolean;
  canCancel: boolean;
  revisions: RevisionMeta[];
  timeZone: string;
  onCorrect: () => void;
  onCancel: () => void;
  onSignOut: (() => void) | null;
}) {
  const { t, lang, setLang, locale } = useI18n();
  return (
    <Sheet title={t('more')} onClose={onClose}>
      {canCorrect && (
        <button type="button" className="mitem" onClick={onCorrect}>
          {t('startCorrect')}
        </button>
      )}
      {canCancel && (
        <button type="button" className="mitem" onClick={onCancel}>
          {t('cancelCorrect')}
        </button>
      )}
      {revisions.length > 0 && (
        <>
          <h3>{t('history')}</h3>
          {revisions.map((r) => (
            <p key={r.n} className="small">
              {t('versionN', { n: r.n })} · {fmtTime(r.at, locale, timeZone)}
              {r.reason ? ` · ${r.reason}` : ''}
            </p>
          ))}
        </>
      )}
      <h3>{t('language')}</h3>
      <div className="langs">
        {Object.entries(LANGS).map(([code, name]) => (
          <button
            key={code}
            type="button"
            className={lang === code ? 'on' : ''}
            aria-pressed={lang === code}
            onClick={() => isLang(code) && setLang(code)}
          >
            {name}
          </button>
        ))}
      </div>
      {onSignOut && (
        <button type="button" className="mitem" onClick={onSignOut}>
          {t('signOut')}
        </button>
      )}
    </Sheet>
  );
}
