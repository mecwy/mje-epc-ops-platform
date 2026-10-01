/**
 * ADR-0003 D2.1 SQL scan. Every string the TypeScript parser sees in the domain and app sources
 * (string literals, templates, constant `+` concatenations and constants they reference, folded)
 * is checked when it looks like SQL: each table it names must be owned by the file's module, or
 * be a registered legacy adapter (legacy-adapters.ts, per operation) or kernel use; a table
 * position that cannot be resolved to a known name fails. Sources are discovered recursively and
 * every one must belong to a module. Registered entries that no longer occur fail too.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_TABLES,
  KERNEL_USES,
  LEGACY_ADAPTERS,
  MODULES,
  type ModuleName,
  type SqlOperation,
} from './legacy-adapters.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const schema = readFileSync(
  `${repo}packages/domain/prisma/schema.prisma`,
  'utf8',
);
const models = new Set(
  [...schema.matchAll(/^model (\w+)/gm)].map((m) => m[1]!),
);
const ROOTS = ['packages/domain/src/', 'apps/api/src/', 'apps/worker/src/'];

function discover(dir: string): string[] {
  return readdirSync(repo + dir).flatMap((name) => {
    const path = `${dir}${name}`;
    if (statSync(repo + path).isDirectory()) return discover(`${path}/`);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Marks a part of a string whose value is not known statically. */
const HOLE = '\uE000';
/** Every maximal string expression of a source, folded to its text (unknown parts as HOLE). */
export function stringsIn(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const
    )
      constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const fold = (node: ts.Expression, seen: Set<string>): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((s) => fold(s.expression, seen) + s.literal.text)
          .join('')
      );
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    )
      return fold(node.left, seen) + fold(node.right, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return fold(node.expression, seen);
    if (
      ts.isIdentifier(node) &&
      constants.has(node.text) &&
      !seen.has(node.text)
    )
      return fold(constants.get(node.text)!, new Set([...seen, node.text]));
    return HOLE;
  };
  const isString = (node: ts.Node) =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (isString(node.left) || isString(node.right)));
  const inner = (node: ts.Node) =>
    ts.isTemplateSpan(node.parent) ||
    (ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      isString(node.parent)) ||
    (ts.isParenthesizedExpression(node.parent) && isString(node.parent.parent));
  const out: string[] = [];
  const walk = (node: ts.Node) => {
    if (isString(node) && !inner(node))
      out.push(fold(node as ts.Expression, new Set()));
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|JOIN|WITH)\b/;
/** Keywords that can follow FROM / UPDATE / JOIN without naming a table. */
const NOT_A_TABLE = new Set(['SET', 'LATERAL', 'ONLY']);
export interface TableUse {
  table: string;
  op: SqlOperation;
}
/** Table uses of one SQL string; `unresolved` lists table positions with no known name. */
export function sqlTables(sql: string): {
  uses: TableUse[];
  unresolved: string[];
} {
  const uses: TableUse[] = [];
  const unresolved: string[] = [];
  const ctes = new Set(
    [
      ...sql.matchAll(
        /(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)("?\w+"?)\s+AS\s*\(/g,
      ),
    ].map((m) => m[1]!.replace(/"/g, '')),
  );
  const position =
    /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE|FROM|JOIN|INTO|TABLE)\s+((?:"[^"]*"|\w+|\uE000)\s*\.\s*)?("[^"]*"|\w+|\uE000|\()/g;
  for (const m of sql.matchAll(position)) {
    const keyword = m[1]!.replace(/\s+/g, ' ');
    const before = sql.slice(0, m.index).trimEnd();
    if (
      keyword === 'FROM' &&
      /\b(DISTINCT|EPOCH|YEAR|MONTH|DAY|HOUR)$/i.test(before)
    )
      continue;
    if (keyword === 'UPDATE' && /\b(FOR|DO)$/.test(before)) continue;
    const token = m[3]!;
    const write = ['INSERT INTO', 'DELETE FROM', 'UPDATE'].includes(keyword);
    if (m[2]?.includes(HOLE) || token === HOLE) {
      unresolved.push(m[0]);
      continue;
    }
    if (token === '(') continue;
    const name = token.replace(/"/g, '');
    if (models.has(name)) {
      uses.push({ table: name, op: write ? 'write' : 'read' });
      continue;
    }
    if (NOT_A_TABLE.has(token) || ctes.has(name) || /^pg_\w+$/.test(token))
      continue;
    // A function in FROM (unnest(...), jsonb_array_elements(...)) or the system catalog.
    const after = sql.slice((m.index ?? 0) + m[0].length);
    if (
      /^\s*\(/.test(after) ||
      /^(pg_catalog|information_schema)$/.test(
        m[2]?.replace(/[\s.]/g, '') ?? '',
      )
    )
      continue;
    unresolved.push(m[0]);
  }
  // Any other quoted model name in the statement (comma joins, subqueries) is a read.
  for (const m of sql.matchAll(/"(\w+)"/g))
    if (models.has(m[1]!) && !uses.some((u) => u.table === m[1]))
      uses.push({ table: m[1]!, op: 'read' });
  return { uses, unresolved };
}

const owner = new Map<string, ModuleName>();
for (const [name, spec] of Object.entries(MODULES) as [
  ModuleName,
  (typeof MODULES)[ModuleName],
][])
  for (const t of spec.tables) owner.set(t, name);
export const moduleOf = (file: string) =>
  (
    Object.entries(MODULES) as [ModuleName, (typeof MODULES)[ModuleName]][]
  ).find(
    ([, m]) =>
      m.files.includes(file) || (m.dirs ?? []).some((d) => file.startsWith(d)),
  )?.[0];

export interface Finding {
  file: string;
  table: string;
  op: SqlOperation;
}
/** Uses of tables the file's module does not own, and unresolved table positions. */
export function scan(files: Record<string, string>) {
  const foreign: Finding[] = [];
  const unresolved: { file: string; at: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    const module = moduleOf(file);
    for (const value of stringsIn(file, text)) {
      if (!SQL.test(value)) continue;
      const r = sqlTables(value);
      for (const at of r.unresolved) unresolved.push({ file, at });
      for (const u of r.uses)
        if (
          owner.get(u.table) !== module &&
          !foreign.some(
            (f) => f.file === file && f.table === u.table && f.op === u.op,
          )
        )
          foreign.push({ file, ...u });
    }
  }
  return { foreign, unresolved };
}
const registered = (f: Finding) =>
  LEGACY_ADAPTERS.some(
    (l) =>
      l.file === f.file &&
      l.table === f.table &&
      (l.access === 'write' || f.op === 'read'),
  ) ||
  KERNEL_USES.some(
    (k) => k.file === f.file && k.table === f.table && k.op === f.op,
  );

const sources = ROOTS.flatMap(discover).sort();
const files = Object.fromEntries(
  sources.map((f) => [f, readFileSync(repo + f, 'utf8')]),
);

describe('SQL table scan (ADR-0003 D2.1)', () => {
  it('discovers sources recursively; each belongs to one module; tables are models with one owner', () => {
    expect(sources.length).toBeGreaterThan(20);
    expect(sources.filter((f) => !moduleOf(f))).toEqual([]);
    const named = [...owner.keys()];
    expect(named.filter((t) => !models.has(t))).toEqual([]);
    expect(new Set(named).size).toBe(named.length);
  });
  it('every SQL table position resolves to a known name (or a registered typed parameter)', () => {
    const counts = new Map<string, number>();
    for (const u of scan(files).unresolved)
      counts.set(u.file, (counts.get(u.file) ?? 0) + 1);
    const allowed = new Map(DYNAMIC_TABLES.map((d) => [d.file, d.occurrences]));
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(allowed));
    for (const d of DYNAMIC_TABLES)
      for (const t of d.tables) expect(owner.get(t)).toBe(moduleOf(d.file));
  });
  it("another module's table appears only as a registered legacy adapter or kernel use", () => {
    expect(scan(files).foreign.filter((f) => !registered(f))).toEqual([]);
  });
  it('every registered entry still occurs (remove it with the code)', () => {
    const { foreign } = scan(files);
    expect(
      LEGACY_ADAPTERS.filter(
        (l) => !foreign.some((f) => f.file === l.file && f.table === l.table),
      ),
    ).toEqual([]);
    expect(
      KERNEL_USES.filter(
        (k) =>
          !foreign.some(
            (f) => f.file === k.file && f.table === k.table && f.op === k.op,
          ),
      ),
    ).toEqual([]);
  });
  it('IssueStore.lag reads report history through the exit only (A7-0a)', () => {
    const issue = 'packages/domain/src/issue-store.ts';
    expect(
      scan({ [issue]: files[issue]! }).foreign.filter((f) =>
        ['DailyClose', 'Revision', 'PlanVersion'].includes(f.table),
      ),
    ).toEqual([]);
    expect(files[issue]).toContain('reportReader.lagHistory(');
  });
});

/** Counter-examples (PR #51 review 2 and PM addendum): each must be caught. */
describe('SQL scan counter-examples', () => {
  const issue = 'packages/domain/src/issue-store.ts';
  const caught = (code: string, file = issue) => {
    const r = scan({ [file]: code });
    return r.unresolved.length > 0 || r.foreign.some((f) => !registered(f));
  };
  const cases: [string, string, string?][] = [
    ['plain literal', 'q(`SELECT 1 FROM "PlanVersion"`);'],
    [
      'escaped double quotes',
      'q("SELECT rows FROM \\"PlanVersion\\" WHERE true");',
    ],
    [
      'constant concatenation',
      'q(`SELECT rows FROM "${"Plan" + "Version"}"`);',
    ],
    [
      'concatenated constant',
      'const t = "Plan" + "Version";\nq(`SELECT rows FROM "${t}"`);',
    ],
    [
      'dynamic name',
      'function f(t: string) { return q(`SELECT rows FROM "${t}"`); }',
    ],
    [
      'after a URL on the same line',
      'const label = "https://TEST"; q(`SELECT 1 FROM "PlanVersion"`);',
    ],
    [
      'table alias',
      'q(`SELECT pv."rows" FROM "PlanVersion" pv WHERE pv."number" = 1`);',
    ],
    ['schema-qualified', 'q(`SELECT rows FROM public."PlanVersion"`);'],
    ['CTE', 'q(`WITH x AS (SELECT rows FROM "PlanVersion") SELECT * FROM x`);'],
    ['comma join', 'q(`SELECT 1 FROM "Issue" i, "PlanVersion" p`);'],
    [
      'write on a read-only adapter',
      'q(`UPDATE "ReportItem" SET active=false`);',
    ],
    [
      'nested store file',
      'q(`SELECT 1 FROM "Issue"`);',
      'packages/domain/src/nested/new-store.ts',
    ],
  ];
  for (const [name, code, file] of cases)
    it(name, () => {
      if (file) expect(moduleOf(file)).toBeUndefined();
      else expect(caught(code)).toBe(true);
    });
  it('and the legal forms pass', () => {
    expect(
      caught(
        'q(`SELECT 1 FROM "Issue" i JOIN "IssueNote" n ON true FOR UPDATE`);',
      ),
    ).toBe(false);
    expect(caught('q(`SELECT 1 FROM "ReportItem" WHERE active`);')).toBe(false);
  });
});
