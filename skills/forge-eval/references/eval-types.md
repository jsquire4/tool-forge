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

## RubricEvalCase (Stub)

Reserved for scored multi-dimensional evaluation. Not yet proven in production.

```
RubricEvalCase {
  id:          string
  description: string
  input: { message: string }
  rubric: {
    dimension: string    // e.g., "accuracy", "completeness", "safety"
    maxScore:  number
    criteria:  string    // What each score level means
  }[]
}
```

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

The result of running an entire eval suite (golden or labeled).

```
EvalSuiteResult {
  tier:            'golden' | 'labeled'
  cases:           EvalCaseResult[]
  totalPassed:     number
  totalFailed:     number
  totalDurationMs: number
  estimatedCost?:  number
}
```
