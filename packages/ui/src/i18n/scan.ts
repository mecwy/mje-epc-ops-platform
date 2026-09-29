/**
 * Finds message keys used in source text: the first argument of `t(...)` and the second of
 * `translate(...)`. Arguments are read with a bracket- and string-aware scanner, so nested
 * calls such as `translate(getLang(), 'key')` and spacing such as `t (`key`)` are handled.
 * A template literal with `${...}` is a dynamic key the guard cannot check and is reported.
 */
export interface ScanResult {
  keys: string[];
  /** character offsets of dynamic (template) keys */
  dynamic: number[];
}
const CALL = /\b(t|translate)\s*\(/g;
const QUOTES = new Set(["'", '"', '`']);

/** Splits the argument list starting right after '(' into raw argument strings. */
function args(text: string, start: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      current += c;
      if (c === '\\') {
        current += text[i + 1] ?? '';
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (QUOTES.has(c)) {
      quote = c;
      current += c;
    } else if ('([{'.includes(c)) {
      depth++;
      current += c;
    } else if (')]}'.includes(c)) {
      if (depth === 0) {
        out.push(current);
        return out;
      }
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += c;
  }
  return out;
}

export function scanTranslationCalls(text: string): ScanResult {
  const keys = new Set<string>();
  const dynamic: number[] = [];
  for (const m of text.matchAll(CALL)) {
    const list = args(text, m.index + m[0].length);
    const arg = list[m[1] === 't' ? 0 : 1]?.trim();
    if (!arg) continue;
    const literal = /^(['"`])([^'"`]*)\1$/.exec(arg);
    if (literal) {
      if (arg.includes('${')) dynamic.push(m.index);
      else keys.add(literal[2]!);
    }
  }
  return { keys: [...keys].sort(), dynamic };
}
