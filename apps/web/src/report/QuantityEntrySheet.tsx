import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';
import { flushSync } from 'react-dom';
import { isReported } from '@mje/domain/rules';
import { quantityEntryText, useI18n } from '../i18n.js';
import { NumInput, TokenChips } from '../ui.js';

type Context = { scope: string; value: string; locked: boolean };
type Decision =
  { kind: 'apply'; value: string } | { kind: 'invalid' } | { kind: 'dismiss' };

/** Temporary entry only; a context or source-value change must never overwrite another draft. */
export class QuantityEntrySession {
  private base: Context | null = null;
  value = '';

  open(context: Context): boolean {
    if (context.locked) return false;
    this.base = { ...context };
    this.value = context.value;
    return true;
  }

  edit(value: string) {
    if (this.base) this.value = value;
  }

  cancel() {
    this.base = null;
  }

  current(context: Context): boolean {
    return Boolean(
      this.base &&
      !context.locked &&
      this.base.scope === context.scope &&
      this.base.value === context.value,
    );
  }

  confirm(context: Context): Decision {
    if (!this.current(context)) {
      this.cancel();
      return { kind: 'dismiss' };
    }
    if (!isReported(this.value)) return { kind: 'invalid' };
    const value = this.value;
    this.cancel();
    return { kind: 'apply', value };
  }
}

export type QuantityEntryHandle = { open: () => void };

export function QuantityEntrySheet({
  ref,
  scope,
  title,
  unit,
  value,
  locked,
  onConfirm,
}: {
  ref: Ref<QuantityEntryHandle>;
  scope: string;
  title: string;
  unit: string;
  value: string | undefined;
  locked: boolean;
  onConfirm: (value: string) => void;
}) {
  const { lang } = useI18n();
  const copy = quantityEntryText(lang);
  const titleId = useId();
  const fieldId = useId();
  const errorId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const session = useRef(new QuantityEntrySession());
  const [input, setInput] = useState('');
  const [invalid, setInvalid] = useState(false);
  const sourceValue = value ?? '';
  const context: Context = { scope, value: sourceValue, locked };

  function close() {
    session.current.cancel();
    if (dialog.current?.open) dialog.current.close();
    document.body.classList.remove('noscroll');
  }

  useImperativeHandle(ref, () => ({
    open() {
      const node = dialog.current;
      if (!node || node.open || !session.current.open(context)) return;
      // Mount/update the existing numeric field inside the tap, then focus synchronously.
      // A delayed effect loses the user gesture needed by some mobile keyboards.
      flushSync(() => {
        setInput(sourceValue);
        setInvalid(false);
      });
      node.showModal();
      document.body.classList.add('noscroll');
      node.querySelector('input')?.focus();
    },
  }));

  useEffect(() => {
    if (dialog.current?.open && !session.current.current(context)) close();
  });

  useEffect(() => {
    const node = dialog.current;
    return () => {
      session.current.cancel();
      if (node?.open) {
        node.close();
        document.body.classList.remove('noscroll');
      }
    };
  }, []);

  function edit(next: string) {
    session.current.edit(next);
    setInput(next);
    setInvalid(false);
  }

  function confirm() {
    const decision = session.current.confirm(context);
    if (decision.kind === 'invalid') {
      setInvalid(true);
      dialog.current?.querySelector('input')?.focus();
      return;
    }
    close();
    if (decision.kind === 'apply' && decision.value !== sourceValue)
      onConfirm(decision.value);
  }

  return (
    <dialog
      ref={dialog}
      className="sheet fill-quantity-sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="sheet-h">
        <h2 id={titleId}>{title}</h2>
      </div>
      <div className="sheet-b">
        <label htmlFor={fieldId}>{copy.quantity}</label>
        <div
          className="fill-quantity-value"
          aria-describedby={invalid ? errorId : undefined}
        >
          <NumInput
            id={fieldId}
            value={input}
            onChange={edit}
            disabled={locked}
          />
          {unit && <span>{unit}</span>}
        </div>
        <TokenChips value={input} onSet={edit} disabled={locked} />
        {invalid && (
          <p id={errorId} role="alert" className="bad-t">
            {copy.invalid}
          </p>
        )}
        <div className="fill-quantity-actions">
          <button type="button" className="ghost" onClick={close}>
            {copy.cancel}
          </button>
          <button
            type="button"
            className="primary"
            disabled={locked}
            onClick={confirm}
          >
            {copy.confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}
