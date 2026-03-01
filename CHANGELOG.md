# Changelog

All notable changes to tool-forge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.0] — 2026-03-01

### Added

- **Stub-based multi-turn eval execution** — eval cases can now supply a `stubs` map that feeds synthetic tool results back into the ReAct loop, enabling true end-to-end routing tests without a live API endpoint
- **`stubbedReactTurn()`** exported from `eval-runner.js` — single-turn or multi-turn (up to `maxTurns`) eval execution with fixture injection; OpenAI-compat (`tool_calls`/`role:tool`) and Anthropic (`tool_use`/`tool_result`) wire formats both supported
- **TypeScript declarations** — `.d.ts` files for all public exports: `sidecar`, `auth`, `react-engine`, `config`, `conversation-store`, `hitl-engine`, `prompt-store`, `preference-store`, `rate-limiter`, `db`, `sse`, `postgres-store`, `forge-service`
- **`noToolErrors` assertion** — eval cases can assert that all called tools had a registered stub (routing error guard for stub-based runs)
- **`maxCost` assertion** — eval cases can assert that total token cost stays under a threshold; uses live `computeActualCost()` calculation
- **`checkResponseContainsAnyGroups` normalization** — normalizes flat `string[]` input to `string[][]` internally; both call sites are covered without changes
- **Eval runner CLI** — `node lib/index.js run --eval <path>` for non-TUI eval execution
- **`--record` / `--replay` flags** — fixture-based record/replay for deterministic eval reruns

### Changed

- **`passRate` denominator** — now `passed / (passed + failed)`; skipped cases are excluded from the denominator in both `eval-runner.js` and `runner/index.js`
- **Renamed `cli/` → `lib/`** — all imports, package.json exports, and bin entries updated; no functional change
- **Shared `DEFAULT_MIX` constant** — golden/labeled case counts now exported from one location to prevent eval count drift between the engine prompt and the generator

### Fixed

- `schemaMatch` gate now fires for `typeChecks`-only cases (previously silently skipped when `requiredKeys` was absent from the adapter)
- `check-adapter.js` always sets `requiredKeys` (defaults to `[]`) so the gate and adapter remain in sync
- TUI eval-run view passRate display now computed inline from `summary.passed / (summary.passed + summary.failed)` — avoids assuming a `passRate` field that `runEvals()` does not return
- Stale `lastValidationError` now cleared on new user input in the forge engine
- Path traversal guard applied to `spec.name` in file-writer and verifier-generator

---

## [0.2.0] — 2026-02-28

### Added

- **Multi-agent registry** — `AgentRegistry` with per-agent system prompts, tool allowlists, HITL levels, model selection, and `seedFromConfig()` for declarative bootstrap
- **Redis conversation store** — `RedisConversationStore` with TTL-based session expiry and best-effort stale-entry cleanup
- **Postgres backends** — `PostgresStore` adapter covering prompt versions, user preferences, agent registry, and tool registry; selected automatically when `database.type === 'postgres'`
- **Rate limiting** — `RateLimiter` (Redis or in-memory fixed-window), injected into all chat endpoints; limited by `userId`, not IP
- **Chat audit log** — `chat_audit` table + `insertChatAudit()`, written in a `finally` block for every chat and chat-sync request
- **Verifier sandbox** — `VerifierWorkerPool` runs custom verifiers in worker threads; `role` field controls whether a block outcome halts the request or logs a warning
- **HITL SQLite cleanup** — 5-minute `setInterval` (`.unref()`'d) purges expired rows from `hitl_pending`
- **Token-level SSE streaming** — `text_delta` events streamed from provider to the `<forge-chat>` widget for live typing effect
- **`forge init` wizard** — interactive setup that writes `.env` and `forge.config.json`
- **`<forge-chat>` web component** — zero-dependency drop-in chat widget (`widget/forge-chat.js`)
- **Admin overlay persistence** — atomic `writeFileSync`+`renameSync` to `forge.config.json`; graceful on failure

### Changed

- `buildSidecarContext` now selects Redis/Postgres clients dynamically based on config; synchronous factories stay synchronous
- `AgentRegistry.resolveAgent()` falls through to the default agent when `agentId` is `null`
- `reactLoop` and `mcp-server.js` forward `userJwt` to outbound tool HTTP calls

### Fixed

- `chat-resume.js` guard order: confirmation check now runs before engine existence check so cancellations return `200 Cancelled` instead of `501`
- `RedisConversationStore.listSessions` stale-entry cleanup wrapped in `try/catch`; concurrent `lIndex` calls batched with `Promise.all`
- `assertSafeUrl` in `init.js`: strips `[`/`]` brackets before IPv6 regex; bare prefix `/^fc/i` catches short-form ULA addresses like `fc::1`
- Provider branching in `react-engine.js` for `tool_calls` history: OpenAI-compat format uses flat `tool_calls` + `role: 'tool'` messages; Anthropic format uses content arrays

---

## [0.1.0] — 2026-02-27

### Added

- **`createSidecar()` factory** — single-call setup: initializes SQLite (WAL mode), builds context, starts HTTP server
- **ReAct loop** (`react-engine.js`) — multi-turn LLM + tool execution with SSE streaming; `reactLoop()` async generator emits typed events (`text`, `text_delta`, `tool_call`, `tool_result`, `tool_warning`, `hitl`, `error`, `done`)
- **HITL engine** (`hitl-engine.js`) — four sensitivity levels (autonomous → paranoid), pause/resume with 5-minute TTL; SQLite, Redis, and in-memory backends
- **Verifier pipeline** (`verifier-runner.js`) — ACIRU ordering (Attribution → Compliance → Interface → Risk → Uncertainty); `block` outcome short-circuits, `warn` continues
- **Eval runner** (`eval-runner.js`) — routing-only mode (single LLM turn, checks tool selection); golden and labeled eval file formats; results stored in SQLite
- **Multi-provider LLM client** (`api-client.js`) — Anthropic, OpenAI, Gemini (via OpenAI-compat), DeepSeek; `modelConfigForName()` resolves provider + key + model from a single name string
- **Auth module** (`auth.js`) — JWT `trust` mode (no verification) and `verify` mode (RS256/HS256); `authenticateAdmin()` for admin endpoints
- **Drift monitor** (`drift-background.js`) — detects pass-rate regressions after tool promotion; fires `drift_alerts` records; synchronous compute layer, no async
- **`forge-tool` skill** — 12-phase Claude Code dialogue: explore → skeptic → description contract → schema → routing → dependency check → sign-off → generate → test → evals → verifiers → done
- **`forge-eval` skill** — generates golden (5–10 positive cases) and labeled (multi-tool disambiguation) eval suites with deterministic assertions
- **`forge-mcp` skill** — generates MCP server scaffolds from a `ToolDefinition`
- **`forge-verifier` skill** — detects tools without verifier coverage, generates verifier stubs + barrel registration
- **SQLite schema** — `eval_runs`, `eval_run_cases`, `tool_registry`, `drift_alerts`, `tool_generations`, `model_comparisons`, `conversations`, `mcp_call_log`, `prompt_versions`, `user_preferences`, `verifier_results`, `verifier_registry`, `verifier_tool_bindings`, `hitl_pending`, `agent_registry`, `chat_audit`
- **TUI** (`lib/index.js`) — blessed-based terminal interface with main menu, tools & evals view, model comparison, drift monitor, forge workflow, onboarding, and settings screens
- **HTTP sidecar endpoints**: `POST /agent-api/chat` (SSE), `POST /agent-api/chat-sync`, `POST /agent-api/chat/resume`, `GET/PUT /agent-api/user/preferences`, `GET /agent-api/conversations`, `GET /agent-api/tools`, `PUT /forge-admin/config/:section`, `GET/POST/PUT/DELETE /forge-admin/agents*`

[0.3.0]: https://github.com/jsquire4/tool-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jsquire4/tool-forge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jsquire4/tool-forge/releases/tag/v0.1.0
