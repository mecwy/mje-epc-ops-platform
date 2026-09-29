import { useEffect, useId, type ReactNode } from 'react';
import { isReported, isToken } from '@mje/domain/rules';
import { useI18n } from './i18n.js';
import { Icon } from './icons.js';

export function Chip({
  tone = '',
  children,
}: {
  tone?: '' | 'ok' | 'warn' | 'solid';
  children: ReactNode;
}) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

/** A reported number: a decimal typed by the user, or a token shown as a placeholder. */
export function NumInput({
  value,
  onChange,
  disabled,
  size = 'qty',
  id,
  label,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
  size?: 'qty' | 'sm' | 'cum';
  id?: string;
  label?: string;
}) {
  const { t } = useI18n();
  const v = value ?? '';
  const token = isToken(v);
  const invalid = !token && !isReported(v);
  return (
    <input
      id={id}
      className={`num ${size}${invalid ? ' bad' : ''}`}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={token ? '' : v}
      placeholder={token ? t(v) : ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 0 / unknown / n.a. as explicit choices; a set token can be cleared. */
export function TokenChips({
  value,
  onSet,
  disabled,
  extra,
}: {
  value: string | undefined;
  onSet: (v: string) => void;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  if (disabled) return null;
  const v = value ?? '';
  if (isToken(v))
    return (
      <div className="chips">
        <Chip tone="solid">{t(v)}</Chip>
        <button type="button" className="pill" onClick={() => onSet('')}>
          {t('clear')}
        </button>
      </div>
    );
  if (v) return extra ? <div className="chips">{extra}</div> : null;
  return (
    <div className="chips">
      {extra}
      <button type="button" className="pill" onClick={() => onSet('0')}>
        0
      </button>
      <button type="button" className="pill" onClick={() => onSet('unknown')}>
        {t('unknown')}
      </button>
      <button type="button" className="pill" onClick={() => onSet('na')}>
        {t('na')}
      </button>
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const labelId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('noscroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('noscroll');
    };
  }, [onClose]);
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <div className="sheet-h">
          <h2 id={labelId}>{title}</h2>
          <button
            type="button"
            className="icon"
            aria-label={t('close')}
            onClick={onClose}
          >
            <Icon.close />
          </button>
        </div>
        <div className="sheet-b">{children}</div>
      </div>
    </>
  );
}

export function Kv({
  label,
  children,
  top,
}: {
  label: string;
  children: ReactNode;
  top?: boolean;
}) {
  return (
    <div className={`kv${top ? ' top-line' : ''}`}>
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}
