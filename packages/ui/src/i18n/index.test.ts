import { describe, expect, it } from 'vitest';
import {
  LANGS,
  MESSAGES,
  initialLang,
  translate,
  type MessageKey,
} from './index.js';

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
    // a key the compiler would reject still degrades visibly at runtime
    expect(translate('es', 'no.such.key' as MessageKey)).toBe('no.such.key');
    // inherited object names are not message keys
    expect(translate('en', 'constructor' as MessageKey)).toBe('constructor');
  });
  it('inserts values literally: no replacement patterns, no re-scanning of inserted text', () => {
    expect(translate('en', 'tonightDue', { n: '$&' })).toBe('$& items to fill');
    expect(translate('en', 'tonightDue', { n: '{n}' })).toBe(
      '{n} items to fill',
    );
    // an unknown placeholder stays visible instead of vanishing
    expect(translate('en', 'tonightDue', {})).toBe('{n} items to fill');
    // an inserted value that looks like another placeholder is not expanded
    expect(translate('en', 'correctingBanner', { a: '{b}', b: 2 })).toBe(
      'Correcting v{b} → v2',
    );
  });
  it('picks the saved language first, then the browser suggestion, then zh', () => {
    expect(initialLang('sr', ['en-US'])).toBe('sr');
    expect(initialLang(null, ['es-ES', 'en'])).toBe('es');
    expect(initialLang('xx', ['de-DE'])).toBe('zh');
  });
});
