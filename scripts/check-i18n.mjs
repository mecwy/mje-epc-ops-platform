// ML-01 guard: every UI message key used in the web app exists with four non-empty translations.
// Reads the built module (pnpm build runs first in `pnpm check`); a cheap static scan that does not
// replace native review (ML-08).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { MESSAGES, LANGS } =
  await import('../packages/ui/dist/i18n/messages.js');
const failures = [];
const langs = Object.keys(LANGS);
if (langs.join(',') !== 'zh,en,sr,es')
  failures.push(`languages: ${langs.join(',')}`);
for (const [key, row] of Object.entries(MESSAGES)) {
  if (
    !Array.isArray(row) ||
    row.length !== 4 ||
    row.some((t) => typeof t !== 'string' || !t.trim())
  )
    failures.push(`${key}: needs four non-empty translations`);
}
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts'))
      files.push(p);
  }
};
try {
  walk('apps/web/src');
} catch {
  /* no web sources yet */
}
const used = new Set();
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z][\w.]*)'/g)) used.add(m[1]);
}
for (const key of used)
  if (!(key in MESSAGES))
    failures.push(`${key}: used in web but missing from messages`);
const total = Object.keys(MESSAGES).length;
if (!total) failures.push('no message keys found');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `i18n guard: ${total} keys × 4 languages; ${used.size} keys referenced by web.`,
  );
}
