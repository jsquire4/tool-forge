# ToolDefinition + ToolResult Specification

## ToolDefinition

The universal shape for an LLM agent tool. Every tool in the registry conforms to this interface.

### Required Fields

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | snake_case identifier. Verb-noun preferred: `get_holdings`, `check_wash_sale` |
| `description` | string | **The routing contract.** See `description-contract.md` for format |
| `schema` | Schema | Input validation schema (Zod, Pydantic, JSON Schema, etc.) |
| `category` | `'read' \| 'write' \| 'delete' \| 'side_effect'` | Mutation classification |
| `consequenceLevel` | `'low' \| 'medium' \| 'high'` | Real-world impact level |
| `requiresConfirmation` | boolean | Whether the agent pauses for user approval |
| `timeout` | number (ms) | Execution timeout. Default: 15000 |
| `execute` | function | `(params, context) → Promise<ToolResult>` |

### Optional Fields

| Field | Type | Purpose |
|-------|------|---------|
| `tags` | string[] | Domain tags for filtering: `['portfolio', 'risk']` |
| `version` | string | Semantic version if tools are versioned independently |
| `dependsOn` | string[] | Names of other tools this tool calls internally |

### Category Definitions

- **read** — Retrieves data from an external source. No mutations. Safe to auto-approve in most cases.
- **write** — Performs mutations (creates, updates). Usually requires confirmation.
- **delete** — Permanently removes data. High consequence; typically requires confirmation.
- **side_effect** — Triggers external side effects (sends emails, fires webhooks, etc.). May or may not require confirmation depending on reversibility.

### Consequence Level

Independent of category. A read tool can be high-consequence (expensive API call). A write tool can be low-consequence (safe idempotent operation).

- **low** — No real-world impact. Read-only, summaries, general queries.
- **medium** — Moderate impact. Analysis that could influence financial/business decisions.
- **high** — Significant impact. Trades, account changes, deletions, irreversible operations.

### requiresConfirmation

Collect **separately** from category. Never infer one from the other.

When `true`, the agent must pause execution and wait for explicit user approval before running `execute()`. Implementation depends on your framework:

- **LangGraph:** `interrupt()` / `isGraphInterrupt()` pattern
- **Custom webhook:** POST to approval endpoint, poll for response
- **CLI:** Print summary, wait for y/n input
- **Chat UI:** Send confirmation card, wait for button click

---

## ToolResult

The return shape from every tool's `execute()` function.

```
{
  tool:      string    // snake_case name matching ToolDefinition.name
  fetchedAt: string    // ISO 8601 timestamp: "2025-01-15T10:30:00.000Z"
  data?:     unknown   // Success payload (tool-specific shape)
  error?:    string    // Human-readable error message
}
```

### Constraints

1. **No `success` boolean.** Presence of `error` is the failure signal.
2. **No `timestamp` field.** The field is called `fetchedAt`.
3. **`execute()` must never throw.** Catch all errors, return them in `error`. Exception: re-throw HITL framework interrupts.
4. **`fetchedAt` is always set**, even on error. Marks when the attempt was made.
5. **`data` and `error` are mutually exclusive.** Success: `data` present, `error` absent. Failure: `error` present, `data` absent.

---

## ToolContext

The context every tool receives at execution time.

### Standard Fields

| Field | Type | Purpose |
|-------|------|---------|
| `userId` | string | Authenticated user identifier |
| `abortSignal` | AbortSignal | Request cancellation signal |
| `auth` | AuthCredentials | Authentication credentials (JWT, API key, etc.) |
| `client` | ApiClient | HTTP/gRPC client for external API calls |

### Extension

Add services to ToolContext when tools need capabilities beyond the standard set. See `extension-points.md`.

### AbortSignal Contract

Every tool MUST check `context.abortSignal?.aborted` before performing any I/O operation. If aborted, return immediately:

```
{
  tool: '<name>',
  fetchedAt: new Date().toISOString(),
  error: 'Request was cancelled'
}
```
