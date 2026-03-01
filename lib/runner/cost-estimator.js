// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * Per-million-token costs for common models.
 * Format: { input: $/M tokens, output: $/M tokens }
 */
const MODEL_COSTS = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
};

/**
 * Compute the actual cost of a single LLM call from observed token counts.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelName
 * @returns {number} cost in USD
 */
export function computeActualCost(inputTokens, outputTokens, modelName) {
  const costs = MODEL_COSTS[modelName] ?? { input: 3, output: 15 };
  return (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;
}

/**
 * Estimate the cost of running an eval suite.
 * Assumes ~500 input tokens and ~200 output tokens per call (conservative estimate).
 * @param {number} caseCount - number of eval cases
 * @param {number} trialCount - number of trials per case
 * @param {string} modelName - model name (used for cost lookup)
 * @param {{avgInputTokens?: number, avgOutputTokens?: number}} [options]
 * @returns {{totalCalls: number, estimatedCostUsd: number, perCallCostUsd: number, modelName: string, summary: string}}
 */
export function estimateCost(caseCount, trialCount, modelName, options = {}) {
  const { avgInputTokens = 500, avgOutputTokens = 200 } = options;
  const totalCalls = caseCount * trialCount;

  const costs = MODEL_COSTS[modelName] ?? { input: 3, output: 15 }; // default to claude-sonnet-4-6 pricing

  const inputCostPer1M = costs.input;
  const outputCostPer1M = costs.output;

  const totalInputTokens = totalCalls * avgInputTokens;
  const totalOutputTokens = totalCalls * avgOutputTokens;

  const estimatedCostUsd =
    (totalInputTokens / 1_000_000) * inputCostPer1M +
    (totalOutputTokens / 1_000_000) * outputCostPer1M;

  const perCallCostUsd = totalCalls > 0 ? estimatedCostUsd / totalCalls : 0;

  const summary = `${totalCalls} calls × ${modelName} ≈ $${estimatedCostUsd.toFixed(4)} USD (est. ${avgInputTokens}in/${avgOutputTokens}out tokens/call)`;

  return {
    totalCalls,
    estimatedCostUsd,
    perCallCostUsd,
    modelName,
    summary,
  };
}
