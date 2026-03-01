// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * @typedef {Object} CaseComparison
 * @property {string} caseId
 * @property {'regression'|'improvement'|'unchanged'|'added'|'removed'} status
 * @property {number} [basePassRate]
 * @property {number} [comparePassRate]
 * @property {number} [baseMeanLatencyMs]
 * @property {number} [compareMeanLatencyMs]
 */

/**
 * @typedef {Object} RunSummary
 * @property {string} runId
 * @property {string} modelName
 * @property {number} passRate
 * @property {number} totalCases
 * @property {number} totalCost
 * @property {number} meanLatencyMs
 * @property {number} p95LatencyMs
 * @property {Object.<string, {passes: number, trials: number, latencies: number[]}[]>} cases
 */

/**
 * @typedef {Object} RunComparison
 * @property {RunSummary} base
 * @property {RunSummary} compare
 * @property {CaseComparison[]} cases
 * @property {number} regressions
 * @property {number} improvements
 * @property {number} unchanged
 * @property {number} added
 * @property {number} removed
 */

/**
 * @typedef {Object} ComparisonOptions
 * @property {number} [significanceThreshold] - min abs difference to count as regression/improvement (default 0.1)
 */
