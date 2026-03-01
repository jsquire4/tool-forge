# Architecture Guide

How to build a production-ready agent tool system. This guide separates **core layers** (universal to every agent) from **topology patterns** (choose the one that fits your deployment). Each layer is independent — adopt what you need, skip what you don't.

---

## Overview

```
CORE LAYERS (every agent needs these)
  Layer 1: Static Tool Registry      — Drop-in tool registration via barrel files
  Layer 2: Verification Pipeline     — Post-hoc response validation
  Layer 3: Skill-Driven Factory      — Structured dialogue for tool creation
  Layer 4: Human-in-the-Loop (HITL)  — Confirmation gates for high-consequence tools
  Layer 5: Observability Pipeline    — Token tracking, cost estimation, per-tool metrics

TOPOLOGY PATTERNS (pick one, adapt as needed)
  Pattern A: Sidecar          — Agent as microservice alongside a host application
  Pattern B: Standalone       — Agent as the primary application
  Pattern C: Multi-Agent      — Agent as participant in an agent network
```

---

## Core Layers

### Layer 1: Static Tool Registry

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

#### ToolDefinition Shape

```
name              — snake_case identifier
description       — LLM-visible routing contract (what/when/when-not/source)
schema            — Validation schema (Zod, Pydantic, etc.)
category          — read | write | delete | side_effect
consequenceLevel  — low | medium | high
requiresConfirmation — boolean (triggers HITL gate)
timeout           — milliseconds
version           — semver (required — enables eval staleness detection)
status            — active | deprecated | removed
execute(params, context) → Promise<ToolResult>
```

#### ToolResult Shape

```
{ tool: string, fetchedAt: string, data?: unknown, error?: string }
```

No `success` boolean. Presence of `error` is the failure signal.

#### Tool Lifecycle

```
active → deprecated → removed
```

- **active** — In the registry, in the system prompt, evals run normally
- **deprecated** — In the registry (evals still run), hidden from AVAILABLE TOOLS (no new routing). Use when replacing a tool with a better alternative — keep evals passing while you migrate.
- **removed** — Excluded from everything. Kept in source for history. Evals archived.

The system prompt builder should filter: only `status === 'active'` tools appear in AVAILABLE TOOLS.

---

### Layer 2: Verification Pipeline

Verifiers run after the LLM generates a response, checking for quality, safety, and compliance issues. They follow the same drop-in pattern as tools: plain exports, barrel registration, auto-discovery.

#### Verifier Shape

```
name    — identifier
order   — lexicographic string for execution order (e.g., "A-0001", "R-0001")
verify(response, toolCalls, channel?) → { pass, warnings[], flags[] }
```

#### Severity Levels

- **Warnings** — Informational, never block. Stale data, low confidence, missing citations.
- **Flags** — Hard failures that short-circuit. Format violations, safety issues.

#### Example Categories

| Prefix | Category | Examples |
|--------|----------|----------|
| A-xxxx | Attribution | Source citation, data provenance |
| C-xxxx | Compliance | Regulatory checks, policy enforcement |
| I-xxxx | Interface | Format validation, length limits |
| R-xxxx | Risk | Concentration warnings, exposure limits |
| U-xxxx | Uncertainty | Confidence scoring, hedge language |

---

### Layer 3: Skill-Driven Factory

Two Claude Code skills form a sequential pipeline for tool creation:

#### Skill 1: /forge-tool (11 phases, 0–10)

```
Phase 0:  Start Forge Dialogue  — read registry, detect existing tools
Phase 1:  Creative exploration  — "what should this tool do?"
Phase 2:  Skeptic gate          — challenge necessity, overlap, scope
Phase 3:  Description + name    — lock the routing contract
Phase 4:  Remaining fields      — schema, category, consequence, confirmation
Phase 5:  Dependency check      — verify context provides what tool needs
Phase 6:  Full spec confirm     — user signs off before any file is written
Phase 7:  Generate all files    — tool, tests, barrel registration
Phase 8:  Run tests             — must be green before proceeding
Phase 9:  Generate evals        — hand off to /forge-eval
Phase 10: Report output         — summary of all files created
```

#### Skill 2: /forge-eval (auto-invoked after Phase 9)

- Generates 5-10 golden eval cases (single-tool routing sanity)
- Generates labeled eval cases that scale with registry size (multi-tool orchestration)
- Uses seed manifest for deterministic data references
- All assertions are code-based — no LLM-as-judge

**Why the factory matters:** Description quality is everything for tool routing. The skill's Phase 2 skeptic dialogue and Phase 3 description contract exist because bad descriptions cause misrouted tool calls. The eval suite catches these regressions mechanically.

---

### Layer 4: Human-in-the-Loop (HITL)

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

### Layer 5: Observability Pipeline

Token tracking, cost estimation, and per-tool metrics — persisted atomically per request.

#### Components

- **Token accumulator:** Callback handler that captures prompt + completion tokens across the entire agent loop (multiple LLM calls per request)
- **Cost estimator:** Rate table mapping model IDs to price per million tokens
- **Per-tool metrics:** `toolName, calledAt, durationMs, success, error`
- **Per-request metrics:** `userId, conversationId, totalLatencyMs, tokensIn, tokensOut, estimatedCostUsd, toolCallCount, toolSuccessRate`

#### Critical Rule

Observability must never block the response. Persist metrics best-effort; log and continue on failure. Metrics are in the side channel, not the critical path.

---

## Topology Patterns

Pick the pattern that matches your deployment. Most projects start with Standalone or Sidecar and never need Multi-Agent.

### Pattern A: Sidecar

The agent runs as a microservice alongside a host application. Use when the agent augments an existing product.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│  Host App    │────▶│  Agent       │
│              │     │  (your app)  │◀────│  (sidecar)   │
└──────────────┘     └──────────────┘     └──────────────┘
                           │                     │
                           ▼                     ▼
                     ┌──────────┐         ┌──────────┐
                     │    DB    │         │  Cache/   │
                     │          │         │  Redis    │
                     └──────────┘         └──────────┘
```

#### API Client

- Singleton service wrapping all host-app API calls
- Configurable timeout per request (e.g., 10 seconds via `AbortSignal.timeout`)
- Custom error class capturing status, message, and path
- Base URL from environment variable (localhost for dev, Docker DNS for prod)

#### Dual Auth Modes

Use a discriminated union:
- **User mode:** Raw JWT from the inbound request, passed through to the host-app
- **Service mode:** API token exchanged for a short-lived JWT via a token endpoint, cached with conservative TTL

Never mix user and service auth in the same code path.

#### Channel Capabilities

Output format constraints per delivery surface, injected into the system prompt at build time.

```
channel           — identifier (web-chat, cli, api, slack, csv-export)
supportedFormats  — plain | markdown | html | csv
maxResponseLength — optional character limit
```

The system prompt builder reads channel capabilities and generates format constraints. The LLM needs to know constraints before generating, not after.

#### Checkpoint Persistence

Conversation state stored in a fast key-value store (e.g., Redis), enabling:
- Conversation continuity across requests
- HITL interrupt/resume (the tool pauses, user approves, execution resumes)
- History via sorted set index (cursor-based pagination)

Key design decisions:
- Auto-refreshing TTL (e.g., 7 days) — conversations expire when inactive, not mid-use
- All writes batched in a single round-trip (pipeline pattern)
- Sorted set index for O(log N) history queries

#### Deployment

- **Dev:** Agent runs locally on host, infrastructure in containers with exposed ports, connectivity via `localhost:{port}`
- **Prod:** All services in containers on a shared network, container-to-container via DNS, base URL configured via environment variable

---

### Pattern B: Standalone

The agent is the primary application — no host app, no sidecar relationship. Use for CLI agents, batch processors, chatbots, or single-purpose tools.

```
┌──────────────┐     ┌──────────────┐
│   User       │────▶│  Agent       │
│   (CLI/Web)  │◀────│  (primary)   │
└──────────────┘     └──────────────┘
                           │
                     ┌─────┴─────┐
                     ▼           ▼
               ┌──────────┐ ┌──────────┐
               │ External │ │  Local   │
               │   APIs   │ │  State   │
               └──────────┘ └──────────┘
```

#### Differences from Sidecar

| Concern | Sidecar | Standalone |
|---------|---------|------------|
| API client | Wraps host-app API | Wraps external APIs directly |
| Auth | Dual mode (user JWT + service token) | Single mode (API keys or OAuth) |
| Channel capabilities | Multiple surfaces (web, slack, csv) | Usually one surface |
| Checkpoint persistence | Required (multi-request conversations) | Optional (many standalone agents are single-turn) |
| Deployment | Container alongside host app | Single container or bare process |

#### What You Skip

- No sidecar integration layer (no host-app client)
- Channel capabilities simplify to a single format
- Checkpoint persistence is optional — add it when conversations span multiple turns
- Deployment is straightforward: one process, one container

#### What You Keep

All five core layers still apply:
- Tool registry (Layer 1) — tools still need barrel registration
- Verification (Layer 2) — output quality still matters
- Skill factory (Layer 3) — tool creation still benefits from structured dialogue
- HITL (Layer 4) — write tools still need confirmation gates
- Observability (Layer 5) — you still need to know what your tools are doing

---

### Pattern C: Multi-Agent

The agent is one participant in a network of agents. Use when agents delegate to each other, share tool registries, or coordinate on tasks.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Orchestrator│────▶│  Agent A     │     │  Agent B     │
│              │────▶│  (tools 1-5) │     │  (tools 6-10)│
│              │────▶│              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
                           │                     │
                     ┌─────┴─────────────────────┘
                     ▼
               ┌──────────────────┐
               │  Shared Tool     │
               │  Registry        │
               │  (federated)     │
               └──────────────────┘
```

#### Additional Concerns

These concerns don't exist in Sidecar or Standalone:

**Tool namespacing.** When multiple agents share or expose tools, names can collide. Convention: `{agent}.{tool_name}` (e.g., `weather.get_forecast`, `portfolio.get_holdings`). The barrel registry becomes a federated registry — each agent exports its own tools, and an orchestrator merges them.

**Auth delegation.** Agent A calling Agent B's tool must propagate the original user's auth context, not Agent A's service credentials. The `ToolContext` needs a delegation chain:

```
ToolContext {
  userId: string;
  delegationChain: string[];  // ["orchestrator", "agent_a"] — audit trail
  auth: AuthCredentials;       // original user's credentials, not service-to-service
}
```

**Result attribution.** When an orchestrator synthesizes responses from multiple agents, the final response must attribute which agent (and which tool) produced each piece of data. The verification pipeline (Layer 2) should include an attribution verifier.

**Tool discovery.** In a static multi-agent system, tools are known at startup. In a dynamic system (agents join/leave), you need a discovery protocol. MCP's tool listing provides this — each agent can expose its tools as an MCP server, and the orchestrator queries available tools at runtime.

**Overlap management at scale.** With 50+ tools across multiple agents, the overlap map becomes a critical coordination artifact. Consider splitting it per-agent (each agent manages its own overlaps) with a federated overlap report that detects cross-agent confusion.

#### What Changes from Core Layers

| Core Layer | Multi-Agent Adaptation |
|-----------|----------------------|
| Registry | Federated — each agent exports, orchestrator merges |
| Verification | Add attribution verifier for multi-agent responses |
| Skill Factory | Generate tools aware of cross-agent overlaps |
| HITL | Propagate confirmation through delegation chain |
| Observability | Per-agent + aggregate metrics; trace across agents |

---

## Full Request Lifecycle

This example uses the Sidecar topology. Standalone and Multi-Agent follow the same core flow with different integration points.

```
POST /chat  { message, conversationId? }
  → Auth middleware (validate JWT, extract userId from claimsPath)
    → ReAct engine
      → Load conversation history from persistence layer
      → Build system prompt (tool registry → AVAILABLE TOOLS section)
      → Compute HITL auto-approve set from level × consequence matrix
      → Open SSE stream:
          emit: session { conversationId, sessionId }
      → Agent loop:
          LLM call
            → emit: text_delta { content } (per streaming chunk)
            → If tool call selected:
                emit: tool_call { tool, args, id }
                → HITL gate check
                    → If gated: store pause state (TTL 5 min), emit: hitl { resumeToken, ... }, end stream
                    → If auto: mcpRouting HTTP call → host app (forward JWT)
                        → emit: tool_result { tool, id, result, error }
                        → record tool metrics
                        → back to LLM with result
          (repeat until final text response or HITL interrupt)
      → If complete:
          → Run verifier pipeline (ACIRU order)
              → emit: tool_warning { ... } per verifier warning
              → flags short-circuit response if present
          → Persist: token usage, tool metrics, verifier results (SQLite, best-effort)
          → emit: done { conversationId, usage: { inputTokens, outputTokens } }
      → If error:
          → emit: error { code, message }
```

**Note:** Tool execution at runtime uses `mcpRouting` (HTTP call to host app). The `execute()` function in `.tool.js` files is for local testing only and is not invoked by the sidecar.

---

## Adoption Strategy

You don't need all layers. Start with:

1. **Layer 1 (Registry)** — Essential. The barrel pattern is the foundation.
2. **Layer 3 (Factory)** — Install `/forge-tool` and start building tools with structured dialogue.
3. **Layer 5 (Observability)** — Know what your tools are doing.

Then pick your topology:

| If your agent is... | Start with | Add later |
|---------------------|-----------|-----------|
| A standalone CLI/chatbot | Pattern B (Standalone) | Checkpoint persistence when conversations get long |
| An add-on to an existing app | Pattern A (Sidecar) | Channel capabilities when you serve multiple surfaces |
| One of several cooperating agents | Pattern C (Multi-Agent) | Federated registry when agents share tools |

Add remaining core layers as your agent matures:
- **HITL** when you add write tools
- **Verification** when you need quality gates
