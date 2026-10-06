import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  LOCALES,
  MESSAGES,
  initialLang,
  isLang,
  translate,
  type Lang,
  type MessageKey,
} from '@mje/ui';

const PREF = 'mje-lang';
const QUANTITY_ENTRY = {
  zh: {
    quantity: '完成量',
    confirm: '确定',
    cancel: '取消',
    invalid: '数量格式错误',
  },
  en: {
    quantity: 'Completed quantity',
    confirm: 'Confirm',
    cancel: 'Cancel',
    invalid: 'Invalid quantity',
  },
} as const;

/** New quantity entry prioritizes Chinese/English; existing locale catalogues stay intact. */
export function quantityEntryText(lang: Lang) {
  return QUANTITY_ENTRY[lang === 'zh' ? 'zh' : 'en'];
}

export interface I18n {
  lang: Lang;
  locale: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Master-data labels may be message keys (TEST seed) or free text entered by the PM. */
  label: (text: string) => string;
  setLang: (lang: Lang) => void;
}
const Ctx = createContext<I18n | null>(null);

function savedLang(): unknown {
  try {
    return localStorage.getItem(PREF);
  } catch {
    return null;
  }
}
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    initialLang(savedLang(), navigator.languages ?? []),
  );
  const value = useMemo<I18n>(
    () => ({
      lang,
      locale: LOCALES[lang],
      t: (key, vars) => translate(lang, key, vars),
      label: (text) => {
        if (!Object.hasOwn(MESSAGES, text)) return text;
        // Checked above: the master-data label is an existing message key.
        const key = text as MessageKey;
        return translate(lang, key);
      },
      setLang: (next) => {
        if (!isLang(next)) return;
        setLangState(next);
        document.documentElement.lang = LOCALES[next];
        try {
          localStorage.setItem(PREF, next);
        } catch {
          /* preference only */
        }
      },
    }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
