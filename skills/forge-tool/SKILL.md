---
name: forge-tool
description: Build a new agent tool via structured 10-phase dialogue. Walks through requirements, challenges necessity, locks the routing contract, then generates implementation code adapted to your stack. Works with any language, any framework.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
---

# Forge Tool

This skill is the entry point for adding a tool to your LLM agent. It conducts a structured 10-phase dialogue to ensure every tool earns its place, then generates implementation code adapted to your stack. No TODOs. No stubs.

**How it works:** You (Claude) are both orchestrator and developer. The user defines what to build. You challenge, refine, and build it. All code is your responsibility.

> Before starting, read `references/tool-shape.md` for the ToolDefinition spec, `references/description-contract.md` for description formatting rules, and `references/extension-points.md` for stack adaptation guidance.

---

## Phase 0: Read Current State

Before any dialogue, discover what tools already exist.

1. Look for existing tool files in the project (glob for `*.tool.*`, `*_tool.*`, or similar patterns)
2. For each file, extract the registered tool name
3. If a `forge.config.json` exists in the project root, read it for stack-specific settings
4. Present the list to the user:

```
Existing tools in the registry:
  - tool_name — description (if readable)
  - ...

Do you want to:
  A) Add a new tool
  B) Build out an existing tool stub
```

If user chooses B: treat it as starting fresh for the named tool.
If user chooses A: proceed to Phase 1.

---

## Phase 1: Creative Exploration

Open with a single, open-ended question:

> "What should this tool do?"

Your role here is **creative collaborator**. Let the idea breathe before imposing structure.

- Surface angles the user may not have considered
- Extend the idea: probe the edges of the use case
- Ask "what problem does this solve for the user?" to ensure it's grounded in real need
- Keep responses short and conversational
- Do NOT ask for schema, category, or timeout yet

Continue until the idea feels fully explored — typically 2-4 exchanges.

---

## Phase 2: Skeptic Gate

Before converging, challenge the tool's right to exist:

- **Overlap:** Is this genuinely distinct from the existing tools you listed in Phase 0? Could it be a parameter or mode on an existing tool instead?
- **Necessity:** What does the agent lose without this tool? Can it work around the absence?
- **Scope:** Is this one tool or two tools in disguise? A tool should do one thing well.
- **Feasibility:** Does the data source actually provide what this tool needs?

If the tool cannot clearly answer "what does the agent lose without me?", push back:

> "I want to make sure this earns its place — we want a sharp agent with focused tools, not a confused agent with 50 mediocre ones. Help me understand what breaks without this."

Only proceed once you are convinced the tool is necessary, distinct, and correctly scoped.

---

## Phase 3: Converge on Description, Name, and Trigger Phrases

### CRITICAL: The description is the routing contract

The tool's `description` field is the **single source of truth** for how the LLM decides when to use this tool. It flows into the system prompt and the LLM reads it to decide which tool to call. A vague description = wrong tool routing = failed evals.

> See `references/description-contract.md` for the full format specification and examples.

### Description requirements

Synthesize the dialogue into a one-sentence description satisfying ALL of:

1. **What it does** — the action, not what it returns
2. **When to use it** — the trigger condition distinguishing it from every other tool
3. **When NOT to use it** — disambiguation hint if there's common confusion
4. **Data source** — which API or computation backs it

**Format:** `<What it does>. Use when <trigger condition>. <Disambiguation if needed>.`

Present the description to the user:
> "Here's the description I'd write: [description]. This is what the LLM sees to decide when to call this tool. Does it clearly distinguish this from the others?"

Iterate until locked. **Do not move on if the description is ambiguous with any existing tool.**

### Name

Derive mechanically from the locked description:
- snake_case, verb-noun format preferred: `get_holdings`, `calculate_tax`, `check_wash_sale`
- Self-documenting — no abbreviations

### Trigger phrases

Identify **3-5 natural language phrases** a user would say that should route to this tool. These drive eval generation in Phase 9.

Present: "These are the phrases I'd expect to trigger this tool: [list]. Any I'm missing?"

Do not proceed until description, name, and trigger phrases are all confirmed.

---

## Phase 4: Collect Remaining Fields

Collect the remaining ToolDefinition fields conversationally — not as a form dump.

1. **Schema** — "What inputs does this tool accept?" Build the validation schema. Read it back for confirmation.

2. **Consequence Level** — `'low' | 'medium' | 'high'`:
   - `low` — no real-world impact (read-only, summaries)
   - `medium` — moderate impact (analysis influencing decisions)
   - `high` — significant impact (trades, account changes, deletions)

3. **Category** — `'read' | 'write' | 'analysis'`:
   - `read` — retrieves data, no mutations
   - `write` — performs mutations
   - `analysis` — computes derived insights

4. **requiresConfirmation** — ask **separately** from category:
   > "Should the agent pause and wait for user approval before executing?"

5. **timeout** — default 15000ms. Only ask if the tool calls slow external APIs.

6. **tags** — optional domain tags for filtering/grouping.

7. **dependsOn** — optional. "Does this tool internally call other tools?"

---

## Phase 5: Dependency Check

Before generating code, check whether the tool needs any service beyond what `ToolContext` provides.

The standard context provides:
- `context.client` — API client for external calls
- `context.auth` — authentication credentials
- `context.userId` — the authenticated user ID
- `context.abortSignal` — for request cancellation

> See `references/extension-points.md` for how to add new services to the context.

If the tool needs a service not in the context — **flag and exit. Do not write any files.**

Present an actionable checklist:
```
This tool needs a dependency not yet in ToolContext.

Required: [ServiceName]

To unblock:
  1. Add [ServiceName] to your ToolContext interface
  2. Pass the instance into tool context construction
  3. Re-run /forge-tool

No files have been written.
```

If no new deps are needed — proceed to Phase 6.

---

## Phase 6: Confirm Full Spec

Present the complete spec before writing a single file:

```
Tool Spec — ready to generate:

  name:                 {{name}}
  description:          {{description}}
  category:             {{category}}
  consequenceLevel:     {{consequenceLevel}}
  requiresConfirmation: {{requiresConfirmation}}
  timeout:              {{timeout}}ms
  tags:                 [{{tags}}]
  dependsOn:            [{{dependsOn}}] | none
  schema:
    {{field}}: {{type}} — {{fieldDescription}}
    ...
  trigger phrases:      {{triggerPhrases}}

Files to be created:
  + {{toolsDir}}/{{name}}.tool.{{ext}}
  + {{testsDir}}/{{name}}.tool.spec.{{ext}}

Registration:
  ~ {{barrelsFile}}  ← add one export/registration line

Shall I proceed?
```

Do not write any files until the user confirms.

---

## Phase 7: Generate and Implement All Files

Execute in this exact order:

### 7a. Tool Implementation File

Generate the tool as a const export (or your language's equivalent) conforming to ToolDefinition.

Key rules:
- Check `context.abortSignal?.aborted` before any I/O
- Return `ToolResult` shape: `{ tool, fetchedAt, data?, error? }`
- Never throw from `execute()` (except re-throwing HITL interrupts)
- All service access through `context.*`
- Use the validation library from `forge.config.json` or ask the user

If `requiresConfirmation: true`, implement the HITL pattern appropriate to the user's framework (LangGraph interrupt, custom webhook, manual pause, etc.).

### 7b. Register in Barrel

Add one line to the barrel/registry file. This should be the **only** existing file edited.

### 7c. Test File

Write **real, passing tests** — not empty shells.

Minimum test cases:
1. Returns ToolResult with data on success (mock the API client)
2. Returns ToolResult with error when the API client throws
3. Returns cancellation ToolResult when abortSignal is already aborted

Use fixed, realistic fixture data — never randomized inputs.

### 7d. Verification/Confirmation File (if requiresConfirmation: true)

If the tool requires confirmation, generate the HITL verification logic appropriate to the user's framework.

---

## Phase 8: Run Tests

After all files are written, run the test suite:

1. Run tests (using the command from `forge.config.json` or asking the user)
2. Run type-check if applicable
3. All tests must pass before proceeding

If any test fails:
1. Read the failure output
2. Fix the implementation or spec
3. Re-run tests
4. Do not report success until the suite is green

---

## Phase 9: Generate Evals

After tests pass, hand off to `/forge-eval` (if available) with this context:
- Tool `name`, `description`, `category`, `schema`
- `trigger phrases` from Phase 3
- List of all other tools in the registry

If `/forge-eval` is not installed, report that eval generation is available separately and list what the user would need to provide.

---

## Phase 10: Report Output

When all tests are green:

```
Tool `{{name}}` generated and tested.

Files created:
  + {{toolsDir}}/{{name}}.tool.{{ext}}
  + {{testsDir}}/{{name}}.tool.spec.{{ext}}

Registration:
  ~ {{barrelsFile}}

System prompt: auto-updated (tool appears via barrel discovery)
Unit tests: passing
Eval coverage: [generated | available via /forge-eval]
```

---

## Rules

- **You are the developer.** The user defines what to build. You build it.
- **Green out of the box.** Tests must pass before you report success.
- **Description is the routing contract.** If you can't write a clear description, the tool's scope is wrong — go back to Phase 2.
- **Description before name.** Do not ask for a tool name until the description is locked.
- **Trigger phrases before code.** Identify how users will invoke this tool before writing implementation.
- **Skeptic after explorer.** Surface the best version of the idea before challenging it.
- **Challenge necessity.** A tool that cannot answer "what breaks without me?" does not earn a place.
- **`category` and `requiresConfirmation` are independent.** Collect them separately.
- **Flag and exit on unknown deps.** If the tool needs a service not in ToolContext, write no files.
- **Barrel registration only.** Add one line to the registry. Never edit auto-discovery files.
- **Fixed fixtures only.** Test data must be deterministic. No randomization.
- **Adapt to the user's stack.** Read `forge.config.json` if present. Ask if not. Generate real code in their language with their frameworks — not pseudo-code.
