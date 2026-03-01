// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

import { contentMatch } from './content-match.js';
import { negativeMatch } from './negative-match.js';
import { toolSelection } from './tool-selection.js';
import { latency } from './latency.js';
import { jsonValid } from './json-valid.js';
import { schemaMatch } from './schema-match.js';
import { nonEmpty } from './non-empty.js';
import { lengthBounds } from './length-bounds.js';
import { regexMatch } from './regex-match.js';
import { toolCallCount } from './tool-call-count.js';
import { costBudget } from './cost-budget.js';
import { noHallucinatedNumbers } from './no-hallucinated-numbers.js';

/**
 * Run all applicable checks based on what inputs are provided.
 * Only runs a check if the relevant input fields are present.
 * @param {import('./types.js').RunChecksInput} input
 * @returns {import('./types.js').CheckSuiteResult}
 */
export function runChecks(input) {
  const checks = {};

  if (input.mustContain?.length && input.responseText !== undefined) {
    checks.contentMatch = contentMatch({ responseText: input.responseText, mustContain: input.mustContain });
  }

  if (input.mustNotContain?.length && input.responseText !== undefined) {
    checks.negativeMatch = negativeMatch({ responseText: input.responseText, mustNotContain: input.mustNotContain });
  }

  if (input.expectedTools !== undefined && input.actualTools !== undefined) {
    checks.toolSelection = toolSelection({ expected: input.expectedTools, actual: input.actualTools, mode: input.toolSelectionMode });
  }

  if (input.latencyMs !== undefined && input.maxLatencyMs !== undefined) {
    checks.latency = latency({ latencyMs: input.latencyMs, maxLatencyMs: input.maxLatencyMs });
  }

  if (input.jsonValid && input.responseText !== undefined) {
    checks.jsonValid = jsonValid({ responseText: input.responseText });
  }

  if (input.schemaData && input.requiredKeys?.length) {
    checks.schemaMatch = schemaMatch({ data: input.schemaData, requiredKeys: input.requiredKeys, typeChecks: input.typeChecks });
  }

  if (input.nonEmpty && input.responseText !== undefined) {
    checks.nonEmpty = nonEmpty({ responseText: input.responseText, copOutPhrases: input.copOutPhrases });
  }

  if ((input.minLength !== undefined || input.maxLength !== undefined) && input.responseText !== undefined) {
    checks.lengthBounds = lengthBounds({ responseText: input.responseText, minLength: input.minLength, maxLength: input.maxLength });
  }

  if (input.regexPattern && input.responseText !== undefined) {
    checks.regexMatch = regexMatch({ responseText: input.responseText, pattern: input.regexPattern });
  }

  if (input.actualToolCallCount !== undefined && (input.minToolCalls !== undefined || input.maxToolCalls !== undefined)) {
    checks.toolCallCount = toolCallCount({ actual: input.actualToolCallCount, min: input.minToolCalls, max: input.maxToolCalls });
  }

  if (input.actualCost !== undefined && input.maxCost !== undefined) {
    checks.costBudget = costBudget({ actualCost: input.actualCost, maxCost: input.maxCost });
  }

  if (input.toolResults !== undefined && input.responseText !== undefined) {
    checks.noHallucinatedNumbers = noHallucinatedNumbers({
      responseText: input.responseText,
      toolResults: input.toolResults,
      tolerance: input.tolerance,
    });
  }

  const results = Object.values(checks);
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const pass = failed === 0;

  return { pass, checks, total: results.length, passed, failed };
}
