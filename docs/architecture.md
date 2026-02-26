# Architecture Guide

How to build a production-ready agent tool system. This guide describes a 9-layer architecture proven in production, generalized for any framework. Each layer is independent — adopt what you need, skip what you don't.

---

## Overview

```
Layer 1: Static Tool Registry      — Drop-in tool registration via barrel files
Layer 2: Verification Pipeline     — Post-hoc response validation
Layer 3: Skill-Driven Factory      — Structured dialogue for tool creation
Layer 4: Human-in-the-Loop (HITL)  — Confirmation gates for high-consequence tools
Layer 5: Sidecar Integration       — API client for host application communication
Layer 6: Channel Capabilities      — Output format constraints per delivery surface
Layer 7: Checkpoint Persistence    — Conversation state storage for interrupts
Layer 8: Observability Pipeline    — Token tracking, cost estimation, per-tool metrics
Layer 9: Deployment Topology       — Dev/prod environment configuration
```

---

## Layer 1: Static Tool Registry

Tools are plain object exports conforming to a `ToolDefinition` interface — not classes, not DI providers. Adding a tool touches exactly two files:

```
1. Create: tools/<name>.tool.<ext>    (the tool implementation)
2. Edit:   tools/tools.exports.<ext>  (one export/registration line)
```

Everything else is automatic:
- An index file derives `ALL_TOOLS` via `Object.values()` or equivalent
- The agent service registers all tools at startup from `ALL_TOOLS`
- The system prompt builder auto-generates `AVAILABLE TOOLS:` from `ALL_TOOLS`
- Optional: an API endpoint exposes tool metadata for frontends

**Why this works:** No module registration. No decorator ceremony. No DI wiring. Single-line additions in the barrel file rarely cause merge conflicts, so multiple developers can add tools in parallel.

### ToolDefinition Shape

```
name              — snake_case identifier
description       — LLM-visible routing contract (what/when/when-not/source)
schema            — Validation schema (Zod, Pydantic, etc.)
category          — read | write | analysis
consequenceLevel  — low | medium | high
requiresConfirmation — boolean (triggers HITL gate)
timeout           — milliseconds
execute(params, context) → Promise<ToolResult>
```

### ToolResult Shape

```
{ tool: string, fetchedAt: string, data?: unknown, error?: string }
```

No `success` boolean. Presence of `error` is the failure signal.

---

## Layer 2: Verification Pipeline

Verifiers run after the LLM generates a response, checking for quality, safety, and compliance issues. They follow the same drop-in pattern as tools: plain exports, barrel registration, auto-discovery.

### Verifier Shape

```
name    — identifier
order   — lexicographic string for execution order (e.g., "A-0001", "R-0001")
verify(response, toolCalls, channel?) → { pass, warnings[], flags[] }
```

### Severity Levels

- **Warnings** — Informational, never block. Stale data, low confidence, missing citations.
- **Flags** — Hard failures that short-circuit. Format violations, safety issues.

### Example Categories

| Prefix | Category | Examples |
|--------|----------|----------|
| A-xxxx | Attribution | Source citation, data provenance |
| C-xxxx | Compliance | Regulatory checks, policy enforcement |
| I-xxxx | Interface | Format validation, length limits |
| R-xxxx | Risk | Concentration warnings, exposure limits |
| U-xxxx | Uncertainty | Confidence scoring, hedge language |

---

## Layer 3: Skill-Driven Factory

Two Claude Code skills form a sequential pipeline for tool creation:

### Skill 1: /forge-tool (10 phases)

```
Phase 0: Read registry         — discover existing tools
Phase 1: Creative exploration  — "what should this tool do?"
Phase 2: Skeptic gate          — challenge necessity, overlap, scope
Phase 3: Description + name    — lock the routing contract
Phase 4: Remaining fields      — schema, category, consequence, confirmation
Phase 5: Dependency check      — verify context provides what tool needs
Phase 6: Full spec confirm     — user signs off before any file is written
Phase 7: Generate all files    — tool, spec, barrel registration
Phase 8: Run tests             — must be green before proceeding
Phase 9: Generate evals        — hand off to /forge-eval
```

### Skill 2: /forge-eval (auto-invoked after Phase 9)

- Generates 5-10 golden eval cases (single-tool routing sanity)
- Generates labeled eval cases that scale with registry size (multi-tool orchestration)
- Uses seed manifest for deterministic data references
- All assertions are code-based — no LLM-as-judge

**Why the factory matters:** Description quality is everything for tool routing. The skill's Phase 2 skeptic dialogue and Phase 3 description contract exist because bad descriptions cause misrouted tool calls. The eval suite catches these regressions mechanically.

---

## Layer 4: Human-in-the-Loop (HITL)

A decision matrix maps `category × consequenceLevel → auto-approve | confirm`:

| | Low | Medium | High |
|---|---|---|---|
| **read** | auto | auto | confirm |
| **write** | confirm | confirm | confirm |
| **analysis** | auto | auto | confirm |

- Per-user, stored with TTL (e.g., 30 days in Redis)
- On interrupt: pending action stored with short TTL (e.g., 15 min)
- On approval: execution resumes from checkpoint
- Idempotent by design — checkpoint semantics guarantee same result on replay

---

## Layer 5: Sidecar Integration

The agent runs as a sidecar service alongside a host application. All host-app communication goes through a single API client.

### Client Pattern

- Singleton service wrapping all host-app API calls
- Configurable timeout per request (e.g., 10 seconds via `AbortSignal.timeout`)
- Custom error class capturing status, message, and path
- Base URL from environment variable (localhost for dev, Docker DNS for prod)

### Dual Auth Modes

Use a discriminated union:
- **User mode:** Raw JWT from the inbound request, passed through to the host-app
- **Service mode:** API token exchanged for a short-lived JWT via a token endpoint, cached with conservative TTL

Never mix user and service auth in the same code path — this prevents token leakage and privilege escalation.

---

## Layer 6: Channel Capabilities

Output format constraints per delivery surface, injected into the system prompt at build time.

### Channel Definition

```
channel           — identifier (web-chat, cli, api, slack, csv-export)
supportedFormats  — plain | markdown | html | csv
maxResponseLength — optional character limit
```

The system prompt builder reads channel capabilities and generates format constraints:
- CSV-only: "Respond only with CSV. No prose."
- Markdown-capable: "Use markdown for formatting."
- Length-constrained: appends max character count

**Why it belongs in the prompt:** The LLM needs to know constraints before generating, not after. Post-processing truncation produces broken responses.

---

## Layer 7: Checkpoint Persistence

Conversation state stored in a fast key-value store (e.g., Redis), enabling:
- Conversation continuity across requests
- HITL interrupt/resume (the tool pauses, user approves, execution resumes)
- History via sorted set index (cursor-based pagination)

### Key Design Decisions

- Auto-refreshing TTL (e.g., 7 days) — conversations expire when inactive, not mid-use
- All writes batched in a single round-trip (pipeline pattern)
- Sorted set index for O(log N) history queries
- Thread-keys set enables cleanup without key scanning

---

## Layer 8: Observability Pipeline

Token tracking, cost estimation, and per-tool metrics — persisted atomically per request.

### Components

- **Token accumulator:** Callback handler that captures prompt + completion tokens across the entire agent loop (multiple LLM calls per request)
- **Cost estimator:** Rate table mapping model IDs to price per million tokens
- **Per-tool metrics:** `toolName, calledAt, durationMs, success, error`
- **Per-request metrics:** `userId, conversationId, totalLatencyMs, tokensIn, tokensOut, estimatedCostUsd, toolCallCount, toolSuccessRate`

### Critical Rule

Observability must never block the response. Persist metrics best-effort; log and continue on failure. Metrics are in the side channel, not the critical path.

---

## Layer 9: Deployment Topology

### Dev Topology

- Agent runs locally on host (not containerized)
- Infrastructure (database, cache, host-app) runs in containers with exposed ports
- All connectivity via `localhost:{port}`

### Prod Topology

- All services in containers on a shared network
- Container-to-container via DNS (service names)
- Agent depends on all services with health check conditions
- Base URL configured via environment variable

**The key insight:** Dev/prod topology diverges at DNS only. One environment variable for the host-app base URL bridges the gap — no code changes between environments.

---

## Full Request Lifecycle

```
HTTP POST /chat
  → Controller (auth, sanitize)
    → Agent service
      → Load user context (auth passthrough)
      → Build system prompt (channel capabilities → format constraints)
      → Compute auto-approve set from HITL matrix
      → Build agent with tool registry + token callback
      → Agent loop:
          LLM → tool call → [HITL gate] → validate → execute → record metrics → back to LLM
          (repeat until final message or interrupt)
      → If interrupted: store pending action → return with pendingConfirmations
      → If complete: run verification pipeline
      → Persist metrics (atomic transaction)
  → Return response {message, toolCalls, warnings, flags, pendingConfirmations}
```

---

## Adoption Strategy

You don't need all 9 layers. Start with:

1. **Layer 1 (Registry)** — Essential. The barrel pattern is the foundation.
2. **Layer 3 (Factory)** — Install `/forge-tool` and start building tools with structured dialogue.
3. **Layer 8 (Observability)** — Know what your tools are doing.

Add layers as your agent matures:
- HITL when you add write tools
- Verification when you need quality gates
- Channel capabilities when you serve multiple surfaces
- Checkpoint persistence when conversations span multiple requests
