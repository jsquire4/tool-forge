// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * Extract all numbers from a string.
 * @param {string} text
 * @returns {number[]}
 */
function extractNumbers(text) {
  const matches = text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? [];
  return matches.map(Number).filter(n => !isNaN(n));
}

/**
 * Extract all numbers from a value (recursively for objects/arrays).
 * @param {unknown} value
 * @returns {number[]}
 */
function extractNumbersDeep(value) {
  if (typeof value === 'number') return [value];
  if (typeof value === 'string') return extractNumbers(value);
  if (Array.isArray(value)) return value.flatMap(extractNumbersDeep);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(extractNumbersDeep);
  }
  return [];
}

/**
 * Check that numbers in responseText match numbers from toolResults (within tolerance).
 * @param {{responseText: string, toolResults: unknown, tolerance?: number}} input
 * @returns {{pass: boolean, hallucinated: number[], matched: number[], reason?: string}}
 */
export function noHallucinatedNumbers({ responseText, toolResults, tolerance = 0.01 }) {
  const responseNumbers = extractNumbers(responseText);
  const sourceNumbers = extractNumbersDeep(toolResults);

  const hallucinated = [];
  const matched = [];

  for (const num of responseNumbers) {
    // Check if this number is within tolerance of any source number
    const isMatched = sourceNumbers.some(src => {
      if (src === 0 && num === 0) return true;
      if (src === 0) return Math.abs(num) <= tolerance;
      return Math.abs(num - src) / Math.abs(src) <= tolerance;
    });

    if (isMatched) {
      matched.push(num);
    } else {
      hallucinated.push(num);
    }
  }

  if (hallucinated.length === 0) return { pass: true, hallucinated: [], matched };
  return {
    pass: false,
    hallucinated,
    matched,
    reason: `Hallucinated numbers not found in tool results: ${hallucinated.join(', ')}`,
  };
}
