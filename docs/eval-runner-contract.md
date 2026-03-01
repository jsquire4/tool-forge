# Eval Runner Contract

> **Note:** tool-forge now ships a built-in eval runner (`lib/eval-runner.js`). Run evals with:
> ```bash
> node lib/index.js run --eval <path/to/evals.golden.json>
> ```
> This document specifies the assertion contract that the built-in runner (and any external runner) must satisfy.

This document specifies what a conforming eval runner must do. Tool-Forge ships eval case JSON, generation skills, and a built-in runner — this contract ensures any runner (built-in or custom) can execute the eval files the skills produce.

---

## Overview

```
                     ┌──────────────────┐
  eval JSON file  →  │                  │  → EvalSuiteResult JSON
  seed manifest   →  │   Eval Runner    │
  snapshot data   →  │                  │  → console summary
  agent endpoint  →  │                  │  → baseline diff (optional)
                     └──────────────────┘
```

The runner's job:
1. Load an eval file (golden or labeled JSON)
2. Resolve template tokens (`{{seed:*}}`, `{{snapshot:*}}`) in assertion values
3. Check metadata staleness (if envelope present)
4. For each case: send the message to the agent, capture the response, run assertions
5. Emit an `EvalSuiteResult` JSON file and a human-readable summary

---

## Input Contracts

### 1. Eval File Format

The runner must accept two formats:

**Envelope format** (preferred):
```json
{
  "metadata": { ... },
  "cases": [ ... ]
}
```

**Bare array format** (legacy/simple):
```json
[ ... ]
```

If the file is a bare array, treat it as `{ "metadata": null, "cases": [...] }`. Staleness checks are skipped when metadata is null.

### Eval Case Fields (selected)

| Field | Type | Description |
|-------|------|-------------|
| `stubs` | `{ [toolName]: object }` | Optional. Stub responses for each tool. Presence switches the runner from routing-only to stub-based multi-turn mode. |
| `maxTurns` | `number` | Optional. Max iterations of the LLM loop in stub mode. Default 5. |
| `noToolErrors` | `boolean` | See §3 noToolErrors — semantics differ between stub and routing-only modes. |

**Stub-based multi-turn execution:** When `stubs` is present, the runner runs a full multi-turn
loop — the model calls tools, stub results are fed back, and the loop continues until the model
produces a final text response or `maxTurns` is reached. Response assertions (`responseContains`,
`responseNonEmpty`, etc.) are checked against the **final** LLM response, not the first-turn text.

### 2. Agent Endpoint

The runner sends each eval case's `input.message` to an agent endpoint and captures:
- The full text response
- The list of tools called (tool names, in call order)
- Whether each tool call succeeded or errored
- Wall-clock latency

The endpoint interface (adapt to your stack):

```
AgentEndpoint {
  // EXTENSION POINT: Your agent's chat/invoke API
  //
  // HTTP example:
  //   POST /chat { message: string } → { response: string, toolCalls: ToolCallRecord[] }
  //
  // SDK example:
  //   agent.invoke({ message: string }) → { response: string, toolCalls: ToolCallRecord[] }

  send(message: string): Promise<AgentResponse>
}

AgentResponse {
  response:    string           // The agent's text response
  toolCalls:   ToolCallRecord[] // Tools called during this invocation
  durationMs:  number           // Wall-clock time from send to complete response
}

ToolCallRecord {
  name:      string                    // Tool name (e.g., "get_weather")
  success:   boolean                   // Did the tool execute without error?
  durationMs: number                   // Time for this individual tool call
  params:    Record<string, unknown>   // Arguments the model passed to the tool
}
```

### 3. Seed Manifest

A JSON file mapping stable domain values:

```json
{
  "holdings": {
    "equities": [
      { "symbol": "AAPL", "shares": 150, "name": "Apple Inc." }
    ]
  },
  "totals": {
    "portfolioValue": 125000
  }
}
```

The runner must locate the seed manifest. Convention: `evals/seed-manifest.json` in the project root, overridable via config or CLI flag.

### 4. Snapshot Data

A JSON object captured immediately before the eval run from live data sources. Same structure as seed, but values are volatile.

The runner must implement a snapshot capture function:

```
captureSnapshot(): Promise<SnapshotData>

// EXTENSION POINT: This is where you call your actual APIs to get current values.
// Example: fetch current portfolio value, current stock prices, etc.
// Returns a JSON object with the same path structure used in {{snapshot:*}} tokens.
```

If snapshot capture is not configured, `{{snapshot:*}}` tokens resolve to `null` and assertions using them are skipped with a warning.

---

## Template Token Resolution

### Path Syntax

Dot-separated keys, bracket notation for arrays:

```
{{seed:holdings.equities[0].symbol}}    → "AAPL"
{{seed:holdings.equities[0].shares}}    → 150
{{seed:totals.portfolioValue}}          → 125000
{{snapshot:prices.AAPL.current}}        → 178.50
```

### Resolution Algorithm

```
resolve(token, seedData, snapshotData):
  1. Parse the token: extract source ("seed" or "snapshot") and path
  2. Select the data source (seedData or snapshotData)
  3. Walk the path:
     - Split on "."
     - For each segment:
       - If segment matches /^(\w+)\[(\d+)\]$/, access object key then array index
       - Otherwise, access as object key
     - If any step yields undefined/null, return UNRESOLVED
  4. Convert the resolved value to string for assertion matching
     - Numbers: String(value) — no formatting, no currency symbols
     - Strings: as-is
     - Booleans: "true" / "false"
     - Objects/arrays: JSON.stringify(value)
  5. Return the resolved string
```

### Token Locations

Template tokens can appear in these assertion fields only:
- `responseContains` values
- `responseContainsAny` values (within inner arrays)
- `responseNotContains` values
- `toolParams[].value` values

Tokens never appear in `input.message`, `toolsCalled`, or `toolsAcceptable`.

### Missing Path Behavior

When a token resolves to UNRESOLVED:
- **In `responseContains`:** Skip this single assertion value. Log a warning. Do NOT fail the case.
- **In `responseContainsAny`:** Remove the unresolved value from its synonym group. If the entire group becomes empty, skip that group.
- **In `responseNotContains`:** Skip this single value. (An unresolvable negative assertion is safe to skip.)
- **In `toolParams[].value`:** Skip this single parameter assertion. Log a warning.

---

## Staleness Checks

When metadata is present on the eval file:

### Description Hash Check

```
1. Load the current tool definition from the registry
2. Compute: currentHash = sha256(tool.description).substring(0, 12)
3. Compare: currentHash vs metadata.descriptionHash
4. If different:
   - Emit warning: "Evals for {{toolName}} generated against description hash
     {{metadata.descriptionHash}}, current is {{currentHash}}. Results may not
     reflect current routing contract."
   - Do NOT skip the eval — still run it, but mark the result as stale
```

### Registry Size Check

```
1. Count current tools in the registry
2. Compare: currentSize vs metadata.registrySize
3. If currentSize > metadata.registrySize * 1.5 (50% growth):
   - Emit warning: "Registry has grown from {{metadata.registrySize}} to
     {{currentSize}} tools. Labeled evals may have under-specified
     toolsAcceptable sets."
```

### Tool Version Check

```
1. Load the current tool definition
2. Compare: tool.version vs metadata.toolVersion
3. If major version differs (e.g., 1.x.x vs 2.x.x):
   - Emit warning: "Tool {{toolName}} is version {{tool.version}}, evals were
     generated for {{metadata.toolVersion}}. Schema may have changed."
```

---

## Assertion Execution

For each eval case, run assertions in this order. Stop at first failure (short-circuit).

### 1. toolsCalled / toolsAcceptable

```
if expect.toolsCalled:
  actualNames = response.toolCalls.map(tc => tc.name)
  assert actualNames === expect.toolsCalled (exact match, order-sensitive)

if expect.toolsAcceptable:
  actualNames = response.toolCalls.map(tc => tc.name)
  // Special case: ["__none__"] means no tools should be called
  if expect.toolsAcceptable includes ["__none__"]:
    acceptableSets = expect.toolsAcceptable.filter(s => s !== ["__none__"])
    acceptableSets.push([])  // empty set = no tools called
  assert actualNames matches ANY of the acceptable sets (order-insensitive per set)

if expect.toolsNotCalled:
  actualNames = response.toolCalls.map(tc => tc.name)
  for each forbidden in expect.toolsNotCalled:
    assert forbidden NOT IN actualNames
```

### 2. toolParams (parameter-level assertions)

```
if expect.toolParams:
  for each paramAssertion in expect.toolParams:
    // Find the matching tool call
    toolCall = response.toolCalls.find(tc => tc.name === paramAssertion.tool)
    if !toolCall: skip (tool wasn't called — routing assertion already handles this)

    actualValue = toolCall.params[paramAssertion.paramName]
    resolvedExpected = paramAssertion.value
      ? resolveToken(paramAssertion.value, seed, snapshot)
      : null

    switch paramAssertion.assertion:
      case 'equals':
        assert String(actualValue) === resolvedExpected
      case 'contains':
        assert String(actualValue).includes(resolvedExpected)
      case 'oneOf':
        assert resolvedExpected.includes(String(actualValue))  // value is string[]
      case 'exists':
        assert actualValue !== undefined
      case 'notExists':
        assert actualValue === undefined
      case 'matches':
        assert new RegExp(resolvedExpected).test(String(actualValue))
```

**Agent endpoint requirement:** The `ToolCallRecord` must include a `params` field containing the arguments the model sent to the tool:

```
ToolCallRecord {
  name:      string
  success:   boolean
  durationMs: number
  params:    Record<string, unknown>  // The arguments the model passed
}
```

### 3. noToolErrors

The semantics depend on whether the eval case uses stubs:

**Stub-based mode** (eval case has a `stubs` field) — the built-in runner uses stubbed tool
results instead of real tool execution. `noToolErrors` fails if the model calls a tool that
has no entry in the `stubs` map. This catches model hallucinations of non-existent tools.

```
if expect.noToolErrors and case has stubs:
  for each tc in response.toolCalls:
    assert tc.name in case.stubs
```

**Routing-only mode** (no `stubs` field) — tools are never executed, so `noToolErrors`
is a no-op. The assertion is logically undefined when no execution occurs.

**Custom runners using real tool execution:**
```
if expect.noToolErrors:
  for each tc in response.toolCalls:
    assert tc.success === true
```

### 4. responseNonEmpty

```
if expect.responseNonEmpty:
  assert response.response.trim().length > 0
```

### 4. responseContains

```
if expect.responseContains:
  for each value in expect.responseContains:
    resolved = resolveToken(value, seed, snapshot)
    if resolved === UNRESOLVED: skip with warning
    assert response.response.includes(resolved)  // case-sensitive
```

### 5. responseContainsAny

```
if expect.responseContainsAny:
  for each group in expect.responseContainsAny:
    resolvedGroup = group.map(v => resolveToken(v, seed, snapshot)).filter(v => v !== UNRESOLVED)
    if resolvedGroup.length === 0: skip this group with warning
    assert resolvedGroup.some(v => response.response.includes(v))  // case-sensitive
```

### 6. responseNotContains

```
if expect.responseNotContains:
  for each value in expect.responseNotContains:
    resolved = resolveToken(value, seed, snapshot)
    if resolved === UNRESOLVED: skip
    assert !response.response.includes(resolved)  // case-sensitive
```

### 7. responseMatches (labeled evals only)

```
if expect.responseMatches:
  for each pattern in expect.responseMatches:
    regex = new RegExp(pattern)
    assert regex.test(response.response)
```

### 8. maxLatencyMs

```
if expect.maxLatencyMs:
  assert response.durationMs <= expect.maxLatencyMs
```

**Latency measurement definition:** Wall-clock time from the moment the runner sends the message to the agent endpoint to the moment the complete response (including all tool calls) is received. This is the user-perceived latency, not individual tool execution time.

### 9. maxTokens (labeled evals only)

```
if expect.maxTokens:
  tokenCount = estimateTokens(response.response)  // EXTENSION POINT: your tokenizer
  assert tokenCount <= expect.maxTokens
```

---

## Output Format

### EvalSuiteResult (file-level)

The runner must write this JSON to disk after each run:

```json
{
  "runId": "{{uuid}}",
  "timestamp": "{{ISO 8601}}",
  "tier": "golden | labeled",
  "toolName": "{{tool_name}}",
  "agentEndpoint": "{{endpoint URL or identifier}}",
  "metadata": {
    "toolVersion": "{{current tool version}}",
    "descriptionHash": "{{current description hash}}",
    "registrySize": "{{current registry size}}",
    "evalFileHash": "{{hash of the eval JSON file}}"
  },
  "stalenessWarnings": [
    "// ... any staleness warnings emitted during the run ..."
  ],
  "cases": [
    {
      "id": "gs-get-weather-001",
      "description": "trigger phrase — direct weather question",
      "passed": true,
      "durationMs": 1250,
      "assertionsRun": 6,
      "assertionsSkipped": 0,
      "details": {
        "toolsCalled": ["get_weather"],
        "responseLength": 142,
        "skippedTokens": []
      }
    },
    {
      "id": "gs-get-weather-002",
      "description": "trigger phrase — asking about temperature",
      "passed": false,
      "durationMs": 2100,
      "assertionsRun": 4,
      "assertionsSkipped": 1,
      "error": "responseContains: expected 'Tokyo' in response but not found",
      "details": {
        "toolsCalled": ["get_forecast"],
        "responseLength": 89,
        "skippedTokens": ["{{snapshot:prices.current}}"]
      }
    }
  ],
  "summary": {
    "totalCases": 6,
    "passed": 5,
    "failed": 1,
    "skippedAssertions": 1,
    "totalDurationMs": 8500,
    "estimatedCostUsd": 0.032
  },
  "baselineRunId": "{{previous run ID for diff, or null}}",
  "regressions": [
    "// ... cases that passed in baselineRunId but fail now ..."
  ],
  "newPasses": [
    "// ... cases that failed in baselineRunId but pass now ..."
  ]
}
```

### Console Summary

The runner should print a human-readable summary:

```
═══ get_weather — golden evals ════════════════════════════════════
  ✓ gs-get-weather-001  trigger phrase — direct weather question      1250ms
  ✓ gs-get-weather-002  trigger phrase — asking about temperature     1100ms
  ✓ gs-get-weather-003  trigger phrase — general conditions           1300ms
  ✓ gs-get-weather-004  rephrased — casual wording                    980ms
  ✗ gs-get-weather-005  no raw JSON leak                             2100ms
    → responseNotContains: found "fetchedAt" in response
  ✓ gs-get-weather-006  disambiguation — current not forecast        1200ms
───────────────────────────────────────────────────────────────────
  5/6 passed | 1 failed | 0 skipped assertions | 7930ms total
  ⚠ Description hash mismatch (generated: abc123, current: def456)
```

---

## Baseline Diffing

When `baselineRunId` is provided (from a previous run's `runId`):

1. Load the baseline `EvalSuiteResult` from disk
2. For each case in the current run:
   - If it passed in baseline and fails now → **regression** (add to `regressions`)
   - If it failed in baseline and passes now → **new pass** (add to `newPasses`)
   - If status unchanged → no note
3. Print regressions prominently in the console summary

This is the minimum viable A/B comparison. It does not require statistical significance testing — it answers the practical question: "Did my change break anything that was working?"

---

## Runner Configuration

The runner should accept configuration via file or CLI flags:

```json
{
  "agentEndpoint": "http://localhost:3000/chat",
  "seedManifestPath": "evals/seed-manifest.json",
  "snapshotEnabled": false,
  "outputDir": "evals/results/",
  "baselineRunId": null,
  "concurrency": 1,
  "timeoutMs": 60000,
  "toolRegistryPath": "tools/tools.exports.ts"
}
```

- **concurrency:** Number of eval cases to run in parallel. Default 1 (sequential). Increase for faster runs, but beware rate limits on the agent endpoint.
- **timeoutMs:** Overall timeout per case (not per assertion). If the agent doesn't respond within this window, the case fails with "timeout".
- **toolRegistryPath:** Path to the barrel file, used for staleness checks (reading current tool versions and descriptions).
