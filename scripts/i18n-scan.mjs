// Finds message keys used in web sources by parsing TypeScript, not by pattern matching:
// comments and ordinary strings are ignored, escapes are decoded, and comments or nested
// calls inside the argument list do not hide a key. Covered calls: t(key, …) and
// translate(lang, key, …). A key that is not a string literal is reported as dynamic;
// the guard fails on it (identifier keys must be typed MessageKey values instead).
import ts from 'typescript';

const KEY_ARG = { t: 0, translate: 1 };

/** @returns {{ keys: string[], dynamic: { line: number, text: string }[] }} */
export function scanTranslationCalls(source, fileName = 'source.tsx') {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const keys = new Set();
  const dynamic = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      Object.hasOwn(KEY_ARG, node.expression.text)
    ) {
      const arg = node.arguments[KEY_ARG[node.expression.text]];
      if (arg) {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
          keys.add(arg.text);
        else if (!ts.isIdentifier(arg) && !ts.isPropertyAccessExpression(arg))
          dynamic.push({
            line:
              file.getLineAndCharacterOfPosition(arg.getStart(file)).line + 1,
            text: arg.getText(file).slice(0, 60),
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { keys: [...keys].sort(), dynamic };
}
