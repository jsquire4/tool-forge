# Tool-Forge: Council Review

**Date:** 2026-02-25
**Process:** 2 research scouts (sonnet) surveyed prior art and best practices, then 6 council agents (3 haiku, 3 sonnet) reviewed the concept from different angles. This document synthesizes all findings into a collective assessment.

**Council Members:**
| Role | Model | Angle |
|------|-------|-------|
| Scout 1 | sonnet | Prior art, academic research, competing standards |
| Scout 2 | sonnet | Alternative approaches, criticisms, community sentiment |
| Practitioner Skeptic | haiku | Solo dev vs team overhead, real-world friction |
| Eval Specialist | haiku | Eval coverage gaps, scaling calibration |
| OSS Community Analyst | haiku | Naming, positioning, adoption infrastructure |
| Software Architect | sonnet | Composability, versioning, architectural risk |
| DX Specialist | sonnet | Onboarding friction, credibility, adoption paths |
| Eval Strategy Reviewer | sonnet | Assertion rigor, blindspots, regression testing |

---

## Prior Art and Competitive Landscape

The research scouts found no direct competitor that combines tool creation + eval generation + MCP scaffolding in one workflow. The closest related work:

- **SkillsBench** — Showed +16.2pp improvement from curated skills, validating the skill-based approach
- **BFCL (Berkeley Function Calling Leaderboard)** — The main competing eval benchmark; focuses on function-calling accuracy with held-out test sets
- **Apify Agent Skills Generator** — Auto-generates MCP servers from web services, but no eval discipline
- **"Learning to Rewrite Tool Descriptions" (Feb 2026)** — Academic validation that description quality is the dominant variable in routing accuracy
- **OpenAPI-to-tool generators** — Competing approach: auto-generate tools from API specs rather than structured dialogue
- **17K+ MCP servers** — Large ecosystem, but most lack structured eval coverage
- **Tool RAG / ToolCoder** — Alternative approaches that retrieve or generate tools at runtime rather than curating them upfront

**Key validation:** The "description as routing contract" framing is novel but empirically well-supported. No competitor treats the description field as a gated, testable contract.

**Key challenge:** Anti-framework sentiment is real. Many developers prefer lightweight, single-purpose tools over structured workflows.

---

## Strengths

### 1. The Description-as-Routing-Contract Thesis (Unanimous)

Every council member identified this as the project's strongest contribution. The insight that the tool `description` field is not metadata but a routing contract — and the enforcement of this through a gated Phase 3 dialogue — is:

- **Empirically validated** by the "Learning to Rewrite Tool Descriptions" paper (Feb 2026)
- **Structurally enforced** at three points: `/forge-tool` Phase 3 blocks advancement until the description is unambiguous, `/forge-eval` refuses to generate evals if the description is vague, `/forge-mcp` explicitly prohibits truncation during MCP generation
- **Practically useful** via the four-part format (`What it does. Use when. Disambiguation. Data source.`) and the "swap test" / "completeness test" self-checks

This is the single most defensible idea in the project.

### 2. The Skeptic Gate (Phase 2) Prevents Tool Sprawl

The requirement to justify a tool's existence before any implementation is written solves an underappreciated failure mode. The specific challenges ("Could this be a parameter on an existing tool?", "What does the agent lose without this?", "Is this one tool or two in disguise?") map directly to real failures in agent tool registries. No competing workflow includes this step.

### 3. The Three-Layer Deterministic Eval Strategy

The assertion design — `responseContains` (proof values), `responseContainsAny` (synonym groups), `responseNotContains` (cop-outs/leaks/system prompt exposure) — occupies a correct middle ground between:
- LLM-as-judge (non-deterministic, expensive, hard to debug)
- Unit testing `execute()` in isolation (misses routing entirely)

Each layer catches failures the other two cannot. The `responseContains` layer's contract — "exact values the LLM cannot guess" — correctly identifies the fundamental weakness of most deterministic evals.

### 4. The Overlap Map as Ambiguity Driver

Declaring tool overlaps explicitly and requiring at least one ambiguous eval per overlap pair transforms eval generation from ad-hoc guessing into a directed, registry-aware process. The coverage checks make gaps visible. This was called "a genuine contribution" by the eval specialist.

### 5. The `toolsAcceptable` Design

The distinction between `toolsCalled` (exact match) and `toolsAcceptable` (set of valid strategies) encodes the correct epistemics for ambiguous inputs: the eval tests that the agent stays within a rational solution space, not that it mimics a single reference answer. The `__none__` sentinel for "no tool should be called" is clean.

### 6. The ToolDefinition as Genuine Shared Interface

The three skills compose through a real shared interface, not nominal coupling. `/forge-tool` produces it, `/forge-eval` reads its description, category, schema, and trigger phrases, `/forge-mcp` reads its name, description, schema, category, consequenceLevel, and timeout. The field mapping is explicit and complete, with lossy conversions honestly flagged.

### 7. Progressive Disclosure Architecture

SKILL.md files stay under 400 lines with detail in `references/`. The `forge.config.json` opt-in makes configuration an optimization rather than a prerequisite. The worked example contains all four artifacts and the dialogue transcript shows what the workflow *feels like*, not just what it produces.

---

## Weaknesses and Remedies

### W1. No Tool Versioning or Lifecycle Management

**Problem:** Tools are born but never aged. When a tool's description or schema changes, existing evals may silently become meaningless (testing a contract that no longer exists) or break (hardcoded inputs against a changed schema). No mechanism for tool deprecation or eval staleness detection.

**Remedy:** Make `version` required on ToolDefinition (semver). Add a `status` field (`active | deprecated | removed`). Record `descriptionHash` and `toolVersion` in eval metadata. At run time, warn when eval metadata doesn't match the current tool definition. Add a `generatedAgainst` block to eval file headers:
```json
{
  "metadata": {
    "toolName": "get_weather",
    "toolVersion": "1.2.0",
    "descriptionHash": "a1b2c3",
    "generatedAt": "2026-01-15T10:00:00Z",
    "registrySize": 6
  },
  "cases": [...]
}
```

**Effort:** Low-Medium. Schema change + skill update + reference doc.

---

### W2. The Eval Runner Gap Is the Last-Mile Adoption Killer

**Problem:** The eval JSON files are inert artifacts until a user builds a runner. The runner contract is scattered across multiple docs, underspecified on critical points (seed path resolution, snapshot capture mechanism, latency measurement definition, output format), and framed as a "won't fix" rather than a deliberate design boundary. A developer who invests an hour generating 15 golden evals hits a value cliff at "how do I run these?"

**Remedy (two parts):**

1. **Spec the contract:** Add `docs/eval-runner-contract.md` specifying: seed manifest path resolver algorithm, snapshot interface (function signature), runner output JSON schema (`EvalSuiteResult` at file level), and latency measurement definition (wall-clock from POST to complete response).

2. **Ship a reference implementation:** Add `docs/examples/eval-runner-reference/runner.pseudo.ts` (and optionally `runner.pseudo.py`). Implements the minimal loop: load eval JSON, iterate cases, POST to configurable agent endpoint, capture `toolsCalled` from response, run each assertion type, print pass/fail summary. Mark agent endpoint, auth, and response parsing as `// EXTENSION POINT`. This is not a runnable harness — it's a contract with enough structure that adaptation takes hours, not days.

**Effort:** Medium. One spec doc + one reference file.

---

### W3. The README Doesn't Sell the "Why" Before the "How"

**Problem:** The README's thesis line is correct and punchy, but it sits above a table of skill names and invocation syntax. The developer who reads past the thesis has been given the product before they've been convinced they have the problem. The blog post's opening is dramatically better at establishing the problem but lives in `docs/blog-post.md` and isn't linked from the README.

**Remedy:**
- Add a 4-6 line "The Problem" section at the top (before "What's Inside") drawn from the blog post's problem statement
- Add a "Pick Your Entry Point" section with three explicit adoption paths:
  - **Already have tools, want evals only:** Copy `skills/forge-eval/` only
  - **Starting a new tool from scratch:** Copy all three skills
  - **Have a tool, want an MCP server:** Copy `skills/forge-mcp/` only
- Link directly to the blog post: "Read the full thesis in [The Engineering Approach](docs/blog-post.md)"

**Effort:** Low. README edits only.

---

### W4. MCP Skill Generates One Tool Per Server

**Problem:** Real MCP servers expose multiple related tools under a single server identity. The "bundle manually" instruction has no guidance, no template, and no skill support. Users who need multi-tool servers are left to do the hardest part without assistance.

**Remedy:** Add a Phase 1b to `/forge-mcp` that asks: "Generate a server for this tool only, or bundle it with other tools?" When bundling, use the overlap map to suggest natural groupings. Generate a single server file that registers all selected tools. Server name becomes `{{service}}-mcp-server` rather than `{{tool_name}}-mcp-server`.

**Effort:** Medium. Skill update + template additions.

---

### W5. The Pseudo-Code Approach Creates a Credibility Gap

**Problem:** A first-time visitor who opens `tool-definition.pseudo.ts` sees code that won't compile with placeholder imports. This reads as "unfinished" unless they already understand the pseudo-code design choice. The MCP example (`get-weather.mcp.example.ts`) is now clearly marked as real runnable code; see `docs/REAL-VS-PSEUDO.md`.

**Remedy:**
- Add an explicit callout in the README's design decisions: "Templates use pseudo-code because the LLM IS the adapter — shipping runnable TypeScript would mislead Python developers."
- Make the weather API example the showcase: "See the [weather API example](docs/examples/weather-api/) for what actual generated output looks like."
- Consider adding a second worked example in a different domain to show the pattern generalizes.

**Effort:** Low. README + callout additions.

---

### W6. The Architecture Guide Conflates Universal and Topology-Specific Patterns

**Problem:** Layers 1-4 (Registry, Verification, Factory, HITL) are genuinely universal. Layers 5-7 (Sidecar Integration, Channel Capabilities, Checkpoint Persistence) describe a specific topology where the agent runs alongside a host application. The guide presents all 9 as a maturity progression when many agents will never need Layers 5-7.

**Remedy:** Restructure into two sections:
- **Core Layers** (1, 2, 3, 4, 8): Apply to every agent tool system
- **Topology Patterns**: Sidecar (current Layers 5-7), Standalone (no sidecar layer needed), Multi-agent (currently absent — tool namespacing, auth delegation, result attribution)

**Effort:** Medium. Architecture doc restructure.

---

### W7. Overlap Map Has No Automated Maintenance Path

**Problem:** The overlap map is manually maintained. No mechanism to detect staleness, enforce symmetry, or trigger revalidation when descriptions change. `toolsAcceptable` sets in labeled evals go stale silently when new tools are added.

**Remedy:**
- Add symmetry validation to `/forge-eval` Phase 1: for every A→B overlap, verify B→A exists
- Add a coverage-gap report: tools with no golden evals, declared overlaps with no ambiguous eval, clusters with no multi-tool eval
- When a new tool is added with overlaps, emit a stale-eval report listing labeled evals whose `toolsAcceptable` may be under-specified
- When `/forge-tool` changes a description (rebuild flow), prompt: "This may affect routing with [listed overlaps]. Flag any for overlap removal?"

**Effort:** Low-Medium. Skill additions to existing workflows.

---

### W8. No Regression Testing Tier or A/B Comparison

**Problem:** Both golden and labeled evals are forward-looking. No mechanism to detect that a description change broke routing for previously-passing cases. No diff-based comparison between runs.

**Remedy:**
- Add a `regression` difficulty tier to `LabeledEvalCase`: generated once when a bug is found and fixed, never changed, cheap to run (seed-stable assertions only)
- Add a `baselineRunId` to `EvalSuiteResult` for simple "these cases passed before and fail now" diffing

**Effort:** Low. Schema addition + skill update.

---

### W9. Scaling Formula Is Uncalibrated

**Problem:** The formulas (`10+T`, `25+(O×2)+(C×1)`, `5+floor(T/3)`) are presented without derivation. The ambiguous count grows with declared overlaps but not registry size, so a poorly overlap-mapped registry systematically under-generates ambiguous cases.

**Remedy:**
- Treat the formula as a floor, not a fixed count
- Add a `failureWeights` concept: after running a suite, record failure distribution by tier, and let the formula skew toward tiers that are actually failing
- Weight overlaps by description similarity (not all overlaps are equally confusable)

**Effort:** Low. Formula refinement in skill + reference doc.

---

### W10. Missing Operational Infrastructure

**Problem:** No CONTRIBUTING.md, no GitHub issue templates, no community touchpoint, no releases. Naming collision risk with tool-forge.ai. Sends the signal of "personal project shared publicly" rather than "open-source project seeking adoption."

**Remedy:**
- Add minimal CONTRIBUTING.md (20 lines) with "where to ask questions"
- Add a "Scope" section to README explicitly naming Claude Code as the runtime
- Search audit on "tool-forge" across npm, PyPI, GitHub before publishing
- Consider disambiguation: "claude-tool-forge" or "forge-tools"
- Create GitHub Releases for versioned snapshots

**Effort:** Low. Standard OSS hygiene.

---

## Architectural Risks

### Risk 1: The LLM-as-Adapter Pattern Has No Quality Floor

The thesis that "the LLM IS the adapter layer" is technically correct and practically powerful. It is also the single point of failure. The quality of generated code, eval assertions, and MCP servers depends entirely on the LLM's capability at execution time. The same SKILL.md executed by a less capable model, in a compressed context window, or with significant context drift may produce subtly incorrect output that passes all tests but generates misleading evals.

This is compounded by the no-eval-runner design: there is no mechanically verifiable proof that the skill generated useful evals until a runner exists and the suite actually runs.

**Partial mitigation (cannot be fully eliminated):**
1. **Meta-eval specification:** Mechanical checks on generated eval cases — every golden eval must have 2+ `responseContains` values; no `responseContains` value may appear verbatim in the user prompt; every declared overlap must have at least one ambiguous case with `toolsAcceptable` containing both tools. Checkable by a JSON linter.
2. **Self-review pass (Phase 8.5):** After batch approval, the skill checks: "Can the LLM answer this prompt without calling any tool and still pass all assertions?" If yes, the case is not testing tool routing. Flag for revision.

### Risk 2: Routing Correctness Under Semantic Substitution (The Eval Blindspot)

The eval strategy tests known prompts against known tools. It cannot detect when an agent calls the "correct" tool for the wrong reason — a routing decision that happens to produce correct outputs on authored cases but fails on out-of-distribution inputs. This is the category of failure BFCL is designed to surface with held-out test sets.

**Partial mitigation:** Introduce a "semantic perturbation" pass in labeled eval generation. For each trigger phrase, generate 3 semantically similar but structurally different variants that should route identically, and 3 variants that look similar but should route differently. Tests for routing on semantic intent rather than surface keywords.

---

## Is There a Better Approach Entirely?

The council considered whether the concept should be abandoned in favor of alternatives:

| Alternative | Verdict |
|------------|---------|
| **OpenAPI-to-tool auto-generation** | Complementary, not competing. Auto-gen produces tools from existing API specs; Tool-Forge addresses tool *design* for cases where the API doesn't exist yet or the tool's scope differs from any single endpoint. |
| **Fine-tuning on tool routing** | Requires training data that doesn't exist until tools exist. Tool-Forge produces the tools and evals that could become fine-tuning data. Sequential, not competing. |
| **Tool RAG at scale** | Addresses discovery at 1000+ tools. Tool-Forge addresses quality at 5-50 tools. Different problem. |
| **Skip the workflow, just ship MCP servers** | The 17K+ MCP server ecosystem shows this is already happening. The result is servers with poor descriptions, no eval discipline, and routing failures at scale. Tool-Forge's thesis is that this approach is the *cause* of the problem. |
| **LLM-as-judge for everything** | More flexible but non-deterministic, expensive, and hard to debug. Tool-Forge's deterministic layer is the right foundation; LLM-as-judge belongs as a supplement (the `RubricEvalCase` tier), not a replacement. |

**Collective verdict:** The concept is sound. No alternative fully replaces it. The weaknesses are real but remediable — they are gaps in a correct architecture, not flaws in the thesis. The highest-priority fixes are the eval runner gap (W2), the README restructure (W3), and tool versioning (W1).

---

## Recommended Priority Order

| Priority | Item | Impact |
|----------|------|--------|
| 1 | Eval runner contract + reference implementation (W2) | Unblocks the entire eval value chain |
| 2 | README restructure — "why" first + adoption paths (W3) | First-impression conversion |
| 3 | Tool versioning + eval metadata (W1) | Prevents silent eval staleness |
| 4 | Meta-eval checks (Risk 1 mitigation) | Quality floor for generated evals |
| 5 | Overlap map maintenance automation (W7) | Scales the ambiguity coverage |
| 6 | MCP multi-tool bundling (W4) | Matches real MCP usage patterns |
| 7 | Architecture guide restructure (W6) | Broadens applicability |
| 8 | Regression tier + A/B comparison (W8) | Catches routing regressions |
| 9 | OSS operational infrastructure (W10) | Adoption readiness |
| 10 | Scaling formula calibration (W9) | Precision improvement |
