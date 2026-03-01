// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{actual: number, min?: number, max?: number}} input
 * @returns {import('./types.js').EvalResult}
 */
export function toolCallCount({ actual, min, max }) {
  if (min !== undefined && actual < min) {
    return { pass: false, reason: `Tool call count ${actual} is below minimum ${min}` };
  }
  if (max !== undefined && actual > max) {
    return { pass: false, reason: `Tool call count ${actual} exceeds maximum ${max}` };
  }
  return { pass: true };
}
