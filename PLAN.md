# Implementation Plan: Agent Chat Layer + MCP Runtime / API Scanner

## Chosen Approach

**Workstream A (WS-A):** A dedicated `forge-agent.js` TUI view with an explicit stage machine. Renders a blessed chat panel (log + textbox) with a stage indicator. Stage instructions loaded from SKILL.md files at runtime. Conversation history persisted in SQLite. Staged separately on `feat/forge-agent-chat` branch.

**Workstream B (WS-B):** `@modelcontextprotocol/sdk` mounted on forge-service.js as a `/mcp` route using `StreamableHTTPServerTransport` (works with raw Node.js `http.Server` — no Express needed). API scanner extends `api-loader.js` with a `computeCoverage` function. Static Bearer token auth (fail-closed). Staged separately on `feat/mcp-api-scanner` branch.

Both workstreams are independent and can be implemented in parallel. They share only `cli/db.js` additions, which are additive and non-conflicting.

## Key Architectural Decisions (settled pre-implementation)

**WS-A: forge-agent.js wraps forge-engine.js, does not bypass it.**
`forge-engine.js` handles mechanics: `llmTurn` calls, tool call detection, tool execution, file writing via forge-file-writer.js. `forge-agent.js` owns: stage progression, file-based prompt injection, conversation persistence, UI. Integration point: add optional `systemPromptOverride?: string` param to `forgeStep()` in `forge-engine.js`. forge-agent loads the stage skill file content and passes it as the override. One small forge-engine modification buys all tool execution and file writing for free.

**WS-A: Artifact generation is inherited from forge-engine.**
When the LLM emits a `write_tool` tool call during the `tool-writing` stage, forge-engine executes it as normal. forge-agent.js does not call forge-file-writer.js directly. `[STAGE_COMPLETE]` advances the stage indicator after files are written.

**WS-A: Session resumption on open.**
On view init, query `conversations` table for incomplete sessions. If one exists: show a one-line prompt `"Resume '[tool-name]' at [stage]? [R]esume / [N]ew"`. If multiple exist: show a short list (tool name + stage + timestamp). Selecting a session restores its message history into `apiMessages`.

**WS-B: `mcpRouting.endpoint` stores path only (e.g. `/api/portfolio/summary`), not a full URL.**
Base URL lives in `forge.config.json` as `api.baseUrl`. The MCP server resolves the full URL at call time: `config.api.baseUrl + tool.mcpRouting.endpoint`. This makes tools environment-portable and makes `computeCoverage` matching a simple path+method string comparison. forge-engine's routing phase prompt updated to collect path only, not a full URL.

**WS-A: Stage skill files are thin stubs for first pass.**
Content is minimal but structurally complete. Iterate on quality after the build is wired end-to-end.

---

## 1. Testing Strategy

### Framework: Vitest

Add to `package.json` devDependencies:
```json
"vitest": "^2.x",
"@vitest/coverage-v8": "^2.x"
```
Add scripts:
```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

Test file convention: `cli/**/*.test.js` co-located with source files. Shared test helpers in `tests/helpers/`.

### Shared Test Infrastructure

**`tests/helpers/view-context.js`** — `makeViewContext(overrides)` factory:
```js
export function makeViewContext(overrides = {}) {
  return {
    screen: { key: vi.fn(), unkey: vi.fn(), render: vi.fn(), focused: null, rows: 40 },
    content: { append: vi.fn(), remove: vi.fn() },
    config: {},
    navigate: vi.fn(),
    setFooter: vi.fn(),
    screenKey: vi.fn(),
    openPopup: vi.fn(),
    closePopup: vi.fn(),
    startService: vi.fn(),
    ...overrides
  };
}
```

**`tests/helpers/db.js`** — `makeTestDb()`:
```js
import { getDb } from '../../cli/db.js';
export const makeTestDb = () => getDb(':memory:');
```

**`tests/fixtures/stages/`** — Small `.md` files for stage loader tests (`orient.md`, `skeptic.md`).

**`tests/fixtures/openapi/`** — Small valid OpenAPI 3.x JSON file (5 paths) for coverage tests.

### Workstream A Test Cases

**Group 1: `loadStageSkill` — TDD**
- File exists → returns string content
- File missing → returns empty string, no throw
- `stagesDir` missing → returns empty string, no throw
- Empty file → returns `''`

**Group 2: `conversations` DB helpers — TDD**
- `insertConversationMessage` inserts and returns id
- `getConversationHistory` returns messages in order
- Empty session → returns `[]`
- 100+ messages → all returned
- `getDb` idempotent on existing DB (no duplicate table error)

**Group 3: Stage label computation — TDD**
- `computeStageLabel('orient', 8)` → `'Stage 1/8: orient'`
- Unknown phase → `'Stage ?/8: unknown'`
- `totalPhases = 0` → no divide-by-zero

**Group 4: LLM context injection — tested-after, mock `llmTurn`**
- System prompt includes stage skill content
- Missing stage file → system prompt uses fallback, no error
- API key absent → `llmTurn` not called, error message shown in log

**Group 5: View export contract — tested-after**
- `createView(context)` returns object with `.refresh` function
- Does not call `openPopup` synchronously on creation

### Workstream B Test Cases

**Group 1: `toolRegistryRowToMcpTool` — TDD**
- Valid spec → returns `{ name, description, inputSchema }`
- Null schema → `inputSchema = { type: 'object', properties: {} }`
- Malformed `spec_json` → returns null (caller skips)
- 20-field schema → all appear in `inputSchema.properties`

**Group 2: `tools/list` handler — integration**
- 3 promoted + 1 candidate + 1 retired → response has exactly 3 tools
- Empty registry → `tools: []`
- Malformed spec_json in one row → that tool skipped, others present

**Group 3: `tools/call` handler — integration, mock outbound HTTP**
- Happy path → response content includes app server output, `mcp_call_log` row inserted
- `paramMap` remapping applied correctly
- App returns 4xx → `isError: true`, log row with `status='error'`
- App unreachable → `isError: true`, no unhandled rejection
- Unknown tool name → `isError: true`, no log row inserted
- Non-promoted tool (candidate) → `isError: true`

**Group 4: Bearer token auth — E2E, safety-critical (write tests first)**
- `FORGE_MCP_KEY` not set → 401 for all requests
- Key set, no Authorization header → 401
- Key set, wrong token → 401
- Key set, correct token → request proceeds
- Key is empty string `''` → treated as unset, 401

**Group 5: `mcp_call_log` DB helpers — TDD**
- `insertMcpCallLog` inserts and returns id
- `getMcpCallLog(db, toolName)` returns rows DESC
- `getMcpCallLog(db, null)` returns all rows
- No rows → `[]`

**Group 6: `computeCoverage` — TDD, strongest candidate**
- 5 paths, 3 covered → `{ covered: 3, uncovered: 2, total: 5 }`
- Empty spec → `{ covered: 0, uncovered: 0, total: 0 }`
- No promoted tools → `{ covered: 0, uncovered: N, total: N }`
- `covered + uncovered === total` invariant always holds
- Multi-method path (GET + POST) → each method counted separately
- Malformed `mcpRouting` in tool → that tool does not match any path

**Group 7: Route registration — integration**
- `GET /health` unaffected after MCP mount
- `POST /enqueue` unaffected
- Unknown route → 404

---

## 2. Implementation Plan

### Workstream A Task Breakdown

**Branch:** `feat/forge-agent-chat` (off current `main`)

**A1 — Create stage skill files** _(no deps, start immediately)_
- `context/forge-agent/system-prompt.md` — agent identity, forge mission, `[STAGE_COMPLETE]` instructions
- `context/forge-agent/stages/orient.md`
- `context/forge-agent/stages/report.md`
- `context/forge-agent/stages/name-describe.md`
- `context/forge-agent/stages/skeptic.md`
- `context/forge-agent/stages/tool-writing.md`
- `context/forge-agent/stages/eval-writing.md`
- `context/forge-agent/stages/verifier-creation.md`
- `context/forge-agent/stages/promote.md`

**A2 — Add `conversations` table to `cli/db.js`** _(no deps, TDD first)_

Table schema:
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  stage      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_session
  ON conversations(session_id, created_at);
```

New exports:
- `createSession(db)` → returns a `crypto.randomUUID()` session ID string
- `insertConversationMessage(db, { session_id, stage, role, content })` → returns `lastInsertRowid`
- `getConversationHistory(db, session_id)` → returns messages array ordered by `created_at ASC`

**A3 — Create `cli/views/forge-agent.js`** _(depends on A2)_

Key design decisions:
- Layout: `phaseBar` (top, 1 row) + `blessed.log` (fills middle, auto-scroll) + `blessed.textbox` (input, 3 rows, bottom)
- Stage array: `['orient','report','name-describe','skeptic','tool-writing','eval-writing','verifier-creation','promote']`
- System prompt: `buildSystemPrompt(stageName, stageContent, baseContent)` — concatenates base + current stage skill
- Stage transition: scan LLM response for `[STAGE_COMPLETE]`, strip marker from displayed text
- Manual advance: `screenKey(']', nextStage)` and `screenKey('[', prevStage)` for user override
- Persistence: `insertConversationMessage` called for every user/assistant turn
- `wantsBackConfirm = true` on container (same as forge.js)
- Init: `setImmediate(() => { inputBox.focus(); screen.render(); })` after layout setup
- API key resolution: `resolveModelConfig(config, process.env)` same pattern as mediation.js

**A4 — Add entry to `cli/views/main-menu.js`** _(depends on A3)_
- Add `{ label: 'Forge Agent', key: '8', view: 'forge-agent' }` to `MENU_ITEMS`
- Update footer hints

### Workstream B Task Breakdown

**Branch:** `feat/mcp-api-scanner` (off current `main`)

**B1 — Install `@modelcontextprotocol/sdk`** _(no deps, start immediately)_
- `npm install @modelcontextprotocol/sdk`
- Verify ESM sub-path imports work: `import { Server } from '@modelcontextprotocol/sdk/server/index.js'`

**B2a — Add `mcp_call_log` table to `cli/db.js`** _(no deps, TDD first)_

Table schema:
```sql
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name   TEXT NOT NULL,
  called_at   TEXT NOT NULL,
  input_json  TEXT,
  output_json TEXT,
  status_code INTEGER,
  latency_ms  INTEGER,
  error       TEXT
);
```

New exports:
- `insertMcpCallLog(db, { tool_name, input_json, output_json, status_code, latency_ms, error })` → `lastInsertRowid`
- `getMcpCallLog(db, toolName = null, limit = 50)` → rows DESC

**B2b — Add `computeCoverage` to `cli/api-loader.js`** _(no deps, TDD first)_

```js
export function computeCoverage(spec, db) {
  const endpoints = parseOpenApiPaths(spec);
  const promoted = db.prepare(
    `SELECT spec_json FROM tool_registry WHERE lifecycle_state = 'promoted'`
  ).all();
  const promotedNames = new Set(promoted.map(r => {
    const s = safeParseJson(r.spec_json);
    return (s?.name || '').toLowerCase().replace(/-/g, '_');
  }).filter(Boolean));
  const normalize = e => (e.name || '').toLowerCase().replace(/-/g, '_');
  const covered = endpoints.filter(e => promotedNames.has(normalize(e)));
  const uncovered = endpoints.filter(e => !promotedNames.has(normalize(e)));
  return { covered, uncovered, total: endpoints.length };
}
```

**B3 — Create `cli/mcp-server.js`** _(depends on B1, B2a)_

Exports `createMcpServer(db, config, env)`:
- Creates `Server` from `@modelcontextprotocol/sdk/server/index.js`
- Registers `ListToolsRequestSchema` handler: queries `tool_registry` for promoted tools, maps to MCP tool shape
- Registers `CallToolRequestSchema` handler: looks up tool, calls `mcpRouting.endpoint` via `fetch`, logs result to `mcp_call_log`, returns MCP content
- Returns server instance (transport not attached here)

**B4 — Modify `cli/forge-service.js`** _(depends on B3)_

Four additions:
1. Import `createMcpServer` from `./mcp-server.js`
2. Read `FORGE_MCP_KEY` from `.env` at startup using inline env parser
3. Initialize DB at startup: `const db = getDb(config.dbPath || 'forge.db')`; initialize MCP server: `const mcpServer = await createMcpServer(db, config, process.env)`
4. Add `/mcp` route: validate Bearer token (fail-closed: 401 if key unset or wrong), delegate to SDK transport handler

**B5 — Update `.env.example`** _(no deps)_
```
# MCP Runtime auth key — required for all /mcp requests
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
FORGE_MCP_KEY=your_forge_mcp_key_here
```

---

## 3. Error Handling

### Workstream A

| Failure | Handling |
|---|---|
| LLM API failure (network, rate limit, invalid key) | Catch in `doStep`, append error message to log, keep session alive for retry |
| Stage skill file missing | `loadStageSkill` returns empty string (logged as warning in log widget), no crash |
| DB write failure (`insertConversationMessage`) | Log to stderr, continue — a lost row doesn't warrant crashing the session |
| False-positive `[STAGE_COMPLETE]` | User can rewind with `[` key; agent prompted in system-prompt.md to only emit when truly complete |
| Empty LLM response (`text = ''`) | Guard with `if (text)` before `appendAssistant()` — required by Anthropic alternating-message rule |
| `popupDepth` leak | Every `openPopup()` call has a matching `closePopup()` on ALL exit paths including catch blocks |
| User navigates away mid-session | `wantsBackConfirm = true` triggers confirmation dialogue; session persists in SQLite for resumption |

### Workstream B

| Failure | Handling |
|---|---|
| `FORGE_MCP_KEY` unset or empty string | 401 before any SDK/DB processing. Empty string treated as unset (fail-closed) |
| `@modelcontextprotocol/sdk` import fails | Catch in forge-service.js startup; log error; start service without MCP support (no `/mcp` route registered) |
| App endpoint unreachable (`tools/call`) | Catch fetch error; return `isError: true` with connection error message; log to `mcp_call_log` with `status='error'` |
| App endpoint returns 4xx/5xx | Treat as tool execution error; `isError: true`; include status code in message; log the call |
| Malformed `spec_json` in `tool_registry` | Skip that tool in `tools/list`; log warning to stderr; no 500 |
| `mcp_call_log` insert failure | Log to stderr; do not fail the MCP call itself (logging is not load-bearing) |
| `computeCoverage` called with null/invalid spec | Guard at entry: `if (!spec?.paths) return { covered: [], uncovered: [], total: 0 }` |
| DB unavailable in forge-service.js | Log error at startup; disable MCP route; service continues for existing queue/health routes |

---

## 4. Execution Strategy

### Branch Strategy

```
main
├── feat/forge-agent-chat     ← Workstream A
└── feat/mcp-api-scanner      ← Workstream B
```

Each branch is created from current `main`. They touch independent files (only `cli/db.js` is shared, and those additions are non-overlapping table names/function names). Each can be implemented, tested, and merged independently. If WS-A needs refactoring, WS-B is unaffected.

### Parallel Implementation Order

These tasks can run in parallel across both workstreams:

**Immediate (no deps):**
- WS-A: Create all 9 context/skill files (A1)
- WS-B: `npm install @modelcontextprotocol/sdk` (B1)
- WS-B: Write Vitest tests for `computeCoverage` and `mcp_call_log` helpers (TDD)

**After parallel foundation:**
- WS-A: Add `conversations` table to `cli/db.js` (A2, write tests first)
- WS-B: Add `mcp_call_log` table and `computeCoverage` to their files (B2a, B2b)

**Sequential within workstreams:**
- WS-A: `forge-agent.js` (A3) → main-menu entry (A4)
- WS-B: `mcp-server.js` (B3) → `forge-service.js` modifications (B4)

### Incremental Delivery

- WS-B db additions (B2a) and `computeCoverage` (B2b) can be merged to the branch before the MCP server is complete — they're independently useful and testable
- WS-A skill files (A1) can be merged early — they're static content with no code risk
- The `/mcp` route in forge-service.js is the last piece and can be feature-flagged: if `FORGE_MCP_KEY` is absent, the route simply doesn't respond (existing behavior preserved)

### Performance Considerations

- `tools/list` reads all promoted tools on every request. With a typical registry size (< 100 tools), this is a synchronous SQLite scan — acceptable. No caching needed at this scale.
- `computeCoverage` is called on-demand (not on every request). No performance concern.
- LLM streaming in forge-agent.js: current `api-client.js` buffers full responses. For now, full-response display is acceptable (matches all other views). Streaming is a future enhancement.

---

## 5. Definition of Done

### Workstream A
- [ ] `createView` exported from `cli/views/forge-agent.js`, reachable from main menu
- [ ] All 5 test groups passing (no mocked-out logic under test, only external dependencies mocked)
- [ ] `conversations` table present in `forge.db` after a session runs
- [ ] Stage skill files exist for all 8 stages — missing files degrade gracefully (no crash)
- [ ] Stage indicator updates on every phase transition (manual smoke test)
- [ ] `popupDepth` protocol followed — `openPopup`/`closePopup` balanced on all paths
- [ ] 90%+ coverage on `db.js` conversation helpers
- [ ] Code passes `/audit`
- [ ] `/retrospective` completed

### Workstream B
- [ ] `GET /health` still returns 200 after MCP mount (no regression)
- [ ] All Group 4 auth tests pass — server with no key rejects every `/mcp` request before any processing
- [ ] `tools/list` returns valid MCP response with promoted tools (verified with real MCP client or `curl`)
- [ ] `tools/call` inserts a `mcp_call_log` row on every call
- [ ] `computeCoverage` `covered + uncovered === total` invariant passes for all inputs
- [ ] 100% coverage on `mcp_call_log` and `computeCoverage` helpers
- [ ] `@modelcontextprotocol/sdk` in `dependencies` (not `devDependencies`)
- [ ] `FORGE_MCP_KEY` documented in `.env.example`
- [ ] Code passes `/audit`
- [ ] `/retrospective` completed
