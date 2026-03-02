# HTTP + SSE API Reference

The agent-tool-forge sidecar exposes a small HTTP surface. All endpoints assume the sidecar is running on `http://localhost:8001` (configurable via `port` in `forge.config.json`).

All sidecar routes are prefixed with `/agent-api/`. Versioned paths (`/agent-api/v1/*`) are normalized to `/agent-api/*` automatically, so both work identically.

---

## Endpoints

### `POST /agent-api/chat`

Start a new conversation turn. Streams the response over SSE.

**Headers:**
```
Authorization: Bearer <JWT>
Content-Type: application/json
Accept: text/event-stream
```

**Body:**
```json
{
  "message": "What's my portfolio value?",
  "conversationId": "optional-existing-conversation-id",
  "model": "claude-sonnet-4-6"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `message` | yes | User's message text |
| `conversationId` | no | Resume an existing conversation. Omit to start a new one. |
| `model` | no | Override the model for this turn. Requires `allowUserModelSelect: true`. |

**Response:** SSE stream (see [SSE Events](#sse-events) below)

---

### `POST /agent-api/chat/resume`

Resume a conversation that was paused by a HITL gate.

**Headers:**
```
Authorization: Bearer <JWT>
Content-Type: application/json
Accept: text/event-stream
```

**Body:**
```json
{
  "resumeToken": "token-from-hitl-event",
  "confirmed": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `resumeToken` | yes | Resume token from the `hitl` SSE event. Single-use; atomically deleted on resume. |
| `confirmed` | yes | `true` to approve and continue. `false` to cancel. |

**Response:** SSE stream continuing from where the conversation paused. If `confirmed: false`, returns `{ "message": "Cancelled" }`.

**Note:** The resume token has a 5-minute TTL. Expired tokens are rejected with a `410 Gone` response.

---

### `POST /agent-api/chat-sync`

Synchronous (non-streaming) version of `/agent-api/chat`. Returns the complete response as JSON once the agent loop finishes. Useful for server-to-server calls where SSE is inconvenient.

Same request body as `/agent-api/chat`. Returns a JSON object with `response`, `toolCalls`, and `usage`.

---

### `GET /agent-api/tools`

List all registered tools (name, description, category, status).

**Headers:** `Authorization: Bearer <JWT>`

**Response:** `{ tools: ToolDefinition[] }`

---

### `GET /agent-api/conversations`, `GET /agent-api/conversations/:id`

List conversations for the authenticated user, or fetch a specific conversation with its message history.

---

### `GET /agent-api/user/preferences`, `PUT /agent-api/user/preferences`

Get or update per-user preferences (HITL level, model selection).

---

### `GET /health`

Health check.

**Response:**
```json
{ "status": "ok", "model": "claude-sonnet-4-6" }
```

---

## SSE Events

All SSE events follow the format:
```
event: <event-type>
data: <JSON payload>

```

Events arrive in this sequence for a typical successful turn:

```
session → (text_delta)* → [tool_call → tool_result]* → done
```

For HITL-interrupted turns:
```
session → (text_delta)* → tool_call → hitl
```

---

### `session`

Sent immediately on connection. Contains the conversation ID to include in subsequent requests.

```json
{
  "conversationId": "conv_abc123",
  "sessionId": "sess_xyz789"
}
```

---

### `text`

Complete text response (sent after all tool calls resolve). Not streamed.

```json
{
  "content": "Your portfolio value is $125,432."
}
```

---

### `text_delta`

Incremental text chunk during streaming.

```json
{
  "content": "Your portfolio"
}
```

---

### `tool_call`

A tool is about to be called.

```json
{
  "tool": "get_portfolio_value",
  "args": { "currency": "USD" },
  "id": "toolu_01abc"
}
```

---

### `tool_result`

Result of a tool call. `error` is present only on failure.

```json
{
  "tool": "get_portfolio_value",
  "id": "toolu_01abc",
  "result": { "value": 125432, "currency": "USD", "fetchedAt": "2026-02-28T10:00:00Z" },
  "error": null
}
```

---

### `tool_warning`

Verifier issued a warning (non-blocking).

```json
{
  "tool": "get_portfolio_value",
  "warning": "Data is 4 hours old. Consider refreshing."
}
```

---

### `hitl`

The agent has paused for human confirmation. Resume with `POST /resume`.

```json
{
  "sessionId": "sess_xyz789",
  "resumeToken": "rtok_abc123",
  "tool": "rebalance_portfolio",
  "args": { "targetAllocation": { "AAPL": 0.3, "MSFT": 0.7 } },
  "message": "This will rebalance your portfolio. Confirm?"
}
```

The `resumeToken` is single-use and expires after 5 minutes.

---

### `done`

Final event. Contains token usage for the full turn.

```json
{
  "conversationId": "conv_abc123",
  "usage": {
    "inputTokens": 1240,
    "outputTokens": 187
  }
}
```

---

### `error`

An unrecoverable error occurred. The stream closes after this event.

```json
{
  "code": "tool_execution_error",
  "message": "Tool get_portfolio_value timed out after 10000ms"
}
```

---

## Web Component

The `<forge-chat>` web component connects to the sidecar automatically.

```html
<script src="/widget/forge-chat.js"></script>

<forge-chat
  endpoint="http://localhost:8001"
  token="YOUR_JWT_HERE"
  theme="light"
  agent="Portfolio Assistant">
</forge-chat>
```

| Attribute | Required | Description |
|-----------|----------|-------------|
| `endpoint` | yes | Sidecar base URL |
| `token` | yes | JWT for auth |
| `theme` | no | `light` or `dark` |
| `agent` | no | Display name shown in the chat header |

The component handles SSE streaming, HITL confirmation dialogs, and conversation continuity automatically. No framework required — vanilla JS, zero dependencies.

---

## Authentication

The sidecar uses tiered authentication. Routes fall into one of four tiers:

| Tier | Name | Routes | Auth required |
|------|------|--------|---------------|
| 0 | Open | `GET /health` | None |
| 1 | App (JWT) | `POST /agent-api/chat`, `POST /agent-api/chat-sync`, `POST /agent-api/chat/resume`, `GET /agent-api/tools`, `GET /agent-api/conversations*`, `GET /agent-api/user/preferences`, `PUT /agent-api/user/preferences`, `/widget/*`, `/mcp*` | Bearer JWT |
| 2 | Admin (token) | `GET /forge-admin/config`, `PUT /forge-admin/config/:section`, `/forge-admin/agents*`, `GET /agent-api/evals/summary`, `GET /agent-api/evals/runs` | Static Bearer token |
| 3 | Metrics | `GET /metrics` | Static Bearer token (open if `auth.metricsToken` not set) |

Versioned paths (`/agent-api/v1/*`) are normalized to `/agent-api/*` automatically.

Setting `auth.mode: 'none'` in `forge.config.json` bypasses all auth checks (intended for local development only).

### App tier (JWT)

Tier 1 routes require a valid JWT in the `Authorization` header:

```
Authorization: Bearer <JWT>
```

The JWT is validated using `auth.signingKey` from `forge.config.json` when `auth.mode` is `'verify'`. In `'trust'` mode the signature is not checked — the payload is decoded directly (suitable when the sidecar sits behind a trusted API gateway).

The user ID is extracted from the claims at `auth.claimsPath` (default: `sub`). The JWT is forwarded as-is to all host app API calls the sidecar makes via `mcpRouting` — enabling row-level auth in the host app without credential translation.

Tokens may be passed as a query parameter instead of the Authorization header: `?token=<JWT>`.

### Admin tier (static token)

Tier 2 routes require a static Bearer token matching `auth.adminToken` (or the deprecated `adminKey`) in `forge.config.json`. Both fields support `${ENV_VAR}` references:

```json
{ "auth": { "adminToken": "${FORGE_ADMIN_KEY}" } }
```

If no admin token is configured and `auth.mode` is not `'none'`, admin routes return `503 Service Unavailable`.

### Metrics tier (optional token)

`GET /metrics` is open by default. Set `auth.metricsToken` to require a Bearer token from your scraper.

---

## Tool Execution Model

The sidecar does **not** call the `execute()` function inside `.tool.js` files at runtime. The `execute()` stub in tool files is for local testing only.

At runtime, when the LLM selects a tool, the sidecar:
1. Reads the tool's `mcpRouting` config (HTTP method + path template)
2. Resolves path parameters from the LLM's tool call arguments
3. Makes an HTTP call to the host app with the user's JWT
4. Returns the response to the LLM as the tool result

This means the host app enforces all business logic and authorization — the sidecar is purely a routing layer.
