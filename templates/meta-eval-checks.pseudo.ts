// ============================================================================
// Meta-Eval Checks — PSEUDO-CODE (uses readFile stub)
//
// A mechanical linter that runs AGAINST the eval JSON files themselves (not
// against an agent endpoint). Catches common generation failures before the
// evals are ever run. Checkable by a JSON linter — no LLM needed.
//
// Run this after /forge-eval generates cases and before committing them.
// ============================================================================

// ── Types ───────────────────────────────────────────────────────────────────

interface MetaEvalResult {
  file: string;
  tier: string;
  checks: CheckResult[];
  passed: boolean;
  summary: string;
}

interface CheckResult {
  rule: string;
  passed: boolean;
  details?: string;
  severity: 'error' | 'warning';
  caseId?: string;
}

// ── Rule Catalog ────────────────────────────────────────────────────────────

// RULE 1: Every golden eval must have at least 2 responseContains values
//
// WHY: A single responseContains value is weak evidence. If the eval only
// checks for "Paris" in a weather response, the LLM could generate "Paris"
// from the prompt without calling the tool. Two values (city + a data point)
// make it much harder to pass without the tool actually running.

function checkMinResponseContains(cases: any[], minCount: number = 2): CheckResult[] {
  const results: CheckResult[] = [];

  for (const evalCase of cases) {
    const contains = evalCase.expect?.responseContains ?? [];
    if (contains.length < minCount) {
      results.push({
        rule: 'min-response-contains',
        passed: false,
        severity: 'error',
        caseId: evalCase.id,
        details: `Has ${contains.length} responseContains values, need at least ${minCount}. ` +
                 `Add exact values that prove the tool returned real data.`
      });
    }
  }

  return results;
}

// RULE 2: No responseContains value may appear verbatim in the user prompt
//
// WHY: If the assertion value appears in the prompt, the LLM can echo it back
// without calling any tool. The eval would pass trivially. This is the most
// common failure mode in generated evals.
//
// EXAMPLE (bad):
//   prompt: "What's the weather in Paris?"
//   responseContains: ["Paris"]  ← "Paris" is in the prompt!
//
// EXAMPLE (good):
//   prompt: "What's the weather in Paris?"
//   responseContains: ["Paris", "°"]  ← "°" can't come from the prompt

function checkNoPromptEcho(cases: any[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const evalCase of cases) {
    const prompt = evalCase.input?.message?.toLowerCase() ?? '';
    const contains = evalCase.expect?.responseContains ?? [];

    // Check how many values are NOT in the prompt (non-trivial assertions)
    const nonTrivial = contains.filter(
      (v: string) => !prompt.includes(v.toLowerCase())
    );

    // Allow prompt values if there are ALSO non-trivial values
    if (nonTrivial.length === 0 && contains.length > 0) {
      results.push({
        rule: 'no-prompt-echo',
        passed: false,
        severity: 'error',
        caseId: evalCase.id,
        details: `All responseContains values appear in the prompt. ` +
                 `The LLM could pass this eval without calling the tool. ` +
                 `Add at least one value that can only come from tool output ` +
                 `(e.g., a temperature, a dollar amount, a timestamp).`
      });
    }
  }

  return results;
}

// RULE 3: Every declared overlap must have at least one ambiguous case with
//         toolsAcceptable containing both tools
//
// WHY: The overlap map declares which tools could be confused. If there's no
// ambiguous eval testing both tools, the overlap is declared but untested.

function checkOverlapCoverage(
  cases: any[],
  overlapMap: { tools: { tool: string; overlaps: { tool: string }[] }[] },
  toolName: string
): CheckResult[] {
  const results: CheckResult[] = [];

  const entry = overlapMap.tools.find(e => e.tool === toolName);
  if (!entry) return results;

  for (const overlap of entry.overlaps) {
    const hasAmbiguousCoverage = cases.some(c => {
      if (c.difficulty !== 'ambiguous') return false;
      if (!c.expect?.toolsAcceptable) return false;
      return c.expect.toolsAcceptable.some(
        (set: string[]) => set.includes(toolName) && set.includes(overlap.tool)
      );
    });

    if (!hasAmbiguousCoverage) {
      results.push({
        rule: 'overlap-coverage',
        passed: false,
        severity: 'error',
        caseId: undefined,
        details: `Overlap [${toolName} ↔ ${overlap.tool}] has no ambiguous case ` +
                 `with toolsAcceptable containing both. Add at least one.`
      });
    }
  }

  return results;
}

// RULE 4: Ambiguous cases must use toolsAcceptable, not toolsCalled
//
// WHY: An ambiguous case with exact toolsCalled defeats the purpose. Ambiguous
// means multiple strategies are valid — use toolsAcceptable to express that.

function checkAmbiguousUsesAcceptable(cases: any[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const evalCase of cases) {
    if (evalCase.difficulty !== 'ambiguous') continue;

    if (evalCase.expect?.toolsCalled && !evalCase.expect?.toolsAcceptable) {
      results.push({
        rule: 'ambiguous-uses-acceptable',
        passed: false,
        severity: 'warning',
        caseId: evalCase.id,
        details: `Ambiguous case uses toolsCalled (exact match) instead of ` +
                 `toolsAcceptable (multiple valid sets). Consider whether ` +
                 `alternative tool strategies would also be correct.`
      });
    }
  }

  return results;
}

// RULE 5: Edge cases should NOT have toolsCalled (they test boundary behavior)
//
// WHY: Edge cases (prompt injection, off-topic, general knowledge) test that
// the agent does NOT misroute. Most edge cases should use toolsAcceptable
// with [["__none__"]] or responseNotContains checks, not assert specific tools.

function checkEdgeCaseAssertions(cases: any[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const evalCase of cases) {
    if (evalCase.difficulty !== 'edge') continue;

    const hasNotContains = (evalCase.expect?.responseNotContains ?? []).length > 0;
    const hasAcceptable = evalCase.expect?.toolsAcceptable != null;

    if (!hasNotContains && !hasAcceptable) {
      results.push({
        rule: 'edge-has-negative-assertion',
        passed: false,
        severity: 'warning',
        caseId: evalCase.id,
        details: `Edge case has neither responseNotContains nor toolsAcceptable. ` +
                 `Edge cases should assert what SHOULDN'T happen (data leaks, ` +
                 `misrouting) or that no tool is called ([["__none__"]]).`
      });
    }
  }

  return results;
}

// RULE 6: No duplicate prompts across cases
//
// WHY: Duplicate prompts waste eval budget and don't increase coverage.

function checkNoDuplicatePrompts(cases: any[]): CheckResult[] {
  const results: CheckResult[] = [];
  const seen = new Map<string, string>(); // normalized prompt → first case ID

  for (const evalCase of cases) {
    const normalized = evalCase.input?.message?.toLowerCase().trim() ?? '';
    const existing = seen.get(normalized);
    if (existing) {
      results.push({
        rule: 'no-duplicate-prompts',
        passed: false,
        severity: 'warning',
        caseId: evalCase.id,
        details: `Prompt is identical to ${existing} (after normalization). ` +
                 `Use a different wording or remove this case.`
      });
    } else {
      seen.set(normalized, evalCase.id);
    }
  }

  return results;
}

// RULE 7: responseContainsAny groups should have 2+ members each
//
// WHY: A synonym group with 1 member is just a responseContains check. If you
// intended a synonym group, add at least one synonym. If you intended exact
// match, move it to responseContains.

function checkSynonymGroupSize(cases: any[]): CheckResult[] {
  const results: CheckResult[] = [];

  for (const evalCase of cases) {
    const groups = evalCase.expect?.responseContainsAny ?? [];
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].length < 2) {
        results.push({
          rule: 'synonym-group-size',
          passed: false,
          severity: 'warning',
          caseId: evalCase.id,
          details: `responseContainsAny group ${i} has only ${groups[i].length} member(s). ` +
                   `Add synonyms or move to responseContains.`
        });
      }
    }
  }

  return results;
}

// ── Self-Review Pass (Phase 8.5) ────────────────────────────────────────────
//
// This is NOT a mechanical check — it requires LLM judgment. Run this after
// the mechanical checks above pass. The skill asks itself:
//
//   "For each approved case, can the LLM answer this prompt from general
//    knowledge without calling any tool, and would it still pass all
//    assertions? If yes, the case is not testing tool routing."
//
// This check is advisory (the LLM may misjudge its own knowledge). Cases
// flagged here should be reviewed by the user, not auto-rejected.
//
// IMPLEMENTATION: Not pseudo-coded here because it requires an LLM call.
// The /forge-eval skill should include this as a step in its workflow:
//
//   After batch approval, before writing to disk:
//   For each case in the approved batch:
//     1. Extract the prompt and all assertion values
//     2. Ask: "Without any tool, could you produce a response containing
//        [assertion values] for this prompt?"
//     3. If yes → flag: "This case may pass without tool routing. Consider
//        adding a responseContains value that requires tool output."
//     4. Present flagged cases to the user for final decision

// ── Runner ──────────────────────────────────────────────────────────────────

function runMetaEvalChecks(
  evalFilePath: string,
  overlapMapPath?: string,
  toolName?: string
): MetaEvalResult {

  const raw = JSON.parse(readFile(evalFilePath));
  const cases = Array.isArray(raw) ? raw : raw.cases;
  const tier = Array.isArray(raw) ? 'unknown' : (raw.metadata?.tier ?? 'unknown');

  const checks: CheckResult[] = [];

  // Always run
  checks.push(...checkNoPromptEcho(cases));
  checks.push(...checkNoDuplicatePrompts(cases));
  checks.push(...checkSynonymGroupSize(cases));

  // Golden-specific
  if (tier === 'golden') {
    checks.push(...checkMinResponseContains(cases, 2));
  }

  // Labeled-specific
  if (tier === 'labeled' || tier === 'unknown') {
    checks.push(...checkAmbiguousUsesAcceptable(cases));
    checks.push(...checkEdgeCaseAssertions(cases));
  }

  // Overlap coverage (requires overlap map)
  if (overlapMapPath && toolName) {
    const overlapMap = JSON.parse(readFile(overlapMapPath));
    checks.push(...checkOverlapCoverage(cases, overlapMap, toolName));
  }

  const errors = checks.filter(c => !c.passed && c.severity === 'error');
  const warnings = checks.filter(c => !c.passed && c.severity === 'warning');
  const passed = errors.length === 0;

  const summary = [
    `${evalFilePath} (${tier}): ${cases.length} cases`,
    errors.length > 0 ? `  ✗ ${errors.length} errors` : '  ✓ No errors',
    warnings.length > 0 ? `  ⚠ ${warnings.length} warnings` : '  ✓ No warnings',
  ].join('\n');

  return { file: evalFilePath, tier, checks, passed, summary };
}

// ── Utility Stubs ───────────────────────────────────────────────────────────

function readFile(path: string): string { /* ... */ }
