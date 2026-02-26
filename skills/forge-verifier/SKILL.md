---
name: forge-verifier
description: Gap detection and verifier creation. Reports tools without verifier coverage, suggests verifiers by output group, generates verifier stubs and barrel registration.
allowed-tools: Read, Edit, Write, Grep, Glob, AskUserQuestion
---

# Forge Verifier

This skill detects tools without verifier coverage and generates verifier stubs. Verifiers are **one-to-many** — one verifier can apply to many tools. Run separately from forge-tool.

> Before starting, read `references/verifier-pattern.md` for the interface and registry pattern, and `references/output-groups.md` for output group mapping.

---

## Phase 0: Read Current State

1. Load `forge.config.json` — check `verification.enabled`. If false or missing, tell the user verification is disabled and exit.
2. Load existing tools (from `project.toolsDir` or `project.barrelsFile`)
3. Load existing verifiers (from `verification.barrelsFile` or `verification.verifiersDir`)
4. Infer **output group** per tool from description, tags, schema (see `references/output-groups.md`)

---

## Phase 1: Gap Report

Build a coverage matrix:

| Tool | Output Group | Verifier Coverage |
|------|--------------|-------------------|
| get_holdings | holdings | concentration_risk ✓ |
| get_dividends | dividends | — |
| portfolio_summary | holdings, performance | concentration_risk ✓, stale_data ✓ |

**Gaps:** Tools or output groups with no verifier.

Present to the user:

```
Verifier Coverage Report

Tools without verifier coverage:
  • get_dividends     — output group: dividends
  • market_data       — output group: quotes

Suggested verifiers:
  • source_attribution — would cover all tools (create if missing)
  • stale_data        — would cover get_dividends, market_data (time-sensitive data)

Create verifiers? [Yes / Later / Dismiss]
```

If no gaps: "All tools have verifier coverage." Exit.

---

## Phase 2: Select Verifiers to Create

If user says Yes, ask which to create:

- List suggested verifiers (from gap analysis)
- User selects one or more
- For each selected: proceed to Phase 3

---

## Phase 3: Generate Verifier Stub

For each verifier:

1. **Order** — Pick next available in category (e.g. R-0001, A-0002). Glob existing verifiers for `order =` to avoid collisions.
2. **Path** — `{{verifiersDir}}/{{name}}.verifier.{{ext}}`
3. **Template** — Use the appropriate stub from `references/verifier-stubs.md` (source_attribution, concentration_risk, stale_data, or generic)
4. **Barrel** — Add one export line to `{{barrelsFile}}`

Generate the verifier file with:
- Class implementing Verifier interface
- `name`, `order` set
- `verify()` with `// EXTENSION POINT` for domain logic
- Real structure (parsing tool results, etc.) — user fills in thresholds and rules

---

## Phase 4: Confirm and Write

Present the files to be created:

```
Verifier: {{name}}
  + {{verifiersDir}}/{{name}}.verifier.ts
  ~ {{barrelsFile}}  ← add one export line
```

User confirms → write files.

---

## Phase 5: Report

```
Verifier `{{name}}` created.

Files:
  + {{verifiersDir}}/{{name}}.verifier.ts
  ~ {{barrelsFile}}

Fill in the EXTENSION POINT sections with your domain logic.
Run verifier tests to validate.
```

---

## Rules

- **One-to-many.** Verifiers apply to output groups, not individual tools.
- **Gap detection first.** Always report before creating.
- **Stub with structure.** Generate real parsing logic; user fills thresholds and rules.
- **Order uniqueness.** No two verifiers share the same `order` value.
- **Barrel only.** Add one line. Never edit the index/derivation file.
