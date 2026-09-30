// Checks that a pull request description has the four sections every PR must carry
// (AGENTS.md: requirement mapping and final behaviour, test commands and results, what was not
// tested, migration and rollback). A section may say "不适用" / "N/A" but must not be missing
// or empty. Reads the body from PR_BODY; prints only which sections are missing.
export const SECTIONS = [
  {
    name: 'requirement mapping and final behaviour / 需求映射与最终行为',
    heading: /最终行为|需求映射|requirement mapping|final behaviou?r/i,
  },
  {
    name: 'tests (commands and results) / 测试命令与结果',
    heading: /测试|验证|\btests?\b/i,
  },
  { name: 'not tested / 未测项', heading: /未测|not tested|untested/i },
  { name: 'migration and rollback / 迁移与回退', heading: /回退|rollback/i },
];

/** Returns the names of required sections that are missing or have an empty body. */
export function missingSections(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  // Split on markdown headings (## or ###); keep each heading with its content.
  const parts = [];
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      current = { heading: h[1], content: [] };
      parts.push(current);
    } else if (current) current.content.push(line);
  }
  const hasText = (lines) =>
    lines.some((l) => l.trim() && !/^<!--.*-->$/.test(l.trim()));
  return SECTIONS.filter(
    (s) => !parts.some((p) => s.heading.test(p.heading) && hasText(p.content)),
  ).map((s) => s.name);
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
