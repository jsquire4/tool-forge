# Eval Case Interfaces

## GoldenEvalCase

Sends a known prompt through the full agent loop. Asserts on single-tool selection + response content. The routing sanity check.

```
GoldenEvalCase {
  id:          string    // Format: "gs-<toolname>-NNN"
  description: string    // What this case tests
  input: {
    message:   string    // The user prompt to send
  }
  expect: {
    toolsCalled:        string[]    // Exact tools that must be called
    noToolErrors:       boolean     // All tool calls succeed
    responseNonEmpty:   boolean     // Agent produced a response
    responseContains?:  string[]    // ALL must appear (exact values)
    responseContainsAny?: string[][] // At least one from EACH group
    responseNotContains?: string[]  // NONE may appear
    maxLatencyMs?:      number      // Response time budget
  }
}
```

### Field Semantics

- **toolsCalled** — Exact match. If you expect `["get_weather"]`, the agent must call exactly `get_weather` and no other tools.
- **noToolErrors** — Every tool call in the response has `success: true`. If any tool errored, the eval fails.
- **responseContains** — Substring match, case-sensitive. Use for exact values that prove the tool returned real data (dollar amounts, names, IDs).
- **responseContainsAny** — Each inner array is a synonym group. At least one member from each group must appear. Use for domain terms where multiple phrasings are acceptable.
- **responseNotContains** — Substring match, case-sensitive. Use to catch: cop-outs ("I don't know"), raw JSON leaks ("fetchedAt"), sensitive data ("API_KEY").

---

## LabeledEvalCase

Sends a message through the full agent loop. Tests tool routing under ambiguity, edge cases, and adversarial inputs.

```
LabeledEvalCase {
  id:          string    // Format: "ls-<toolname>-NNN"
  description: string    // What this case tests
  difficulty:  'straightforward' | 'ambiguous' | 'edge'
  input: {
    message:   string    // The user prompt to send
  }
  expect: {
    // Tool ROUTING assertions (use one of toolsCalled OR toolsAcceptable)
    toolsCalled?:      string[]    // Exact tools that must appear
    toolsAcceptable?:  string[][]  // Any of these tool sets is valid
    toolsNotCalled?:   string[]    // Tools that must NOT be called

    noToolErrors?:     boolean

    // Response quality assertions (all deterministic)
    responseNonEmpty?:     boolean
    responseContains?:     string[]
    responseContainsAny?:  string[][]
    responseNotContains?:  string[]
    responseMatches?:      string[]    // Regex patterns
    maxLatencyMs?:         number
    maxTokens?:            number      // Response token count ceiling
  }
}
```

### toolsCalled vs toolsAcceptable

- **toolsCalled** — Use for straightforward cases where the exact tool set is known. `["get_weather", "get_forecast"]` means both must be called.
- **toolsAcceptable** — Use for ambiguous cases where multiple strategies are valid. `[["get_weather"], ["get_weather", "get_forecast"]]` means either set is acceptable.
- Never use both on the same case.
- For edge cases where no tools should be called, use `toolsAcceptable: [["__none__"]]`.

### Difficulty Tiers

- **straightforward** — Clear multi-tool tasks. Obvious which tools to use and in what combination.
- **ambiguous** — Multiple valid interpretations or tool combinations. Tests the agent's judgment.
- **edge** — Adversarial inputs, prompt injection, off-topic, contradictions. Tests robustness.

---

## RegressionEvalCase

Captures a specific bug that was found and fixed. Immutable once created — never modified, only archived when no longer applicable.

```
RegressionEvalCase {
  id:          string    // Format: "rg-<toolname>-NNN"
  description: string    // "regression — <what the bug was>"
  difficulty:  'regression'
  createdAt:   string    // ISO 8601 — when this case was created
  bugRef:      string    // Issue number or commit hash of the fix
  input: {
    message:   string    // The exact prompt that triggered the bug
  }
  expect: {
    toolsCalled?:         string[]
    toolsAcceptable?:     string[][]
    noToolErrors?:        boolean
    responseNonEmpty?:    boolean
    responseContains?:    string[]    // Use seed-stable values only (no snapshots)
    responseContainsAny?: string[][]
    responseNotContains?: string[]
    maxLatencyMs?:        number
  }
}
```

### Key Properties

- **Immutable** — Never edited after creation. If the tool changes so much the case no longer applies, archive it.
- **Cheap to run** — Seed-stable assertions only (no `{{snapshot:*}}` tokens). Suitable for CI.
- **Not scaled** — No formula. One case per real bug, created ad-hoc.
- **Self-documenting** — `bugRef` links to the fix, so a failure immediately tells you what regressed.
- **Separate file** — Stored in `<toolname>.regression.json`, separate from golden and labeled.

---

## RubricEvalCase (Stub)

Reserved for scored multi-dimensional evaluation. Use for synthesis quality testing where deterministic assertions are insufficient — e.g., "did the agent coherently combine data from 3 tools into a useful response?"

```
RubricEvalCase {
  id:          string
  description: string
  input: { message: string }
  referenceData?: Record<string, unknown>  // Ground truth tool output for the judge
  rubric: {
    dimension: string    // e.g., "accuracy", "completeness", "safety"
    maxScore:  number    // Use 1 for binary (pass/fail), 3-5 for graded
    criteria:  string    // What each score level means
  }[]
}
```

### When to Use

- Multi-tool synthesis: "Did the response accurately integrate data from all called tools?"
- Response quality: "Is the response helpful and well-structured?" (not testable with substring matching)
- Safety nuance: "Did the response appropriately hedge on investment advice?"

### Implementation Notes

- Binary scoring (`maxScore: 1`) is more defensible than graded rubrics
- The `referenceData` field provides ground truth so the judge compares against real data, not its own knowledge
- Keep rubric evals in a separate tier — run deterministic evals first, rubric evals only when deterministic pass

---

## EvalCaseResult

The result of running a single eval case.

```
EvalCaseResult {
  id:          string
  description: string
  passed:      boolean
  durationMs:  number
  error?:      string              // Failure reason
  details?:    Record<string, any> // Extra info: tools called, response, etc.
}
```

## EvalSuiteResult

The result of running an entire eval suite.

```
EvalSuiteResult {
  runId:           string    // UUID — unique identifier for this run
  timestamp:       string    // ISO 8601
  tier:            'golden' | 'labeled' | 'regression'
  toolName:        string

  // Current state at run time (for staleness comparison)
  metadata: {
    toolVersion:     string
    descriptionHash: string    // sha256(description)[0:12]
    registrySize:    number
    evalFileHash:    string    // sha256(eval JSON file)[0:12]
  }

  stalenessWarnings: string[]  // Warnings from staleness checks

  cases:           EvalCaseResult[]

  summary: {
    totalCases:         number
    passed:             number
    failed:             number
    skippedAssertions:  number
    totalDurationMs:    number
    estimatedCostUsd?:  number
  }

  // Baseline diffing (optional — requires a previous runId)
  baselineRunId?:  string    // Previous run to compare against
  regressions:     string[]  // Case IDs that passed before, fail now
  newPasses:       string[]  // Case IDs that failed before, pass now
}
```

### Baseline Diffing

When `baselineRunId` is provided, the runner loads the previous `EvalSuiteResult` and compares:
- **Regression:** Passed in baseline, fails now → add to `regressions[]`
- **New pass:** Failed in baseline, passes now → add to `newPasses[]`
- **Unchanged:** No note

This is the minimum viable A/B comparison. It answers: "Did my change break anything that was working?"
