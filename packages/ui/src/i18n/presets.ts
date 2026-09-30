/**
 * Language-neutral preset for the quality/safety "checked, no issue" button (ML-06).
 * The stored value is this code; each language renders it from the dictionary.
 */
export const CHECKED_NO_ISSUES = 'CHECKED_NO_ISSUES';

/**
 * What the button stored before the code existed: the "checked, no issues" dictionary text of
 * the language active at the click, exactly as it was at 4fb4ae2 (zh, en, sr, es). Kept as
 * frozen literals, not read from the dictionary, so later wording changes cannot alter which
 * stored values are recognised. Read-time compatibility mapping only: stored data is never
 * rewritten, so submitted snapshots keep their original bytes.
 */
export const LEGACY_CHECKED_NO_ISSUES = [
  '检查未见问题',
  'Checked, no issues',
  'Provereno, bez problema',
  'Revisado, sin incidencias',
] as const;

/** True only for the code or an exact legacy string; any other text is the user's own. */
export function isCheckedNoIssues(stored: string): boolean {
  return (
    stored === CHECKED_NO_ISSUES ||
    (LEGACY_CHECKED_NO_ISSUES as readonly string[]).includes(stored)
  );
}
