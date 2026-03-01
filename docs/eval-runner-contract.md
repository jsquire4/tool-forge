# Eval Runner Contract

> **Note:** agent-tool-forge now ships a built-in eval runner (`lib/eval-runner.js`). Run evals with:
> ```bash
> node lib/index.js run --eval <path/to/evals.golden.json>
> ```
> This document specifies the assertion contract that the built-in runner (and any external runner) must satisfy.

This document specifies what a conforming eval runner must do. Tool-Forge ships eval case JSON, generation skills, and a built-in runner — this contract ensures any runner (built-in or custom) can execute the eval files the skills produce.

---

## Overview

```
                     ┌──────────────────┐
  eval JSON file  →  │                  │  → SQLite results
  agent endpoint  →  │   Eval Runner    │  → console summary
                     └──────────────────┘
```

The runner's job:
1. Load an eval file (golden or labeled JSON bare array)
2. For each case: send the message to the agent, capture the response, run assertions
3. Store results in SQLite (`forge.db`) — standalone CLI runner only — and print a human-readable summary

---

## Input Contracts

### 1. Eval File Format

The built-in runner accepts **bare array format only**:

```json
[ { "id": "case-001", "input": { "message": "..." }, "expect": { ... } }, ... ]
```

Envelope format (`{ "metadata": { ... }, "cases": [...] }`) is planned for a future release and is not yet supported by the built-in runners.

### Eval Case Fields (selected)

| Field | Type | Description |
|-------|------|-------------|
| `stubs` | `{ [toolName]: object }` | Optional. Stub responses for each tool. Presence of at least one key activates stub-based multi-turn mode; an empty `{}` stays in routing-only mode. |
| `maxTurns` | `number` | Optional. Max iterations of the LLM loop in stub mode. Default 5. |
| `noToolErrors` | `boolean` | See §2 noToolErrors — semantics differ between stub and routing-only modes. |

Additional assertion fields supported in `expect` (all optional):

| Field | Type | Description |
|-------|------|-------------|
| `maxCost` | `number` | Fails if the turn's estimated cost (USD) exceeds this value. |
| `minToolCalls` | `number` | Minimum number of tool calls expected. |
| `maxToolCalls` | `number` | Maximum number of tool calls expected. |
| `jsonValid` | `boolean` | Fails if the response is not valid JSON. |
| `schemaData` | `object` | Response object to validate against `requiredKeys` and `typeChecks`. |
| `requiredKeys` | `string[]` | Keys that must be present in `schemaData`. Defaults to `[]`. |
| `typeChecks` | `object` | Map of key→type string for type validation in `schemaData`. |
| `minLength` | `number` | Minimum character length of the response. |
| `maxLength` | `number` | Maximum character length of the response. |
| `regexPattern` | `string` | Regex pattern the response must match. |
| `copOutPhrases` | `string[]` | Phrases whose presence causes the response to fail the non-empty check. |

**Stub-based multi-turn execution:** When `stubs` is present and non-empty, the runner runs a full multi-turn
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

> The following Seed Manifest, Snapshot, and Template Token sections describe planned features not yet implemented in the built-in runners.

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

> **Status: Future Work — not yet implemented.** The built-in runners do not currently parse or resolve `{{seed:*}}` or `{{snapshot:*}}` tokens. All assertion values are used as literal strings.

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

> **Status: Future Work — not yet implemented.** The built-in runners do not currently read eval file metadata or perform staleness checks.

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

For each eval case, all applicable assertions run — failures are **collected** (not short-circuited). The case fails if any assertion fails; all failure reasons are reported together.

### 1. toolsCalled / toolsAcceptable

```
if expect.toolsCalled:
  actualNames = response.toolCalls.map(tc => tc.name)
  assert actualNames === expect.toolsCalled (exact match, order-sensitive)

if expect.toolsAcceptable:
  actualNames = response.toolCalls.map(tc => tc.name)
  // Each set is a string[]. Special token '__none__' inside a set means no tools called.
  anyMatch = expect.toolsAcceptable.some(set => {
    if set.includes('__none__') and actualNames.length === 0: return true
    return set and actualNames contain the same tools (order-insensitive)
  })
  assert anyMatch
```

### 2. noToolErrors

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

### 3. responseNonEmpty

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

### 7. maxLatencyMs

```
if expect.maxLatencyMs:
  assert response.durationMs <= expect.maxLatencyMs
```

**Latency measurement definition:** Wall-clock time from the moment the runner sends the message to the agent endpoint to the moment the complete response (including all tool calls) is received. This is the user-perceived latency, not individual tool execution time.

---

## Planned Assertions (Not Yet Implemented)

These assertions are documented here for reference. They will be added in a future release.

### toolsNotCalled

Verifies that specific tools were NOT called during the agent turn:

```json
"expect": { "toolsNotCalled": ["get_forecast"] }
```

Fails if any tool in `toolsNotCalled` appears in the actual tools called.

### toolParams (parameter-level assertions)

Verifies that specific parameters were passed to tool calls:

```json
"expect": {
  "toolParams": [
    { "tool": "get_weather", "paramName": "city", "assertion": "equals", "value": "Paris" },
    { "tool": "get_weather", "paramName": "units", "assertion": "oneOf", "value": ["celsius", "metric"] }
  ]
}
```

Assertion types: `equals`, `contains`, `oneOf`, `exists`, `notExists`, `matches` (regex).

This requires the agent endpoint to return tool parameter values in `ToolCallRecord.params`.

---

## Output Format

### SQLite Storage (`lib/eval-runner.js`)

The standalone eval runner (`lib/eval-runner.js`) writes results to SQLite (`forge.db` or the path from `config.dbPath`):

- **`eval_runs`** table — one row per run: `tool_name`, `eval_type`, `total_cases`, `passed`, `failed`, `skipped`, `pass_rate`, `model`, `notes`
- **`eval_run_cases`** table — one row per case: `case_id`, `tool_name`, `status`, `reason`, `tools_called`, `latency_ms`, `model`, `input_tokens`, `output_tokens`

`pass_rate` is computed as `passed / (passed + failed)` — skipped cases are excluded from the denominator.

### In-Memory Summary (`lib/runner/index.js`)

The programmatic runner (`runEvalSuite`) returns results in memory — no file or SQLite write:

```json
{
  "total": 6,
  "passed": 5,
  "failed": 1,
  "skipped": 0,
  "passRate": 0.833,
  "p95LatencyMs": 2100,
  "totalCost": 0.00032,
  "cases": [
    { "id": "gs-001", "status": "passed", "reason": null },
    { "id": "gs-002", "status": "failed", "reason": "responseContains: expected 'Tokyo' not found" }
  ],
  "gates": { "pass": true, "results": [...] }
}
```

> **Note:** In fixture replay mode (`--replay`), `p95LatencyMs` and `totalCost` reflect only cases served live (not from cache). In a full-cache run both will be `0`.

### Console Summary (CLI runner)

```
✓ 5/5 passed (100.0%), p95 latency: 1300ms, est. cost: $0.000320
```

---

## Baseline Diffing

> **Status: Future Work — not yet implemented.** The built-in runners do not currently perform baseline diffing.

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
- **toolRegistryPath:** Intended for staleness checks (reading current tool versions). Not currently read by the built-in runners.
