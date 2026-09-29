import { describe, expect, it } from 'vitest';
import { scanTranslationCalls } from './scan.js';

describe('translation call scanner', () => {
  it('reads keys from every supported call form', () => {
    const src = `
      t('a'); t("b"); t(\`c\`); t ('d-e'); t(
        'f.g', { n: 1 });
      translate(lang, 'h'); translate(getLang(), "i");
      translate(pick(a, b), \`j\`, { x: t('k') });
      format('no'); x.test('no2'); split("no3");
    `;
    expect(scanTranslationCalls(src).keys).toEqual([
      'a',
      'b',
      'c',
      'd-e',
      'f.g',
      'h',
      'i',
      'j',
      'k',
    ]);
  });
  it('reports dynamic template keys for both functions and ignores identifiers', () => {
    const src =
      't(`m.${part}`); translate(lang, `n.${part}`); t(key); translate(lang, keys[i]);';
    const r = scanTranslationCalls(src);
    expect(r.keys).toEqual([]);
    expect(r.dynamic).toHaveLength(2);
  });
});
