// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * Map a tool-forge eval case's `expect` object plus run metadata
 * to a RunChecksInput shape that runChecks() can consume.
 *
 * @param {Object} evalCase - the eval case object from the eval JSON file
 * @param {Object} runMeta - runtime data from executing the case
 * @param {string[]} runMeta.toolsCalled - actual tools called during execution
 * @param {string} runMeta.responseText - the model's response text
 * @param {number} [runMeta.latencyMs] - round-trip latency in ms
 * @param {number} [runMeta.cost] - actual cost in USD
 * @returns {import('./types.js').RunChecksInput}
 */
export function checkAdapter(evalCase, runMeta) {
  const expect = evalCase.expect ?? {};
  const { toolsCalled = [], responseText = '', latencyMs, cost } = runMeta;

  /** @type {import('./types.js').RunChecksInput} */
  const input = {};

  // Response text is needed for most content checks
  input.responseText = responseText;

  // Tool selection — exact match (strict mode via expectedTools/actualTools)
  // toolsAcceptable is handled separately via checkToolsAcceptable() below
  if (expect.toolsCalled !== undefined) {
    input.expectedTools = Array.isArray(expect.toolsCalled)
      ? expect.toolsCalled
      : [expect.toolsCalled];
    input.actualTools = toolsCalled;
  }

  // responseContains → mustContain (array of strings; every item must appear)
  if (expect.responseContains !== undefined) {
    input.mustContain = Array.isArray(expect.responseContains)
      ? expect.responseContains
      : [expect.responseContains];
  }

  // responseContainsAny — handled by callers via checkResponseContainsAnyGroups().
  // Normalization of flat string[] to string[][] is done inside that function.
  // No field is set on RunChecksInput for this (runChecks has no native anyOf check).

  // responseNotContains → mustNotContain
  if (expect.responseNotContains !== undefined) {
    input.mustNotContain = Array.isArray(expect.responseNotContains)
      ? expect.responseNotContains
      : [expect.responseNotContains];
  }

  // responseNonEmpty → nonEmpty check
  // The eval-runner treats "non-empty" as: text present OR at least one tool called.
  // RunChecksInput.nonEmpty is a simpler text-only flag; callers should also check
  // toolsCalled.length when the original semantics matter.
  if (expect.responseNonEmpty) {
    input.nonEmpty = true;
  }

  // requiresPreamble lives on evalCase directly (not inside expect).
  // If true and the model returned only tool calls (no text), the run should fail.
  // Map it to nonEmpty so the text-presence check fires.
  if (evalCase.requiresPreamble === true) {
    input.nonEmpty = true;
  }

  // Latency check
  if (latencyMs !== undefined && expect.maxLatencyMs !== undefined) {
    input.latencyMs = latencyMs;
    input.maxLatencyMs = expect.maxLatencyMs;
  }

  // Cost budget
  if (cost !== undefined && expect.maxCost !== undefined) {
    input.actualCost = cost;
    input.maxCost = expect.maxCost;
  }

  // Tool call count
  if (expect.minToolCalls !== undefined || expect.maxToolCalls !== undefined) {
    input.actualToolCallCount = toolsCalled.length;
    if (expect.minToolCalls !== undefined) input.minToolCalls = expect.minToolCalls;
    if (expect.maxToolCalls !== undefined) input.maxToolCalls = expect.maxToolCalls;
  }

  // jsonValid — check if response is valid JSON
  if (expect.jsonValid) {
    input.jsonValid = true;
  }

  // schemaData — validate response against a schema
  if (expect.schemaData !== undefined) {
    input.schemaData = expect.schemaData;
    input.requiredKeys = expect.requiredKeys ?? [];
    if (expect.typeChecks) input.typeChecks = expect.typeChecks;
  }

  // minLength / maxLength — response length bounds
  if (expect.minLength !== undefined) input.minLength = expect.minLength;
  if (expect.maxLength !== undefined) input.maxLength = expect.maxLength;

  // regexPattern — response must match pattern
  if (expect.regexPattern !== undefined) input.regexPattern = expect.regexPattern;

  // copOutPhrases — custom cop-out phrase list for nonEmpty check
  if (expect.copOutPhrases !== undefined) input.copOutPhrases = expect.copOutPhrases;

  return input;
}

/**
 * Handle the responseContainsAny case.
 *
 * In eval-runner, responseContainsAny is string[][] — an array of groups where
 * each group must contribute at least one match.  This mirrors that behaviour.
 *
 * @param {string} responseText
 * @param {string[][]} groups - each inner array is one group; at least one member
 *   of each group must appear in responseText (case-sensitive, same as eval-runner)
 * @returns {{ pass: boolean, reason?: string }}
 */
export function checkResponseContainsAnyGroups(responseText, groups) {
  if (!groups?.length) return { pass: true };

  // Normalize: flat string[] → [[...]] (single group). Grouped string[][] passes through.
  const normalized = Array.isArray(groups[0]) ? groups : [groups];

  const failures = [];
  for (const group of normalized) {
    if (!group.some((str) => responseText.includes(str))) {
      failures.push(`response should contain any of [${group.join(', ')}]`);
    }
  }

  if (failures.length === 0) return { pass: true };
  return { pass: false, reason: failures.join('; ') };
}

/**
 * Handle the toolsAcceptable case.
 *
 * toolsAcceptable is string[][] — an array of acceptable tool sets.  The run
 * passes if the actual tools called exactly match ANY of the acceptable sets.
 * The special token '__none__' inside an acceptable set means no tools called.
 *
 * @param {string[]} actualTools
 * @param {string[][]} acceptable
 * @returns {{ pass: boolean, reason?: string }}
 */
export function checkToolsAcceptable(actualTools, acceptable) {
  if (!acceptable?.length) return { pass: true };

  function setsEqual(a, b) {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const v of sa) if (!sb.has(v)) return false;
    return true;
  }

  const anyMatch = acceptable.some((set) => {
    if (set.includes('__none__') && actualTools.length === 0) return true;
    return setsEqual(set, actualTools);
  });

  if (anyMatch) return { pass: true };
  return {
    pass: false,
    reason: `tools: [${actualTools.join(', ')}] not in any acceptable set`
  };
}
