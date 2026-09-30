import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '@mje/ui';

const root = join(import.meta.dirname);
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe('message placeholders', () => {
  it('a message with {placeholders} is never shown without its values', () => {
    const missing: string[] = [];
    for (const file of sources(root)) {
      const text = readFileSync(file, 'utf8');
      // t('key') closed right away: no values passed.
      for (const m of text.matchAll(/\bt\('([A-Za-z_0-9]+)'\)/g)) {
        const row = (MESSAGES as Record<string, readonly string[]>)[m[1]!];
        if (row?.some((s) => /\{\w+\}/.test(s)))
          missing.push(`${file.slice(root.length + 1)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
