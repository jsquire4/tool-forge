# Integration Plan: Close the E2E Eval Loop
## Incorporating evalkit (checks) + agent-eval-kit (fixtures, gates, comparison) into tool-forge

**Date:** 2026-02-28
**Status:** Pending approval

---

## Chosen Approach

Convert and lift targeted modules from two open-source projects (evalkit by [Author A] and
agent-eval-kit by [Author B]) into tool-forge as plain JavaScript. Replace the homegrown
`checkAssertions()` function in `lib/eval-runner.js` with evalkit's composable check system.
Add record/replay fixtures, gate evaluation, and run comparison alongside it. Wire all three
surfaces: TUI menu item, CLI `run` command, and a programmatic `runEvalSuite(path, agentFn)`
export. Credit both authors with in-file headers on every lifted module and a dedicated
"Standing on Shoulders" section in the README.

**What is NOT changing:** The forge-tool skill, forge-eval skill, ToolDefinition shape, HITL
engine, drift monitor, SQLite schema (additive changes only), or MCP server. The forge still
generates eval JSON; this plan is exclusively about executing that JSON.

---

## Attribution Strategy

### In every lifted/adapted file — top of file, before any imports:
```js
/**
 * Adapted from [project name] by [Author Name]
 * Source: https://github.com/[repo]
 * License: MIT
 * Original file: src/[path/to/original.ts]
 *
 * Changes from original:
 * - Converted from TypeScript to plain JavaScript
 * - [any other changes]
 */
```

### In README.md — new top-level section "Standing on Shoulders":
```markdown
## Standing on Shoulders

tool-forge's eval runner is built on work from two open-source projects:

- **[evalkit](link)** by [Name] — the deterministic check system (`lib/checks/`)
- **[agent-eval-kit](link)** by [Name] — record/replay fixtures and gate evaluation
  (`lib/fixtures/`, `lib/runner/gate.js`, `lib/comparison/`)

The forge skills generate eval JSON; their execution layers make it runnable.
Their projects are worth a look on their own terms.
```

---

## 1. Testing Strategy

### Test categories needed

**Unit tests (Vitest, co-located with source — `foo.js` → `foo.test.js`):**
- Every converted check function: happy path + failure case + edge (empty input, undefined, wrong type)
- `runChecks()` meta-runner: verify conditional execution (no tools input → tool check skipped)
- `checkAdapter()`: verify every tool-forge `expect` field maps correctly to evalkit input shape
- `fixture-store.js`: write → read → hit/miss/stale discrimination; `sortKeysDeep()` determinism
- `gate.js`: each gate type (passRate, p95LatencyMs) pass + fail + missing-gates early-return
- `compare.js`: regression detection, improvement detection, added/removed cases, sort order
- `statistics.js`: Wilson interval formula (known values), flakiness detection

**Integration tests (`lib/integration/` or `tests/`):**
- Full pipeline: load a tool-forge golden eval JSON → run against a mock agent → assertions pass →
  results persist to SQLite
- Gate rejection: eval run with 60% pass rate fails passRate: 0.8 gate; process.exitCode = 1
- Fixture round-trip: record a run → replay from fixture → identical results, no agent call

**Existing tests must remain green:** run `npm test` before and after each track.

### Test infrastructure
- Mock agent function: `(input) => ({ responseText: '...', toolsCalled: ['x'], latencyMs: 50 })`
- Mock eval JSON fixture: minimal golden eval with 3 cases covering pass/fail/edge
- Better-sqlite3 is synchronous — no async test utilities needed for DB assertions

### Acceptance criteria
- [ ] All 11 evalkit checks have passing unit tests
- [ ] `checkAdapter()` has 1:1 test for every `expect` field in tool-forge eval format
- [ ] Full pipeline integration test passes end-to-end
- [ ] Gate produces non-zero exit code on failure
- [ ] Fixture replay produces identical pass/fail results to live run
- [ ] Run comparison correctly identifies at least one regression and one improvement in test data
- [ ] `npm test` passes (all existing tests green)

---

## 2. Implementation Plan

### New directory structure
```
lib/
  checks/           ← NEW (from evalkit)
    types.js        ← JSDoc @typedef blocks (was types.ts)
    content-match.js
    negative-match.js
    tool-selection.js
    latency.js
    json-valid.js
    schema-match.js
    non-empty.js
    length-bounds.js
    regex-match.js
    tool-call-count.js
    cost-budget.js
    run-checks.js   ← meta-runner (conditional check orchestration)
    index.js        ← barrel export
    check-adapter.js ← NEW glue: maps tool-forge expect → evalkit input
  fixtures/         ← NEW (from agent-eval-kit)
    fixture-store.js
    index.js
  comparison/       ← NEW (from agent-eval-kit)
    compare.js
    format.js       ← uses chalk (already installed) instead of picocolors
    statistics.js
    index.js
  runner/           ← NEW
    gate.js         ← from agent-eval-kit (trivial conversion)
    index.js        ← programmatic API export: runEvalSuite(path, agentFn)
```

### Files modified
| File | Change |
|---|---|
| `lib/eval-runner.js` | Replace `checkAssertions()` with `runChecks()` + `checkAdapter()`; add fixture recording/replay; add gate evaluation at end of run |
| `lib/views/main-menu.js` | Add `{ key: 'run-evals', label: 'Run Evals', icon: '▶' }` menu item |
| `lib/index.js` | Add `run` CLI command: `node lib/index.js run --eval <path> [--record] [--replay] [--suite <name>]` |
| `forge.config.json` | Add `agent` block (see config schema below) and `gates` defaults |
| `lib/config-schema.js` | Add agent + gates validation |
| `README.md` | Add "Standing on Shoulders" section; update CLI docs |

### New forge.config.json fields
```json
{
  "agent": {
    "endpoint": "http://localhost:3000/chat",
    "method": "POST",
    "headers": { "Authorization": "Bearer ${AGENT_KEY}" },
    "inputField": "message",
    "responseTextField": "response",
    "toolsCalledField": "toolsCalled",
    "latencyMsField": "latencyMs",
    "timeoutMs": 30000
  },
  "gates": {
    "passRate": 0.9,
    "p95LatencyMs": 15000
  },
  "fixtures": {
    "dir": ".forge-fixtures",
    "ttlDays": 30
  }
}
```

Note: the programmatic API (`runEvalSuite(path, agentFn)`) bypasses the HTTP endpoint entirely —
agentFn takes precedence when provided.

### Task breakdown (ordered by dependency)

**Track A — evalkit checks (independent, start first)**
```
A1. Create lib/checks/types.js         — JSDoc @typedef blocks, no logic
A2. Convert 11 check files             — strip TypeScript, add attribution headers
A3. Convert run-checks.ts              — meta-runner, add attribution header
A4. Create lib/checks/index.js         — barrel export
A5. Write check-adapter.js             — maps tool-forge expect → evalkit RunChecksInput
A6. Write unit tests for all checks    — co-located .test.js files
A7. Write unit tests for check-adapter
```

**Track B — fixtures (independent, can run parallel with A)**
```
B1. Convert fixture-store.ts to JS         — moderate complexity, add attribution
B2. Create lib/fixtures/index.js           — barrel export
B3. Add fixturesDir to forge.config.json   — extend config schema
B4. Write fixture-store unit tests
```

**Track C — gate (depends on knowing eval result shape, after A)**
```
C1. Convert gate.ts to JS (trivial)    — ~5 min, add attribution
C2. Create lib/runner/gate.js
C3. Write gate unit tests
```

**Track D — comparison (depends on B + C for run objects)**
```
D1. Convert statistics.ts to JS        — preserve Wilson interval formula exactly
D2. Convert compare.ts to JS           — complex, use chalk not picocolors
D3. Convert format.ts to JS            — substitute chalk for picocolors
D4. Create lib/comparison/index.js
D5. Write comparison unit tests
```

**Track E — low-hanging fruit (parallel with A/B)**
```
E1. Wilson intervals → lib/comparison/statistics.js (done in D1, used in drift-monitor)
E2. No-hallucinated-numbers check → lib/checks/no-hallucinated-numbers.js (from agent-eval-kit)
E3. Tool-sequence modes (strict/unordered/subset/superset) → extend lib/checks/tool-selection.js
E4. Cost estimator → lib/runner/cost-estimator.js (from agent-eval-kit, pre-flight display)
E5. Grader composition (all/any/not) → lib/checks/compose.js (from agent-eval-kit)
```

**Track F — wiring (depends on A + B + C)**
```
F1. Update lib/eval-runner.js:
    - Replace checkAssertions() with runChecks() + checkAdapter()
    - Add fixture recording (--record flag)
    - Add fixture replay (--replay flag, skip agent call)
    - Add gate evaluation at end of run (non-zero exit on failure)
    - Wire cost estimator into pre-flight output

F2. Create lib/runner/index.js — programmatic export:
    export async function runEvalSuite(evalFilePath, agentFn, opts = {})
    opts: { record, replay, gates, fixturesDir, onProgress }

F3. Update lib/index.js — add CLI `run` command:
    node lib/index.js run --eval <path>
    node lib/index.js run --eval <path> --record
    node lib/index.js run --eval <path> --replay
    node lib/index.js run --eval <path> --suite <toolName>

F4. Update lib/views/main-menu.js — add 'Run Evals' menu item
F5. Create lib/views/run-evals.js — TUI view (mirrors eval-run.js pattern)

F6. Wire comparison into TUI drift view — show run diff after each run
```

**Track G — attribution + docs (last)**
```
G1. Add "Standing on Shoulders" section to README.md
G2. Verify all lifted files have correct attribution headers
G3. Update forge.config.json docs in README
G4. Add example eval run to example/ directory
```

### Execution parallelism
- **A + B + E can all start simultaneously** (no dependencies between them)
- **C starts after A2-A4** (needs check result shape to know what gate evaluates)
- **D starts after B + C** (comparison needs run objects with fixture + gate data)
- **F starts after A + B + C** (wiring needs all three subsystems)
- **G is the final pass** (documentation after all code is in)

---

## 3. Error Handling Plan

### Failure modes and handling

| Failure | Where caught | User-facing behavior |
|---|---|---|
| Agent HTTP endpoint unreachable | `eval-runner.js` try/catch | Case marked FAIL with `"agent_error: ECONNREFUSED"` — run continues |
| Agent returns non-JSON | `checkAdapter` | Check results show raw text, content checks proceed normally |
| Agent timeout | HTTP fetch with AbortController | Case marked FAIL with `"agent_error: timeout after Xms"` |
| agentFn throws (programmatic API) | `runner/index.js` try/catch | Case marked FAIL, error message in reason field |
| Eval JSON missing/malformed | `eval-runner.js` pre-flight | Exit with clear message: `"Cannot read eval file: path/to/file.json"` |
| No `agent` config and no agentFn | Pre-flight check | Exit with: `"No agent configured. Add agent.endpoint to forge.config.json or pass agentFn."` |
| Fixture dir missing | `fixture-store.js` | `mkdir -p` on first write; graceful on read (returns "not-found") |
| Fixture stale (TTL exceeded) | `fixture-store.js` | Returns `{ status: 'stale' }` — runner logs warning, falls through to live call |
| Fixture config-hash mismatch | `fixture-store.js` | Returns `{ status: 'config-hash-mismatch' }` — runner logs warning, re-records |
| Gate failure | `gate.js` | Logged to console with reason; `process.exitCode = 1` set (not `process.exit()` — allows cleanup) |
| SQLite write failure | `db.js` (existing) | Log warning, do NOT fail the eval run — results are already computed |
| Comparison with missing base run | `compare.js` pre-flight | Exit with: `"Base run not found: <id>"` |

### Logging/observability
- Gate failures logged with: gate name, threshold, actual value, delta
- Fixture status (hit/miss/stale) logged at DEBUG level (not shown by default)
- Agent errors logged per-case to console + stored in `eval_run_cases.reason`
- Cost estimator output shown in pre-flight (before first agent call)
- Existing drift_alerts table picks up gate failures automatically (pass_rate fed to checkDrift)

### Graceful degradation
- If fixtures dir is not writable, `--record` logs a warning and falls through to live mode
- If comparison module fails, main run result still persists and returns to caller
- If drift monitor throws (existing behavior), eval run is not affected

---

## 4. Execution Strategy

### Parallelization
```
Day 1 (parallel):
  Dev A: Track A (evalkit checks conversion + tests) — ~3 hours
  Dev B: Track B (fixture-store conversion + tests) — ~2 hours
  Dev C: Track E (low-hanging fruit) — ~4 hours

Day 2 (sequential unblocks):
  Track C (gate) — ~1 hour (unblocked after A)
  Track D (comparison) — ~3 hours (unblocked after B+C)
  Track F (wiring) — ~4 hours (unblocked after A+B+C)

Day 3:
  Track G (attribution + docs) — ~1 hour
  Full integration test pass — ~1 hour
  npm test green — ~30 min
```

Solo sequence (if working alone):
```
A → B (parallel work within same session) → C → E → D → F → G
```

### Incremental delivery checkpoints
1. **Checkpoint 1 (after A + adapter):** Can run a tool-forge eval JSON through evalkit checks
   with a mock agent — no fixtures, no gates, just assertions. Confirms the check mapping is correct.
2. **Checkpoint 2 (after F1):** Full CLI `run` command works end-to-end, results in SQLite.
3. **Checkpoint 3 (after F2):** `runEvalSuite(path, agentFn)` exported — other project can
   integrate immediately.
4. **Checkpoint 4 (after D + F6):** Comparison diffing wired into TUI. Full e2e demo possible.

### Performance considerations
- Better-sqlite3 is synchronous — do NOT wrap `insertEvalRun` or `insertEvalRunCases` in async functions (lessons-learned warning)
- `sortKeysDeep()` in fixture-store is recursive — for large agent responses, profile if needed
- Gate evaluation is O(n) over cases — non-issue at typical eval sizes
- Comparison Map.get() operations are O(1) — non-issue

### Package additions needed
```bash
# No new production dependencies required:
# - evalkit: zero deps (node built-ins only)
# - agent-eval-kit modules: gate.js (no deps), fixture-store.js (node:fs only),
#   compare.js (no deps), statistics.js (no deps)
# - format.js: uses chalk (already installed)
```

Zero new npm packages. This is intentional — follows evalkit's philosophy and keeps the supply chain clean.

---

## 5. Low-Hanging Fruit Details

These are included in Track E and represent easy wins during the same integration pass:

### E1 — Wilson score confidence intervals in drift monitor
- **Source:** `agent-eval-kit/src/runner/statistics.ts` lines 20-35
- **Effort:** 30 min (already being converted for comparison/statistics.js)
- **Value:** Replace naive pass-rate comparison in `drift-monitor.js` with proper 95% CI bounds
- **Implementation:** Import `wilsonInterval()` from comparison/statistics.js; use `ci95.low` as
  the meaningful threshold for drift detection rather than raw delta

### E2 — No-hallucinated-numbers grader
- **Source:** `agent-eval-kit/src/graders/deterministic/no-hallucinated-numbers.ts`
- **Effort:** 2 hours
- **Value:** Catches fabricated numbers — the #1 failure mode for financial/analytical agents
- **Implementation:** New file `lib/checks/no-hallucinated-numbers.js`; add to `run-checks.js`
  when `expect.noHallucinatedNumbers: true` is set; add to check-adapter

### E3 — Tool-sequence matching modes
- **Source:** `agent-eval-kit/src/graders/deterministic/tool-sequence.ts`
- **Effort:** 2 hours
- **Value:** `strict` / `unordered` / `subset` / `superset` matching for tool calls
- **Implementation:** Extend `lib/checks/tool-selection.js` with a `mode` parameter;
  update check-adapter to pass `mode` from `expect.toolsCalledMode`; default to current
  behavior (`strict` = exact set equality) for backward compatibility

### E4 — Cost estimator pre-flight
- **Source:** `agent-eval-kit/src/runner/cost-estimator.ts`
- **Effort:** 30 min
- **Value:** Shows estimated cost before running N eval cases — prevents surprise bills
- **Implementation:** `lib/runner/cost-estimator.js`; called in `eval-runner.js` before first
  agent call; output: `"Estimated cost: ~$0.02 (12 cases × gpt-4o-mini)"`

### E5 — Grader composition operators
- **Source:** `agent-eval-kit/src/graders/compose.ts`
- **Effort:** 1 hour
- **Value:** `all([...])`, `any([...])`, `not(check)` operators; enables expressing
  "contains X OR contains Y, AND must call tool Z"
- **Implementation:** `lib/checks/compose.js`; optional, used when caller wants programmatic
  composition rather than the JSON format

---

## 6. Definition of Done

- [ ] All 11 evalkit checks converted, attributed, and unit-tested
- [ ] `check-adapter.js` maps all tool-forge `expect` fields correctly (unit tested)
- [ ] `fixture-store.js` converted, attributed, and unit-tested (record/replay/stale/mismatch)
- [ ] `gate.js` converted, attributed, and unit-tested (pass + fail + missing)
- [ ] `compare.js` + `format.js` + `statistics.js` converted, attributed, and unit-tested
- [ ] Low-hanging fruit items E1-E5 implemented
- [ ] `lib/eval-runner.js` uses evalkit checks + fixtures + gates end-to-end
- [ ] `lib/runner/index.js` exports `runEvalSuite(path, agentFn)` (programmatic API)
- [ ] CLI `run` command works with `--record` and `--replay` flags
- [ ] TUI "Run Evals" menu item navigates to run-evals view
- [ ] Zero new npm production dependencies added
- [ ] All lifted files have correct attribution headers
- [ ] README "Standing on Shoulders" section added
- [ ] `npm test` passes (all existing + new tests green)
- [ ] `/audit` clean (types + build)
- [ ] At least one full e2e demo run documented in example/

---

## Source Files Reference

### From evalkit (by [Author Name] — https://github.com/[repo])
| Original TS file | Converted to | Notes |
|---|---|---|
| `src/checks/types.ts` | `lib/checks/types.js` | JSDoc only, no logic |
| `src/checks/content-match.ts` | `lib/checks/content-match.js` | Trivial |
| `src/checks/negative-match.ts` | `lib/checks/negative-match.js` | Trivial |
| `src/checks/tool-selection.ts` | `lib/checks/tool-selection.js` | Extended with mode param (E3) |
| `src/checks/latency.ts` | `lib/checks/latency.js` | Trivial |
| `src/checks/json-valid.ts` | `lib/checks/json-valid.js` | Trivial |
| `src/checks/schema-match.ts` | `lib/checks/schema-match.js` | Trivial |
| `src/checks/non-empty.ts` | `lib/checks/non-empty.js` | Keep default cop-out phrase list |
| `src/checks/length-bounds.ts` | `lib/checks/length-bounds.js` | Trivial |
| `src/checks/regex-match.ts` | `lib/checks/regex-match.js` | Trivial |
| `src/checks/tool-call-count.ts` | `lib/checks/tool-call-count.js` | Trivial |
| `src/checks/cost-budget.ts` | `lib/checks/cost-budget.js` | Trivial |
| `src/checks/run-checks.ts` | `lib/checks/run-checks.js` | Moderate, preserve conditional logic |
| `src/runner/run-suite.ts` | (not lifted directly) | Pattern referenced in eval-runner.js update |
| `src/runner/loader.ts` | (not lifted directly) | tool-forge evals are JSON; existing loader sufficient |

### From agent-eval-kit (by [Author Name] — https://github.com/[repo])
| Original TS file | Converted to | Notes |
|---|---|---|
| `src/fixtures/fixture-store.ts` | `lib/fixtures/fixture-store.js` | Moderate; preserve sortKeysDeep |
| `src/runner/gate.ts` | `lib/runner/gate.js` | Trivial |
| `src/comparison/compare.ts` | `lib/comparison/compare.js` | Complex but all native JS |
| `src/comparison/format.ts` | `lib/comparison/format.js` | chalk substituted for picocolors |
| `src/runner/statistics.ts` | `lib/comparison/statistics.js` | Preserve Wilson interval exactly |
| `src/graders/deterministic/no-hallucinated-numbers.ts` | `lib/checks/no-hallucinated-numbers.js` | E2 |
| `src/graders/deterministic/tool-sequence.ts` | extends tool-selection.js | E3 |
| `src/runner/cost-estimator.ts` | `lib/runner/cost-estimator.js` | E4 |
| `src/graders/compose.ts` | `lib/checks/compose.js` | E5 |
