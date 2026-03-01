// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{actualCost: number, maxCost: number}} input
 * @returns {import('./types.js').EvalResult}
 */
export function costBudget({ actualCost, maxCost }) {
  if (actualCost <= maxCost) return { pass: true };
  return { pass: false, reason: `Cost $${actualCost.toFixed(6)} exceeded budget $${maxCost.toFixed(6)}` };
}
