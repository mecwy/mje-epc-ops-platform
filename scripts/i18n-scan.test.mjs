import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanTranslationCalls } from './i18n-scan.mjs';

test('reads keys from every supported call form', () => {
  const src = `
    t('a'); t("b"); t(\`c\`); t ('d-e'); t(
      'f.g', { n: 1 });
    translate(lang, 'h'); translate(getLang(), "i");
    translate(pick(a, b), \`j\`, { x: t('k') });
    t(/* explanation */ 'l');
    translate(getLang(/* ) */), 'm');
    t('\\u006eav_report');
    format('no'); x.test('no2'); split("no3"); obj.t('no4');
  `;
  assert.deepEqual(scanTranslationCalls(src).keys, [
    'a',
    'b',
    'c',
    'd-e',
    'f.g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'nav_report',
  ]);
});

test('ignores comments and ordinary strings that look like calls', () => {
  const src = `
    // t('missing-comment')
    /* translate(lang, 'missing-block') */
    const example = "t('missing-string')";
    const tpl = \`t('missing-template')\`;
  `;
  const r = scanTranslationCalls(src);
  assert.deepEqual(r.keys, []);
  assert.deepEqual(r.dynamic, []);
});

test('reports template and computed keys as dynamic; typed identifiers are left to the compiler', () => {
  const src = [
    't(`m.${part}`);',
    'translate(lang, `n.${part}`);',
    't(`missing.${flag ? "a" : "b"}`);',
    "t(flag ? 'x' : 'y');",
    "t('p' + q);",
    't(key); t(props.key); translate(lang, keys[i]);',
  ].join('\n');
  const r = scanTranslationCalls(src);
  assert.deepEqual(r.keys, []);
  assert.deepEqual(
    r.dynamic.map((d) => d.line),
    [1, 2, 3, 4, 5, 6],
  );
});

test('parses TSX', () => {
  const r = scanTranslationCalls(
    'export const A = () => <button title={t("save")}>{t(\'cancel\')}</button>;',
    'a.tsx',
  );
  assert.deepEqual(r.keys, ['cancel', 'save']);
});
