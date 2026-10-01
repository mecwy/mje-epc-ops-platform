/**
 * ADR-0003 D2.3: field classification is recursive and mandatory at compile time. Fixtures under
 * fixtures/ are compiled with the package's compiler options: the positive one must compile,
 * each negative one must fail on its line marked NEGATIVE (PR #51 review 4).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const configPath = fileURLToPath(
  new URL('../../tsconfig.json', import.meta.url),
);
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  fileURLToPath(new URL('../../', import.meta.url)),
);
function errorsOf(file: string) {
  const program = ts.createProgram([dir + file], {
    ...config.options,
    noEmit: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === dir + file)
    .map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1);
}
const negativeLines = (file: string) =>
  readFileSync(dir + file, 'utf8')
    .split('\n')
    .flatMap((l, i) => (l.includes('// NEGATIVE') ? [i + 1] : []));

describe('fields.ts typing (compile fixtures)', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('compiles the positive fixture', () => {
    expect(errorsOf('fields-positive.ts')).toEqual([]);
  });
  for (const file of files.filter((f) => f.startsWith('fields-negative-')))
    it(`rejects ${file} on its NEGATIVE line`, () => {
      const lines = negativeLines(file);
      expect(lines).toHaveLength(1);
      expect(errorsOf(file)).toContain(lines[0]);
    });
});
