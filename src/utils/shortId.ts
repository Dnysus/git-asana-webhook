/**
 * Jira-style short-ID extraction (e.g. "CENG-1234") from branch names,
 * PR titles, and commit messages.
 */

/**
 * Default pattern: an uppercase project key (2+ chars) followed by a number.
 * Compiled case-insensitively so branches like `ceng-1234-fix-login` match.
 * Deliberately avoids the `g` flag — global regexes are stateful when reused.
 */
export const DEFAULT_SHORT_ID_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/i;

/**
 * Returns the first short-ID found across the candidate strings, checked in
 * order (callers should pass the most reliable source first, e.g. branch name
 * before PR title). Matches are normalised to uppercase so downstream Asana
 * lookups stay consistent regardless of how the branch was typed.
 */
export function extractShortId(
  pattern: RegExp,
  sources: ReadonlyArray<string | null | undefined>,
): string | null {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const match = source.match(pattern);
    if (match?.[0]) {
      return match[0].toUpperCase();
    }
  }
  return null;
}
