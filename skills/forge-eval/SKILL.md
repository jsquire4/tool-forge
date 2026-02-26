---
name: forge-eval
description: Auto-generates golden and labeled eval JSON files for an agent tool. Produces deterministic assertion-based evals with difficulty tiers, seed data templates, and overlap-driven ambiguity testing. No LLM-as-judge.
allowed-tools: Read, Write, Grep, Glob, Bash, AskUserQuestion
---

# Forge Eval

This skill generates eval JSON files for an agent tool. It produces two tiers:

- **Golden evals** (5-10 per tool) — Single-tool routing sanity checks
- **Labeled evals** (scales with registry) — Multi-tool orchestration under ambiguity

All assertions are deterministic code — no LLM-as-judge. Both tiers should run against your live agent endpoint to test the full pipeline: system prompt → LLM routing → tool execution → response formatting.

> Before starting, read `references/eval-types.md` for case interfaces, `references/assertion-patterns.md` for the assertion catalog, and `references/overlap-map.md` for the overlap map format.

---

## Golden vs Labeled — The Distinction

**Golden evals** are single-tool sanity checks. One prompt, one expected tool, one assertion set. They answer: "Does the system prompt route this tool correctly?"

- **Scope:** Single tool per case
- **Count:** 5-10 cases per tool
- **When they fail:** Either the tool description is bad (fix upstream) or the keywords are wrong (fix locally)

**Labeled evals** test multi-tool orchestration. They verify the agent can chain tools, interpret ambiguous intent, and handle adversarial inputs.

- **Scope:** Multi-tool orchestration and intent interpretation
- **Count:** Scales with the registry (see Scaling Formula)
- **Difficulty tiers:** straightforward, ambiguous, edge
- **When they fail:** Agent reasoning or tool-chaining logic needs work, or descriptions create confusion at scale

**Example:**
- Golden: "What's the weather in Paris?" → asserts `get_weather` called, response contains temperature
- Labeled: "Should I bring an umbrella to my meeting in Paris tomorrow?" → asserts `get_weather` AND `get_forecast` both called, response synthesizes both

---

## The Description Is the Routing Contract

Before generating evals, **read the tool's description** and verify it follows:
`<What it does>. Use when <trigger condition>. <Disambiguation if needed>.`

If the description is vague, **do not generate evals**. Tell the caller:
> "The tool description is too vague for reliable eval generation. Fix the description first."

---

## What the Factory Receives

From `/forge-tool` Phase 9 or from manual invocation:

- Tool `name` (snake_case)
- Tool `description` (follows routing contract format)
- Tool `category` ('read' | 'write' | 'analysis')
- Tool `schema` (field names, types, defaults, enums)
- Tool `requiresConfirmation` (boolean)
- **Trigger phrases** (3-5 natural language phrases that should route to this tool)
- The list of all other tools in the registry

---

## Seed Data and Assertion Strategy

> See `references/assertion-patterns.md` for the full assertion catalog.

Assertions use three fields:

- **`responseContains`** — ALL must appear. Use for **hard proof the tool ran**: exact values the LLM cannot guess.
- **`responseContainsAny`** — At least one from EACH group. Use for **domain precision with flexibility**: synonym groups so the agent isn't forced into robotic phrasing.
- **`responseNotContains`** — NONE may appear. Use for **cop-outs** ("I don't know"), **imprecision**, **JSON leaks** ("fetchedAt"), and **sensitive data**.

### Template Syntax

Use template tokens to keep eval JSON in sync with your data:

- **`{{seed:path}}`** — Resolves from a seed manifest file. For values that are fixed and known (ticker symbols, share counts, etc.).
- **`{{snapshot:path}}`** — Resolves from a live data snapshot captured before each eval run. For values that change (prices, P&L, etc.).

Both resolve in-memory only — eval JSON on disk is never modified.

If a template path is missing at runtime, the individual assertion is skipped with a warning — not a hard failure.

---

## Tool Overlap Map

> See `references/overlap-map.md` for the full format specification.

The overlap map declares which tools are close neighbors — tools that could plausibly be confused. It drives ambiguous eval generation. Every declared overlap must have at least one ambiguous labeled eval testing both tools together.

Before generating labeled evals:
1. Read the overlap map
2. Identify declared close neighbors for this tool
3. Target ambiguous cases at real overlaps instead of guessing

---

## Golden Eval Generation (5-10 cases)

### Cases to Generate

1. **Tool selection** (one per trigger phrase, minimum 3) — Use trigger phrases as the prompt. Assert correct tool called, no errors, response contains proof values.

2. **Rephrased variants** (2-3 cases) — Same intent, different wording. Tests that routing isn't keyword-dependent.

3. **No JSON leak** (1 case) — Assert response doesn't contain raw field names like "fetchedAt", "\"tool\":", "undefined".

4. **Disambiguation** (1-2 cases, if overlapping tools exist) — Prompt that could be confused with another tool but should route here.

### ID Convention: `gs-<toolname>-001`, `gs-<toolname>-002`, etc.

### Example Golden Eval

```json
{
  "id": "gs-get-weather-001",
  "description": "trigger phrase — direct weather question",
  "input": { "message": "What's the weather in Paris?" },
  "expect": {
    "toolsCalled": ["get_weather"],
    "noToolErrors": true,
    "responseNonEmpty": true,
    "responseContains": ["Paris"],
    "responseContainsAny": [["temperature", "degrees", "°"]],
    "responseNotContains": ["I don't know", "no information"],
    "maxLatencyMs": 30000
  }
}
```

---

## Labeled Eval Generation (scales with registry)

### Scaling Formula

Read the overlap map and count:
- **O** = declared overlaps for this tool
- **C** = declared clusters containing this tool
- **T** = total tools in the registry

| Tier | Formula | Minimum | Batch size |
|------|---------|---------|------------|
| Straightforward | 10 + T | 10 | 5 |
| Ambiguous | 25 + (O × 2) + (C × 1) | 25 | 5 |
| Edge | 5 + floor(T / 3) | 5 | 5 |

### Straightforward (10 + T cases)

Multi-tool tasks where intent is clear and tool combination is obvious.

- Assert `toolsCalled` includes this tool AND expected companions
- Response must synthesize data from all called tools
- Vary tool count: include 2-tool, 3-tool, and 4+ tool cases

### Ambiguous (25 + O×2 + C×1 cases)

Prompts where multiple valid tool-chaining strategies exist. Use `toolsAcceptable` instead of `toolsCalled`.

**Combination types to cover:**
- **OR (substitution):** Tool A or Tool B — either alone suffices
- **AND/OR (optional depth):** Tool A alone, or Tool A + B together
- **XOR (mutually exclusive paths):** Tool A + B, or Tool C + D
- **AND with variable depth:** All must be called, but how many is ambiguous
- **NOR (none needed):** Prompt looks tool-worthy but isn't — `[["__none__"]]`

Spread cases across these types. Don't just write 25 OR cases.

### Edge / Adversarial (5 + floor(T/3) cases)

- Prompt injection attempts
- Off-topic requests disguised as in-scope
- General knowledge questions (no tool needed)
- Contradictory multi-step requests
- Assert: `responseNotContains` for sensitive data leaks, system prompt exposure

### ID Convention: `ls-<toolname>-001`, `ls-<toolname>-002`, etc.

---

## Approval Batching Protocol

Nothing is written to disk without user approval.

### Golden Evals — 1 batch
Present all 5-10 cases. User approves or revises. Write file.

### Labeled Evals — scales with registry
1. Compute case counts using the scaling formula
2. Present batch plan:
```
Eval batch plan for {{name}}:
  Registry: T tools | Overlaps: O | Clusters: C
  Straightforward: X cases (Y batches)
  Ambiguous:       X cases (Y batches)
  Edge:            X cases (Y batches)
  Total:           X cases (Y batches)
Proceed?
```
3. Present batches sequentially (5 cases each)
4. **Tier order:** All straightforward first, then ambiguous, then edge
5. After all approved, write the labeled eval file

---

## Execution Flow

```
1. Read tool source file → extract name, description, category, schema
2. VERIFY description quality — reject if vague or overlapping
3. Read registry → know what other tools exist
4. Read overlap map → identify declared close neighbors
5. Read seed manifest (if exists) → use for exact assertion values
6. GOLDEN BATCH: Generate 5-10 cases → present → approve → write file
7. LABELED: Compute scaling formula → present batch plan → approve
8. LABELED BATCHES: Generate by tier → present each batch → approve
9. Write labeled eval file
10. Update overlap map with this tool's overlaps (if not already present)
11. Report files created + case counts
```

---

## Rules

- **All assertions are deterministic.** No LLM-as-judge. Pass/fail must be identical across runs given the same data.
- **The description is upstream.** If evals fail because of bad routing, the fix is in the tool's description, not in loosening assertions.
- **`responseContains` must reference exact known values.** Use seed templates for stable values, snapshot templates for live values. Never hardcode volatile data.
- **`responseContainsAny` enforces domain precision.** Each synonym group allows natural phrasing while requiring correct vocabulary.
- **`responseNotContains` catches cop-outs AND imprecision.** Include "I don't know" / "unable to" for cop-outs. Include wrong terms for precision checks.
- **Fixed data only.** No randomization, no dynamic dates in assertions.
- **One file per tool, per tier.** Golden and labeled are separate files.
- **Nothing is written without user approval.** Golden = 1 batch. Labeled = ceil(total / 5) batches.
- **Ambiguous cases are driven by the overlap map.** Every declared overlap must have at least one ambiguous eval testing both tools together.
- **ID format:** `gs-<toolname>-NNN` for golden, `ls-<toolname>-NNN` for labeled.
