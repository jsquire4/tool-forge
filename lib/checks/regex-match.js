// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{responseText: string, pattern: string|RegExp}} input
 * @returns {import('./types.js').EvalResult}
 */
export function regexMatch({ responseText, pattern }) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  if (regex.test(responseText)) return { pass: true };
  return { pass: false, reason: `Response did not match pattern: ${pattern}` };
}
