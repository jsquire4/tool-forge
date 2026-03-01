// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * Check that responseText contains all required substrings (case-insensitive).
 * @param {{responseText: string, mustContain: string[]}} input
 * @returns {import('./types.js').EvalResult}
 */
export function contentMatch({ responseText, mustContain }) {
  const lower = responseText.toLowerCase();
  const missing = mustContain.filter(s => !lower.includes(s.toLowerCase()));
  if (missing.length === 0) return { pass: true };
  return { pass: false, reason: `Missing from response: ${missing.join(', ')}` };
}
