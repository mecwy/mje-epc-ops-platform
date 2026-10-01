// @ts-check
// Checks that a pull request description has the four sections every PR must carry
// (AGENTS.md: requirement mapping and final behaviour, test commands and results, what was not
// tested, migration and rollback). A section may say "不适用" / "N/A" but must not be missing
// or empty. Reads the body from PR_BODY; prints only which sections are missing.
// Order matters: "not tested" is classified before "tests" so a heading such as "未测试项"
// counts only as the untested section.
export const SECTIONS = [
  {
    name: 'requirement mapping and final behaviour / 需求映射与最终行为',
    heading: /最终行为|需求映射|requirement mapping|final behaviou?r/i,
  },
  { name: 'not tested / 未测项', heading: /未测|未运行|not tested|untested/i },
  {
    name: 'tests (commands and results) / 测试命令与结果',
    heading: /测试|验证|\btests?\b/i,
  },
  { name: 'migration and rollback / 迁移与回退', heading: /回退|rollback/i },
];

/**
 * Markdown lines with HTML comments removed. Lines inside fenced code blocks are kept as content
 * but marked, so a heading inside a fence never counts as a heading.
 */
/**
 * @param {unknown} body
 * @returns {{ line: string, fenced: boolean }[]}
 */
export function visibleText(body) {
  const text = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?(-->|$)/g, '');
  const out = [];
  /** @type {string | null} */
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      else out.push({ line, fenced: true });
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    out.push({ line, fenced: false });
  }
  return out;
}

/** The section a heading belongs to (first match in SECTIONS order), or null. */
const classify = (/** @type {string} */ heading) =>
  SECTIONS.find((s) => s.heading.test(heading)) ?? null;

/** Returns the names of required sections that are missing or have an empty body. */
/** @param {unknown} body */
export function missingSections(body) {
  const lines = visibleText(body);
  /** @type {{ i: number, level: number, text: string }[]} */
  const headings = [];
  lines.forEach(({ line, fenced }, i) => {
    const h = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    // Both groups always participate in a match.
    if (h)
      headings.push({
        i,
        level: /** @type {string} */ (h[1]).length,
        text: /** @type {string} */ (h[2]),
      });
  });
  const filled = new Set();
  headings.forEach((h, k) => {
    const section = classify(h.text);
    if (!section || h.level < 2 || h.level > 3) return;
    // Content runs until the next heading of the same or a higher level (subsections count).
    const next = headings.slice(k + 1).find((n) => n.level <= h.level);
    const content = lines.slice(h.i + 1, next ? next.i : lines.length);
    // Fenced lines always count as content; outside fences a bare heading line does not.
    if (
      content.some(
        ({ line, fenced }) =>
          line.trim() && (fenced || !/^#{1,6}\s/.test(line)),
      )
    )
      filled.add(section);
  });
  return SECTIONS.filter((s) => !filled.has(s)).map((s) => s.name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = missingSections(process.env.PR_BODY);
  if (missing.length) {
    console.error(
      `PR description is missing required sections (use "不适用" / "N/A" where a section does not apply):\n- ${missing.join('\n- ')}\nSee .github/pull_request_template.md.`,
    );
    process.exit(1);
  }
  console.log('PR description has all required sections.');
}
