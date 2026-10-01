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
  // A one-file program: the checker binds each identifier lexically (shadowing, parameters,
  // imports); only a `const` with an initializer folds, anything else is unknown (HOLE).
  const path = `/${fileName}`;
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === path ? parsed : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (n) => n === path,
    readFile: () => undefined,
  };
  const program = ts.createProgram(
    [path],
    { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest },
    host,
  );
  const source = program.getSourceFile(path)!;
  const checker = program.getTypeChecker();
  const constant = (id: ts.Identifier): ts.Expression | undefined => {
    const decl = checker.getSymbolAtLocation(id)?.valueDeclaration;
    return decl &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const
      ? decl.initializer
      : undefined;
  };
  const fold = (node: ts.Expression, seen: Set<ts.Node>): string => {
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
    if (ts.isIdentifier(node)) {
      const init = constant(node);
      if (init && !seen.has(init)) return fold(init, new Set([...seen, init]));
    }
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
      out.push(fold(node as ts.Expression, new Set<ts.Node>()));
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** SQL keywords, any case (PostgreSQL keywords are case-insensitive); DO bodies included. */
const SQL =
  /\b(select|insert|update|delete|merge|truncate|from|join|with|execute|perform|call)\b|\bdo\s*(\$|')/i;
export interface TableUse {
  table: string;
  op: SqlOperation;
}
/** A lexical token of PostgreSQL SQL that can name a table. */
type Token =
  | { kind: 'word'; text: string }
  | { kind: 'ident'; text: string }
  | { kind: 'hole' }
  | { kind: 'punct'; text: string }
  /** A double-quoted model name found inside a single-quoted literal. */
  | { kind: 'literalUse'; table: string }
  /** Something the scan cannot decide statically: it fails (fail-closed). */
  | { kind: 'undecidable'; why: string };
/** Simple E'' escapes; any other backslash form (\x, octal, \u, \U) can spell a name. */
const E_SIMPLE: Record<string, string> = {
  "'": "'",
  '\\': '\\',
  n: '\n',
  t: '\t',
  b: '\b',
  f: '\f',
  r: '\r',
  '"': '"',
};
/**
 * A single-quoted literal starting at `start` ('…' or E'…'), fail-closed (Owner decision B on
 * PR #51): its value may be executed (DO '…', EXECUTE '…'), so every double-quoted model name
 * in it is a use; an unterminated literal, an escape that can spell characters (\x, octal,
 * \u), a run-time part, or an unbalanced double quote inside it is undecidable. An unquoted
 * name in a literal ('PlanVersion' as a label) is not a use: it cannot reach a quoted table.
 */
function literal(sql: string, start: number): { tokens: Token[]; end: number } {
  const escapes = sql[start] !== "'";
  let i = start + (escapes ? 2 : 1);
  let value = '';
  const tokens: Token[] = [];
  let closed = false;
  while (i < sql.length) {
    const c = sql[i]!;
    if (escapes && c === '\\') {
      const e = sql[i + 1] ?? '';
      if (e in E_SIMPLE) value += E_SIMPLE[e];
      else if (/[0-7xuU]/.test(e))
        tokens.push({
          kind: 'undecidable',
          why: `escape \\${e} in an E'' literal`,
        });
      else value += e;
      i += 2;
    } else if (c === "'" && sql[i + 1] === "'") {
      value += "'";
      i += 2;
    } else if (c === "'") {
      closed = true;
      i++;
      break;
    } else {
      value += c;
      i++;
    }
  }
  if (!closed)
    tokens.push({ kind: 'undecidable', why: 'unterminated literal' });
  if (value.includes(HOLE))
    tokens.push({
      kind: 'undecidable',
      why: 'run-time value inside a literal',
    });
  // A literal whose raw text holds a double quote is accepted only when simple: no comment,
  // escape, nested literal, concatenation, dollar or U& marker, and its quotes pair into names
  // (each a model name is a WRITE use; other names are not ours). Anything else is undecidable.
  // No attempt is made to recognise cleverer forms (L27): they fail by construction.
  const raw = sql.slice(start + (escapes ? 2 : 1), closed ? i - 1 : i);
  if (raw.includes('"')) {
    const marker = ['/*', '*/', '--', '\\', "''", '||', '$'].find((m) =>
      raw.includes(m),
    );
    const parts = raw.split('"');
    if (marker || /u&/i.test(raw) || parts.length % 2 === 0)
      tokens.push({
        kind: 'undecidable',
        why: `double quote in a literal that is not simple (${marker ?? (parts.length % 2 === 0 ? 'unpaired quote' : 'U&')})`,
      });
    else
      for (let k = 1; k < parts.length; k += 2)
        if (models.has(parts[k]!))
          tokens.push({ kind: 'literalUse', table: parts[k]! });
  }
  return { tokens, end: i };
}
/**
 * PostgreSQL lexical scan of a folded string (HOLE marks unknown parts): single-quoted
 * literals ('' escapes; E'' also backslash escapes; analysed by `literal`), double-quoted
 * identifiers ("" escapes), line comments and nested block comments. Dollar-quoted bodies
 * ($$…$$, $tag$…$tag$) are scanned as SQL (conservatively: they are usually function or DO
 * bodies). Unterminated forms and U&'' / U&"" escapes are undecidable and fail.
 */
export function sqlTokens(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) i++;
    else if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      let depth = 0;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      if (depth > 0)
        out.push({ kind: 'undecidable', why: 'unterminated block comment' });
    } else if ((c === 'U' || c === 'u') && next === '&') {
      out.push({ kind: 'undecidable', why: 'U& escape form' });
      i += 2;
    } else if (c === "'" || ((c === 'E' || c === 'e') && next === "'")) {
      const r = literal(sql, i);
      out.push(...r.tokens);
      i = r.end;
    } else if (c === '"') {
      let text = '';
      let closed = false;
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          text += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        } else text += sql[i++];
      }
      out.push(
        closed
          ? { kind: 'ident', text }
          : { kind: 'undecidable', why: 'unterminated quoted identifier' },
      );
    } else if (c === '$' && /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0)
        out.push({ kind: 'undecidable', why: 'unterminated dollar quote' });
      out.push(...sqlTokens(sql.slice(i + tag.length, end < 0 ? n : end)));
      i = end < 0 ? n : end + tag.length;
    } else if (c === HOLE) {
      out.push({ kind: 'hole' });
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))![0];
      out.push({ kind: 'word', text: m.toLowerCase() });
      i += m.length;
    } else if (c === '$' && /\d/.test(next ?? '')) {
      i++;
      while (i < n && /\d/.test(sql[i]!)) i++;
    } else {
      out.push({ kind: 'punct', text: c });
      i++;
    }
  }
  return out;
}
/** Table uses of one SQL string; `unresolved` lists table positions with no known name. */
export function sqlTables(text: string): {
  uses: TableUse[];
  unresolved: string[];
} {
  const tokens = sqlTokens(text);
  const uses: TableUse[] = [];
  const unresolved: string[] = [];
  const word = (k: number) => {
    const t = tokens[k];
    return t?.kind === 'word' ? t.text : undefined;
  };
  for (let k = 0; k < tokens.length; k++) {
    const w = word(k);
    if (!w) continue;
    // The second word of INSERT INTO / MERGE INTO / DELETE FROM / TRUNCATE TABLE is handled
    // with its first word.
    const prev = word(k - 1);
    if (
      (w === 'into' && (prev === 'insert' || prev === 'merge')) ||
      (w === 'from' && prev === 'delete') ||
      (w === 'table' && prev === 'truncate')
    )
      continue;
    // A table position: a keyword, optional ONLY, an optional schema, then the name. Unquoted
    // names fold to lower case in PostgreSQL and never reach a (quoted, PascalCase) model
    // table: they are not ours. A position whose name is not known statically is unresolved.
    let at = k + 1;
    let write = false;
    if (
      ((w === 'insert' || w === 'merge') && word(at) === 'into') ||
      (w === 'delete' && word(at) === 'from')
    ) {
      write = true;
      at++;
    } else if (w === 'truncate') {
      write = true;
      if (word(at) === 'table') at++;
    } else if (w === 'update') {
      if (['for', 'do', 'key'].includes(word(k - 1) ?? '')) continue;
      write = true;
    } else if (w === 'from') {
      if (
        ['distinct', 'epoch', 'year', 'month', 'day', 'hour'].includes(
          word(k - 1) ?? '',
        )
      )
        continue;
    } else if (!['join', 'into', 'table'].includes(w)) continue;
    if (word(at) === 'only') at++;
    let name = tokens[at];
    const dot = tokens[at + 1];
    // schema.name: the name follows the dot (an unknown schema stays the unresolved name).
    const unknownSchema =
      name?.kind === 'hole' ||
      (name?.kind === 'ident' && name.text.includes(HOLE));
    if (dot?.kind === 'punct' && dot.text === '.' && !unknownSchema)
      name = tokens[at + 2];
    if (!name) continue;
    if (
      name.kind === 'hole' ||
      (name.kind === 'ident' && name.text.includes(HOLE))
    ) {
      unresolved.push(
        `${w} ${name.kind === 'ident' ? `"${name.text}"` : HOLE}`,
      );
      continue;
    }
    if (name.kind === 'ident' && models.has(name.text))
      uses.push({ table: name.text, op: write ? 'write' : 'read' });
  }
  // Fail-closed literal rule: a model name inside a literal is counted as a WRITE (the
  // strictest operation, so a read-only adapter does not cover it); undecidable forms fail.
  for (const t of tokens) {
    if (t.kind === 'undecidable') unresolved.push(`undecidable: ${t.why}`);
    if (
      t.kind === 'literalUse' &&
      !uses.some((u) => u.table === t.table && u.op === 'write')
    )
      uses.push({ table: t.table, op: 'write' });
  }
  // Any other quoted model name in the statement (comma joins, subqueries) is a read.
  for (const t of tokens)
    if (
      t.kind === 'ident' &&
      models.has(t.text) &&
      !uses.some((u) => u.table === t.text)
    )
      uses.push({ table: t.text, op: 'read' });
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
  it('every SQL table position resolves to a known name (no exceptions)', () => {
    expect(scan(files).unresolved).toEqual([]);
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
    // PR #51 round 2
    ['lowercase keywords', 'q(`select * from "PlanVersion"`);'],
    [
      'UPDATE ONLY is a write',
      'q(`UPDATE ONLY "ReportItem" SET active=false`);',
    ],
    [
      'DELETE FROM ONLY is a write',
      'q(`delete from only "ReportItem" where true`);',
    ],
    [
      'comment before the table is still a write',
      'q(`UPDATE /* TEST */ "ReportItem" SET active=false`);',
    ],
    [
      'line comment before the table',
      'q(`INSERT INTO -- TEST\n "ReportItem"(key) VALUES($1)`);',
    ],
    [
      'shadowed constant in an inner scope',
      "const t = 'PlanVersion';\nfunction g() { const t = 'Issue'; return t; }\nq(`SELECT 1 FROM \"${t}\"`);",
    ],
    [
      'parameter in a table position',
      'function h(t: string) { return q(`select 1 from "${t}"`); }',
    ],
    // PR #51 round 3: comment markers inside literals must not hide a table
    [
      'line-comment marker in a string literal',
      'q(`SELECT \'--\' AS marker FROM "PlanVersion"`);',
    ],
    [
      'block-comment markers in string literals',
      "q(`SELECT '/*' AS m FROM \"PlanVersion\" WHERE '*/' = '*/'`);",
    ],
    [
      'real comment, then the table',
      'q(`SELECT 1 /* note */ FROM -- x\n "PlanVersion"`);',
    ],
    [
      'comment marker inside a dollar-quoted string',
      'q(`SELECT $$ -- not a comment $$ AS t FROM "PlanVersion"`);',
    ],
    // PM self-check (c): a dollar-quoted body is scanned as SQL, not skipped.
    [
      'query in a dollar-quoted DO body',
      'q(`DO $$ BEGIN PERFORM 1 FROM "PlanVersion"; END $$`);',
    ],
    [
      'quoted table only inside a dollar-quoted body',
      'q(`SELECT $$"PlanVersion"$$ FROM "Issue"`);',
    ],
    ['tagged dollar quote', 'q(`SELECT $a$ /* $a$ AS t FROM "PlanVersion"`);'],
    [
      'nested block comments',
      'q(`SELECT 1 /* outer /* inner */ still comment */ FROM "PlanVersion"`);',
    ],
    [
      "escaped quote in E'' string",
      "q(`SELECT E'\\\\' --' AS t FROM \"PlanVersion\"`);",
    ],
    [
      'doubled quote in a literal',
      "q(`SELECT 'it''s -- fine' AS t FROM \"PlanVersion\"`);",
    ],
    // Literal follow-up (Owner decision B, fail-closed): a double-quoted model name inside any
    // single-quoted literal is a use, counted as a WRITE; undecidable literals fail.
    [
      'round-4: executable SQL in a single-quoted DO body',
      `q(\`DO 'BEGIN PERFORM 1 FROM "PlanVersion"; END;'\`);`,
    ],
    [
      'round-4: EXECUTE of a literal inside a dollar body',
      `q(\`DO $$ BEGIN EXECUTE 'SELECT 1 FROM "PlanVersion"'; END; $$\`);`,
    ],
    [
      'a quoted model name in a data literal counts (fail-closed)',
      `q(\`SELECT '"PlanVersion"' AS label FROM "Issue"\`);`,
    ],
    [
      'a literal use of a read-only adapter table counts as a write',
      `q(\`DO 'BEGIN PERFORM 1 FROM "ReportItem"; END;'\`);`,
    ],
    [
      "a quoted model name in an E'' literal",
      `q(\`SELECT E'it\\\\'s "PlanVersion"' FROM "Issue"\`);`,
    ],
    ['an unterminated literal', `q(\`SELECT 'abc FROM "Issue"\`);`],
    [
      "a numeric escape in an E'' literal",
      `q(\`SELECT E'\\\\x22PlanVersion\\\\x22' FROM "Issue"\`);`,
    ],
    ["a U&'' escape literal", `q(\`SELECT U&'d\\\\0061t' FROM "Issue"\`);`],
    ['a lone double quote in a literal', `q(\`SELECT '5"' FROM "Issue"\`);`],
    [
      'a run-time value inside a literal',
      `function v(x: string) { return q(\`SELECT 1 FROM "Issue" WHERE k = '\${x}'\`); }`,
    ],
    ['an unterminated quoted identifier', `q(\`SELECT 1 FROM "Issue\`);`],
    ['an unterminated dollar body', `q(\`DO $$ BEGIN PERFORM 1; END;\`);`],
    ['an unterminated block comment', `q(\`SELECT 1 FROM "Issue" /* open\`);`],
    // Literal round 2 (L27: fail closed by construction): a literal with a double quote is
    // accepted only when simple; Codex round-1 examples and nested forms fail.
    [
      'quotes inside comments in a literal',
      `q(\`DO 'BEGIN /* " */ PERFORM 1 FROM "PlanVersion"; /* " */ END;'\`);`,
    ],
    [
      "nested E'' literal",
      `q(\`DO 'BEGIN EXECUTE E''SELECT 1 FROM \\\\"PlanVersion\\\\"''; END;'\`);`,
    ],
    [
      'nested literal built by concatenation',
      `q(\`DO 'BEGIN EXECUTE ''SELECT 1 FROM "'' || ''Plan'' || ''Version'' || ''"''; END;'\`);`,
    ],
    [
      "nested U&'' with a double quote",
      `q(\`DO 'BEGIN EXECUTE U&''"PlanVersion"''; END;'\`);`,
    ],
    [
      'newline-adjacent literal fragments',
      `q(\`SELECT '"Plan'\n'Version"' FROM "Issue"\`);`,
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
  it('an unquoted name in a literal, a comment, or an own table in a literal is not a cross-module use', () => {
    // Own-module table inside a literal: a (write) use of the module's own table.
    expect(caught(`q(\`DO 'BEGIN PERFORM 1 FROM "Issue"; END;'\`);`)).toBe(
      false,
    );
    // A nested literal ('') beside a double quote is not simple: fails closed even for an own table.
    expect(caught(`q(\`SELECT 'it''s "Issue"' AS t FROM "Issue"\`);`)).toBe(
      true,
    );
    expect(caught('q(`SELECT 1 FROM "Issue" -- see "PlanVersion"\n`);')).toBe(
      false,
    );
    // PM self-check (b): a table name only inside a string literal is not a use.
    expect(caught(`q(\`SELECT 'PlanVersion' AS label FROM "Issue"\`);`)).toBe(
      false,
    );
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
