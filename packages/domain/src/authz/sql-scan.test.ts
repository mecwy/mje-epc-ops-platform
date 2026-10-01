/**
 * ADR-0003 D2.1 SQL text scan: a table owned by another module may appear in a module's SQL only
 * as a registered legacy adapter (legacy-adapters.ts); registered entries must still occur.
 * Tables are the Prisma models; comments are ignored.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ADAPTERS,
  MODULES,
  SHARED_TABLES,
  type ModuleName,
} from './legacy-adapters.js';

const src = fileURLToPath(new URL('../', import.meta.url));
const schema = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);
const models = new Set(
  [...schema.matchAll(/^model (\w+)/gm)].map((m) => m[1]!),
);
const sourceFiles = readdirSync(src).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts',
);

/** Quoted table names in the file's code (comments stripped). */
export function tablesIn(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [
    ...new Set(
      [...code.matchAll(/"(\w+)"/g)]
        .map((m) => m[1]!)
        .filter((t) => models.has(t)),
    ),
  ].sort();
}
const owner = new Map<string, ModuleName>();
for (const [name, spec] of Object.entries(MODULES) as [
  ModuleName,
  (typeof MODULES)[ModuleName],
][])
  for (const t of spec.tables) owner.set(t, name);
const moduleOf = (file: string) =>
  (Object.entries(MODULES) as [ModuleName, { files: string[] }][]).find(
    ([, m]) => m.files.includes(file),
  )?.[0];

/** Every (file, table) where a module's SQL names a table of another module. */
export function crossModule(files: Record<string, string>) {
  const found: { file: string; table: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    const module = moduleOf(file);
    for (const table of tablesIn(text)) {
      if ((SHARED_TABLES as readonly string[]).includes(table)) continue;
      if (owner.get(table) !== module) found.push({ file, table });
    }
  }
  return found;
}
const allowed = (f: { file: string; table: string }) =>
  LEGACY_ADAPTERS.some((l) => l.file === f.file && l.table === f.table);

describe('SQL table-name scan (ADR-0003 D2.1)', () => {
  const files = Object.fromEntries(
    sourceFiles.map((f) => [f, readFileSync(src + f, 'utf8')]),
  );
  it('every source file belongs to a module and every table to an owner', () => {
    expect(sourceFiles.filter((f) => !moduleOf(f))).toEqual([]);
    const named = [...owner.keys(), ...SHARED_TABLES];
    expect(named.filter((t) => !models.has(t))).toEqual([]);
    expect(new Set(named).size).toBe(named.length);
    const used = new Set(Object.values(files).flatMap(tablesIn));
    expect([...used].filter((t) => !named.includes(t))).toEqual([]);
  });
  it('a table of another module appears only as a registered legacy adapter', () => {
    expect(crossModule(files).filter((f) => !allowed(f))).toEqual([]);
  });
  it('every registered legacy adapter still occurs (remove it with the code)', () => {
    const found = crossModule(files);
    expect(
      LEGACY_ADAPTERS.filter(
        (l) => !found.some((f) => f.file === l.file && f.table === l.table),
      ),
    ).toEqual([]);
  });
  it('IssueStore.lag reads report history through the exit only (A7-0a)', () => {
    const issue = files['issue-store.ts']!;
    expect(
      tablesIn(issue).filter((t) =>
        ['DailyClose', 'Revision', 'PlanVersion'].includes(t),
      ),
    ).toEqual([]);
    expect(issue).toContain('reportReader.lagHistory(');
  });
});
