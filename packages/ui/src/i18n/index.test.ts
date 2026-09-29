import { describe, expect, it } from 'vitest';
import { LANGS, MESSAGES, initialLang, translate } from './index.js';

describe('i18n resources', () => {
  it('every key has four non-empty entries and consistent placeholders', () => {
    const langs = Object.keys(LANGS);
    expect(langs).toEqual(['zh', 'en', 'sr', 'es']);
    for (const [key, row] of Object.entries(MESSAGES)) {
      expect(row, key).toHaveLength(4);
      for (const text of row) expect(text.trim(), key).not.toBe('');
      const vars = row.map((t) =>
        [...t.matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1])
          .sort()
          .join(','),
      );
      expect(new Set(vars).size, `placeholders differ in ${key}`).toBe(1);
    }
  });
  it('translates with variables and falls back visibly', () => {
    expect(translate('en', 'tonightDue', { n: 3 })).toBe('3 items to fill');
    expect(translate('sr', 'nav_report')).toBe('Izveštaj');
    expect(translate('es', 'no.such.key')).toBe('no.such.key');
  });
  it('picks the saved language first, then the browser suggestion, then zh', () => {
    expect(initialLang('sr', ['en-US'])).toBe('sr');
    expect(initialLang(null, ['es-ES', 'en'])).toBe('es');
    expect(initialLang('xx', ['de-DE'])).toBe('zh');
  });
});
