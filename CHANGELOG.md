# Changelog

All notable changes to agent-tool-forge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.4.7] — 2026-03-01

### Fixed

- **README import paths** — all subpath imports now use `agent-tool-forge/…` (were incorrectly `tool-forge/…`)
- **README skills install** — `cp` commands now reference `node_modules/agent-tool-forge/skills/…`
- **`pgPool` missing `.on('error')` handler** — idle client disconnections no longer crash the Node process
- **`customRoutes` callback unhandled rejection** — errors in consumer-provided route handlers now return `500` instead of crashing
- **Preferences route method-not-allowed** — `PATCH`, `DELETE`, etc. on `/agent-api/user/preferences` now correctly return `405` (was an implicit `else` that could be confusing)
- **`auth.signingKey` env-var references** — `${VAR}` is now resolved at startup via `resolveSecret`; `buildSidecarContext` stores resolved auth config on the context object
- **`config.d.ts` `AuthConfig`** — added `adminToken`, `metricsToken`, and `mode: 'none'` (TypeScript consumers can now set all three without a type error)
- **`config.d.ts` `SidecarConfig`** — added `agent`, `gates`, and `fixtures` config blocks; removed `sidecar.enabled` (did nothing); clarified `sidecar.port` scope
- **`sidecar.d.ts` `VerifierRunner`** — fixed constructor signature: `pgPool` is the 3rd param (was `workerPool`)
- **`sidecar.d.ts` `createSidecarRouter`** — `opts` is now typed as `SidecarRouterOptions` with `widgetDir`, `mcpHandler`, and `customRoutes`; `buildSidecarContext` `opts` typed as `{ configPath?: string }`
- **`hitl-engine.d.ts`** — added `destroy()` method; `resume()` return type corrected to `Promise<unknown | null>`
- **`config.sidecar.enabled`** — removed from defaults (was a no-op field); `sidecar.port` documented as direct-run-only

### Added

- **`config/` directory in npm `files`** — `forge.config.template.json` now ships with the package
- **Auth tier table in `docs/reference/api.md`** — full route → tier → auth-requirement table; replaces the incorrect "all non-health routes require JWT" statement
- **`AgentRouterConfig`, `GatesConfig`, `FixturesConfig` interfaces** in `config.d.ts`

---

## [0.4.6] — 2026-03-01

### Added

- **Auth tiers (open/app/admin/scrape)** — centralized in `createSidecarRouter`; tier is determined by path prefix; all enforcement happens before route dispatch
- **`auth.adminToken` config field** — new canonical location for the admin Bearer token; resolves `${VAR}` env references at request time; `config.adminKey` still works as fallback for backward compat
- **`auth.metricsToken` config field** — reserved for the upcoming `/metrics` Prometheus endpoint (v0.5.0); open when not set, enforced when set
- **`resolveSecret(value, env)` export from `auth.js`** — expands `${VAR}` references in any token string; used internally for adminToken/metricsToken/adminKey resolution
- **`auth.mode: 'none'`** — bypass all auth tiers; intended for local dev / demo deployments

### Fixed

- **Security: `/agent-api/evals/summary` and `/agent-api/evals/runs` were unauthenticated** — now gated as admin tier (tier 2); require the same Bearer token as `/forge-admin/*` routes
- **`config.adminKey` env-var references (`"${VAR}"`) were used literally** — `resolveSecret` now expands them correctly before the timing-safe comparison

### Changed

- **`handlers/admin.js` and `handlers/agents.js`** — inline auth boilerplate removed; auth is now handled centrally by the router; `authenticateAdmin` import removed from both handlers
- **Route tier classification:**
  - Tier 0 (open): `/health`
  - Tier 1 (app/JWT): `/agent-api/chat*`, `/agent-api/user/*`, `/agent-api/conversations/*`, `/agent-api/tools`, `/widget/*`, `/mcp*`
  - Tier 2 (admin): `/forge-admin/*`, `/agent-api/evals/*`
  - Tier 3 (scrape): `/metrics` (schema-only, wired in v0.5.0)
- **Fail-closed**: if `auth.mode !== 'none'` and an admin route has no token configured → 503; prevents accidentally open admin endpoints

### Migration

- Existing `config.adminKey` users: no change required — router reads it as legacy fallback
- New canonical pattern: `{ "auth": { "adminToken": "${FORGE_ADMIN_KEY}" } }`
- `auth.mode: 'none'` users: no change — tier system bypassed entirely

### Tests

- +19 added, -5 removed = +15 net (754 total): `resolveSecret` (8 in `auth.test.js` — including `null` env guard), auth tier integration via `createSidecarRouter` (11 in `integration/sidecar.test.js` — including `/evals/runs`, `/agent-api/v1/evals/summary` versioned path, and all tier scenarios); removed 5 handler-level auth unit tests now covered by router integration tests

---

## [0.4.5] — 2026-03-01

### Added

- **`PostgresRateLimiter`** — Postgres-backed fixed-window rate limiter; uses atomic `INSERT … ON CONFLICT DO UPDATE` on the new `rate_limit_buckets` table; preferred over in-memory fallback when `pgPool` is available and no Redis client is configured
- **`makeRateLimiter(config, redis, pgPool)`** — third parameter `pgPool` added; factory selects `PostgresRateLimiter` when `pgPool` is provided and `redis` is null
- **`GET /agent-api/evals/summary`** — built-in sidecar route; returns per-tool eval summary via `ctx.evalStore.getEvalSummary()` (Postgres) or inline SQLite aggregation; also responds to `/agent-api/v1/evals/summary`
- **`GET /agent-api/evals/runs`** — built-in sidecar route; paginated eval run list via `ctx.evalStore.listRuns(limit, offset)` (Postgres) or SQLite; also responds to `/agent-api/v1/evals/runs`
- **`drift_alerts` table in Postgres SCHEMA** — mirrors the SQLite schema; created on startup via `CREATE TABLE IF NOT EXISTS`
- **`rate_limit_buckets` table in Postgres SCHEMA** — created on startup for use by `PostgresRateLimiter`
- **Drift monitor Postgres path** (`drift-background.js`) — `createDriftMonitor()` now accepts an optional fourth `pgCtx` argument `{ pgStore, evalStore, _pgPool }`; when provided, uses async Postgres queries instead of the synchronous SQLite helpers; drift detection now works correctly in Postgres-only deployments where `eval_runs` rows exist only in Postgres
- **Postgres context threading in `createSidecar()`** — when `ctx._pgPool` is set, `pgCtx` is automatically built and passed to `createDriftMonitor()`

### Fixed

- **Drift monitor silently reporting no drift in Postgres deployments** — the SQLite path read from a perpetually empty local `eval_runs` table; all drift alerts were missed; now correctly reads from Postgres when configured
- **Rate limiter always falling back to in-memory when Redis absent** — even when Postgres was available; now uses `PostgresRateLimiter` for durable, cross-instance rate limiting without Redis
- **`PostgresRateLimiter.check()` uncaught rejection on DB outage** — `pgPool.query()` was unguarded; a connection timeout would propagate through middleware and crash request handling; now fails open with a stderr log
- **Drift monitor TypeError on Postgres deployments with partially-initialized context** — `pgCtx` was built whenever `ctx._pgPool` was truthy, even if `pgStore`/`evalStore` were null; now all three must be non-null before passing to `createDriftMonitor()`
- **`getStats()` NaN/crash on empty `chat_audit` table** — missing `COALESCE` on `COUNT(*)` fields and no `rows[0]` null guard; `parseInt(null)` returned `NaN`; all aggregate columns now coalesced and the row result is guarded
- **Eval route SQLite error masked as `200 []`** — `GET /agent-api/evals/summary` and `/evals/runs` SQLite catch blocks returned `200 []` on database failure, hiding errors from callers; now returns `500`
- **`rate-limiter.d.ts` incorrect `RateLimiter` constructor** — phantom `pgPool` third parameter was declared on `RateLimiter` (which does not accept it); removed; `PostgresRateLimiter` is now a separate exported class declaration
- **`makeRateLimiter` return type wrong** — declared as `RateLimiter` but can return `PostgresRateLimiter`; corrected to `RateLimiter | PostgresRateLimiter`
- **`PostgresPreferenceStore` d.ts missing `env` constructor param** — third parameter was absent from the type declaration
- **`_pgPool` absent from `SidecarContext` interface** — the field is accessed directly at runtime; TypeScript consumers now have a typed declaration instead of falling through to the index signature

### Changed

- **TypeScript declarations fully updated** (`postgres-store.d.ts`, `sidecar.d.ts`, `rate-limiter.d.ts`) — all classes and methods added in the 0.4.x sprint now have accurate type declarations; `SidecarOptions.customRoutes`, `SidecarContext.evalStore/chatAuditStore/verifierStore/pgStore`, `makeRateLimiter` third parameter

### Tests

- +9 tests (739 total, 0 failures): `PostgresRateLimiter` (4), drift Postgres path (4), `makeRateLimiter` pgPool routing (1)

---

## [0.4.3] — 2026-03-01

### Added

- **`PostgresEvalStore.listRuns(limit, offset)`** — paginated flat list of all eval runs across all tools, newest first; completes the read API alongside `getEvalSummary()` and `getPerToolRunHistory()`
- **`customRoutes` option in `createSidecar()` and `createSidecarRouter()`** — async `(req, res, ctx) => boolean` hook injected before the built-in 404 fallback; return `true` if handled, `false` to fall through; eliminates the need for consumers to rewire the server's request listener stack

---

## [0.4.2] — 2026-03-01

### Added

- **`PostgresChatAuditStore.getStats()`** — aggregate query on `chat_audit`: total sessions, avg duration ms, error rate, messages in last 24 hours
- **`PostgresChatAuditStore.getSessions(limit, offset)`** — paginated list from `chat_audit`, newest first
- **`PostgresVerifierStore.insertVerifierResult()`** — moved from `PostgresStore` where it was stranded; now co-located with the config side of verifier management
- **`PostgresVerifierStore.getResults(toolName?, limit?)`** — read verifier run outcomes; optional tool filter, defaults to 100 rows newest-first

### Changed

- **`server.js` audit + verifier endpoints** — replaced raw `ctx._pgPool.query()` calls for `/audit/stats`, `/audit/sessions`, and `/verifier-results` with store method calls (`ctx.chatAuditStore.getStats()`, `ctx.chatAuditStore.getSessions()`, `ctx.verifierStore.getResults()`)
- **`PostgresStore.insertVerifierResult` removed** — consolidated onto `PostgresVerifierStore`; `PostgresStore` remains the base read/tool-registry store

### Tests

- 5 new tests: `getStats()` shape, `getSessions()` param forwarding, `insertVerifierResult()`, `getResults()` with filter, `getResults()` without filter

---

## [0.4.1] — 2026-03-01

### Fixed

- **`bin` paths in package.json** — removed leading `./` from `forge` and `forge-service` bin entries to pass npm validation

---

## [0.4.0] — 2026-03-01

### Added

- **`PostgresEvalStore`** — durable eval results on Railway/Postgres; `insertEvalRun()`, `insertEvalRunCases()`, `getEvalSummary()`, `getPerToolRunHistory()` fully transactional with Postgres
- **`PostgresChatAuditStore`** — persists `chat_audit` rows to Postgres; replaces ephemeral SQLite audit log when `DATABASE_URL` is set
- **`PostgresVerifierStore`** — persists verifier registry and tool bindings to Postgres; `upsertVerifier()`, `getAllVerifiers()`, `deleteVerifier()` (transactional), `upsertVerifierBinding()`, `getVerifiersForTool()`, `getBindingsForVerifier()`
- **`PostgresStore` write path for tool_registry** — `upsertToolRegistry()`, `getToolRegistry()`, `getAllToolRegistry()`, `updateToolLifecycle()` added to the existing base store class
- **Postgres schema additions** — `eval_runs`, `eval_run_cases`, `chat_audit`, `verifier_registry`, `verifier_tool_bindings` created on startup via `CREATE TABLE IF NOT EXISTS`
- **`auditLog()` helper in chat handlers** — all three chat handlers (`chat.js`, `chat-sync.js`, `chat-resume.js`) now route audit writes to `ctx.chatAuditStore` (Postgres) when available, falling back to SQLite
- **`eval-runner.js` Postgres fallback** — when `DATABASE_URL` is set, eval results write to Postgres instead of SQLite; `ownPool` tracking prevents double-`end()` when a pool is injected
- **`verifier-runner.js` Postgres load path** — `loadFromDb()` uses async Postgres queries when `pgPool` is supplied; `logResult()` fire-and-forgets to `verifier_results` via pgPool

### Fixed

- **JS `//` comment inside SQL template literal** (`postgres-store.js`) — `upsertVerifier()` had a JS comment embedded inside the backtick SQL string; Postgres syntax error on every call; moved to a JS comment outside the query
- **`rows[0]` unguarded access** (`postgres-store.js`) — `insertEvalRun()` and `insertChatAudit()` both returned `rows[0].id` without null guard; changed to `rows[0]?.id ?? null`
- **`deleteVerifier()` non-atomic deletes** (`postgres-store.js`) — two sequential `DELETE` statements without a transaction; could leave orphan bindings on partial failure; wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`
- **`logResult()` silent data loss** (`verifier-runner.js`) — when `this._db` is `null` (Postgres-only deployment), the method returned early without writing anything; added fire-and-forget Postgres path before the SQLite path
- **`loadFromDb()` sort crash on null `aciru_order`** (`verifier-runner.js`) — `localeCompare` called on potentially null values; added `?? 'Z-9999'` guard matching the existing `verify()` guard
- **`destroy()` incomplete timer cleanup** (`hitl-engine.js`) — only cleared `_pgCleanupTimer`; `_cleanupTimer` and `_sqliteCleanupTimer` were not cleared; now clears all three
- **`_ensurePgTable()` race condition** (`hitl-engine.js`) — concurrent callers could trigger multiple `CREATE TABLE` calls and register multiple `setInterval` cleanup timers; fixed with a promise-based gate (`_pgTableEnsurePromise`) that serializes all callers on a single in-flight promise
- **Redis per-user set not cleaned up on COMPLETE** (`conversation-store.js`) — the COMPLETE marker pipeline removed from the global active set but not the per-user set; added `sRem` to per-user set in `persistMessage()`
- **`deleteSession()` per-user set leak** (`conversation-store.js`) — `deleteSession()` did not remove the session from the per-user set; added `sRem` after the global set cleanup
- **`listSessions()` stale cleanup wrong set** (`conversation-store.js`) — stale entries were removed from the global set but the per-user set was not touched; now removes from both sets
- **`shutdown()` Redis drain missing** (`forge-service.js`) — `shutdown()` closed the pg pool but did not call `quit()` on the Redis client; added async drain with try/catch

### Tests

- 9 new tests in `postgres-store.test.js` covering `PostgresEvalStore`, `PostgresChatAuditStore`, `PostgresVerifierStore`, and `updateToolLifecycle` SQL injection prevention
- 4 new `destroy()` tests in `hitl-engine.test.js` covering in-memory, SQLite, Postgres, and pre-init teardown paths
- 2 new tests in `eval-runner.test.js` covering `ownPool=false` (injected pool not ended) and stderr write on DB failure

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

[0.4.5]: https://github.com/jsquire4/agent-tool-forge/compare/v0.4.3...v0.4.5
[0.4.3]: https://github.com/jsquire4/agent-tool-forge/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/jsquire4/agent-tool-forge/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jsquire4/agent-tool-forge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jsquire4/agent-tool-forge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jsquire4/agent-tool-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jsquire4/agent-tool-forge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jsquire4/agent-tool-forge/releases/tag/v0.1.0
