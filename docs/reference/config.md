# forge.config.json Reference

`forge.config.json` lives in your project root. All fields are optional — the sidecar ships defaults for everything.

---

## Full Schema

```json
{
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "defaultModel": "claude-sonnet-4-6",
  "allowUserModelSelect": false,
  "port": 8001,

  "project": {
    "toolsDir": "example/tools",
    "evalsDir": "docs/examples",
    "name": "my-agent"
  },

  "auth": {
    "signingKey": "your-jwt-secret",
    "claimsPath": "sub"
  },

  "defaultHitlLevel": "cautious",

  "agent": {
    "endpoint": "http://localhost:3000/chat",
    "timeoutMs": 30000
  },

  "gates": {
    "passRate": 0.9,
    "p95LatencyMs": 15000,
    "_comment": "gates default to null (no gate) when omitted; values shown are recommended CI settings"
  },

  "fixtures": {
    "dir": ".forge-fixtures",
    "ttlDays": 30
  },

  "dbPath": "forge.db",
  "systemPromptPath": "system-prompt.txt",
  "model": "claude-sonnet-4-6",
  "modelMatrix": ["claude-sonnet-4-6", "gpt-4o-mini"]
}
```

---

## Fields

### API Keys

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `anthropicApiKey` | string | `ANTHROPIC_API_KEY` env | Anthropic API key. Falls back to environment variable. |
| `openaiApiKey` | string | `OPENAI_API_KEY` env | OpenAI API key. Falls back to environment variable. |

### Model

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultModel` | string | `claude-sonnet-4-6` | Model used for agent turns. |
| `model` | string | same as `defaultModel` | Override for eval runs specifically. |
| `allowUserModelSelect` | boolean | `false` | If true, users can select the model per conversation. |
| `modelMatrix` | string[] | `[]` | Models to run in parallel during multi-pass eval runs. |

### Server

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | `8001` | Port the sidecar listens on. |

### Project Paths

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project.toolsDir` | string | `example/tools` | Directory containing `.tool.js` files. |
| `project.evalsDir` | string | `docs/examples` | Directory containing eval JSON files. |
| `project.name` | string | — | Project identifier used in TUI and DB records. |
| `dbPath` | string | `forge.db` | Path to SQLite database. |
| `systemPromptPath` | string | — | Path to a text file used as the system prompt. |

### Auth

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auth.signingKey` | string | — | JWT signing secret. Required for authenticated endpoints. |
| `auth.claimsPath` | string | `sub` | Dot-path into JWT claims to extract the user ID (e.g. `sub`, `user.id`). |

### HITL

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultHitlLevel` | string | `cautious` | Default HITL level for all users. One of: `autonomous`, `cautious`, `standard`, `paranoid`. Root-level field. |

**HITL levels:**

| Level | Behavior |
|-------|----------|
| `autonomous` | No confirmations required. All tools execute automatically. |
| `cautious` | Pause only for tools with `requiresConfirmation: true`. |
| `standard` | Pause for any tool using a mutating HTTP method (POST, PUT, PATCH, DELETE). |
| `paranoid` | Confirm everything. All tool calls pause for approval. |

### Agent Endpoint (Eval Runner)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agent.endpoint` | string | — | HTTP endpoint the eval runner calls when not using the embedded sidecar. |
| `agent.timeoutMs` | number | `30000` | Per-case timeout in milliseconds. |

### Gates (CI)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gates.passRate` | number | `null` | Minimum fraction of eval cases that must pass (0-1). `null` = no gate. CI exits non-zero if set and violated. |
| `gates.p95LatencyMs` | number | `null` | Maximum p95 latency across cases in milliseconds. `null` = no gate. |

### Fixtures (Record/Replay)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fixtures.dir` | string | `.forge-fixtures` | Directory where recorded fixtures are stored (JSONL files, keyed by config hash). |
| `fixtures.ttlDays` | number | `30` | Fixtures older than this are ignored and re-recorded on next `--record` run. |

---

## Minimal Config (Sidecar)

```json
{
  "anthropicApiKey": "sk-ant-...",
  "auth": {
    "signingKey": "your-jwt-secret"
  }
}
```

## Minimal Config (Eval Runner Only)

```json
{
  "anthropicApiKey": "sk-ant-...",
  "project": {
    "toolsDir": "tools",
    "evalsDir": "evals"
  }
}
```

---

## Environment Variable Fallbacks

The sidecar also reads these environment variables directly if the config fields are not set:

| Env Var | Config Equivalent |
|---------|------------------|
| `ANTHROPIC_API_KEY` | `anthropicApiKey` |
| `OPENAI_API_KEY` | `openaiApiKey` |
| `PORT` | `port` |
| `JWT_SIGNING_KEY` | `auth.signingKey` |
