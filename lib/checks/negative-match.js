// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * Check that responseText does NOT contain any of the forbidden substrings (case-insensitive).
 * @param {{responseText: string, mustNotContain: string[]}} input
 * @returns {import('./types.js').EvalResult}
 */
export function negativeMatch({ responseText, mustNotContain }) {
  const lower = responseText.toLowerCase();
  const found = mustNotContain.filter(s => lower.includes(s.toLowerCase()));
  if (found.length === 0) return { pass: true };
  return { pass: false, reason: `Forbidden content found: ${found.join(', ')}` };
}
