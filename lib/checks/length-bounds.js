// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{responseText: string, minLength?: number, maxLength?: number}} input
 * @returns {import('./types.js').EvalResult}
 */
export function lengthBounds({ responseText, minLength, maxLength }) {
  const len = responseText.length;
  if (minLength !== undefined && len < minLength) {
    return { pass: false, reason: `Response length ${len} is below minimum ${minLength}` };
  }
  if (maxLength !== undefined && len > maxLength) {
    return { pass: false, reason: `Response length ${len} exceeds maximum ${maxLength}` };
  }
  return { pass: true };
}
