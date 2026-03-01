// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @typedef {Object} EvalResult
 * @property {boolean} pass
 * @property {string} [reason]
 */

/**
 * @typedef {Object} CheckSuiteResult
 * @property {boolean} pass - true only if all checks passed
 * @property {Object.<string, EvalResult>} checks - named check results
 * @property {number} total
 * @property {number} passed
 * @property {number} failed
 */

/**
 * @typedef {Object} RunChecksInput
 * @property {string} [responseText]
 * @property {string[]} [mustContain]
 * @property {string[]} [mustNotContain]
 * @property {string[]} [expectedTools]
 * @property {string[]} [actualTools]
 * @property {boolean} [nonEmpty]
 * @property {string[]} [copOutPhrases]
 * @property {number} [latencyMs]
 * @property {number} [maxLatencyMs]
 * @property {boolean} [jsonValid]
 * @property {Object} [schemaData]
 * @property {string[]} [requiredKeys]
 * @property {Object.<string, string>} [typeChecks]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {string|RegExp} [regexPattern]
 * @property {number} [actualToolCallCount]
 * @property {number} [minToolCalls]
 * @property {number} [maxToolCalls]
 * @property {number} [actualCost]
 * @property {number} [maxCost]
 */
