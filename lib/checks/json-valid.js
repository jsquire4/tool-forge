// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{responseText: string}} input
 * @returns {import('./types.js').EvalResult}
 */
export function jsonValid({ responseText }) {
  try {
    JSON.parse(responseText);
    return { pass: true };
  } catch (e) {
    return { pass: false, reason: `Invalid JSON: ${e.message}` };
  }
}
