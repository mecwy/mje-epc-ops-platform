/**
 * Language-neutral preset for the quality/safety "checked, no issue" button (ML-06).
 * The stored value is this code; each language renders it from the dictionary.
 */
export const CHECKED_NO_ISSUES = 'CHECKED_NO_ISSUES';

/**
 * What the button stored before the code existed: exactly this Chinese string. Kept only as a
 * read-time compatibility mapping. Stored data is never rewritten, so submitted snapshots keep
 * their original bytes and only the screen text changes.
 */
export const LEGACY_CHECKED_NO_ISSUES = '检查未见问题';

/** True only for the code or the exact legacy string; any other text is the user's own. */
export function isCheckedNoIssues(stored: string): boolean {
  return stored === CHECKED_NO_ISSUES || stored === LEGACY_CHECKED_NO_ISSUES;
}
