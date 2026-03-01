# Agent Tool Forge

Production LLM agent sidecar + Claude Code skill library for building, testing, and running tool-calling agents.

**Two jobs, one package:**
1. **Sidecar runtime** — deploy alongside your app. Handles the full ReAct loop, HITL gates, verifier pipeline, eval runner, and observability.
2. **Skill library** — Claude Code skills that generate tools, eval suites, and MCP servers via structured 12-phase dialogue.

---

## Quick Start

### As a runtime package

```bash
npm install agent-tool-forge
```

```js
import { createSidecar } from 'agent-tool-forge'

const { server, ctx, close } = await createSidecar(
  { auth: { mode: 'trust' } },
  { port: 8001 }
)

// server is already listening on port 8001
// call close() on shutdown for clean teardown
```

### With the TUI

```bash
node lib/index.js
```

See [docs/tui-workflow.md](docs/tui-workflow.md) for a start-to-finish walkthrough.

### Install Claude Code Skills

```bash
# Global install (available in all projects)
cp -r tool-forge/skills/forge-tool     ~/.claude/skills/
cp -r tool-forge/skills/forge-eval     ~/.claude/skills/
cp -r tool-forge/skills/forge-mcp      ~/.claude/skills/
cp -r tool-forge/skills/forge-verifier ~/.claude/skills/
```

Then in any Claude Code session:

```
/forge-tool      # 12-phase tool creation dialogue
/forge-eval      # Generate golden + labeled eval suites
/forge-mcp       # Generate an MCP server from a ToolDefinition
/forge-verifier  # Detect tools without verifiers, generate stubs
```

---

## Skills

| Skill | Purpose |
|-------|---------|
| `/forge-tool` | 12-phase structured dialogue: challenge necessity, lock the description contract, generate tool + tests + evals |
| `/forge-eval` | Generate golden (5-10 cases) and labeled (multi-tool) eval suites with deterministic assertions |
| `/forge-mcp` | Generate an MCP server scaffold from a ToolDefinition |
| `/forge-verifier` | Detect tools without verifier coverage, generate verifier stubs + barrel registration |

### The 12-Phase `/forge-tool` Dialogue

| Phase | What Happens |
|-------|-------------|
| 0 | **Creative exploration** — open-ended "what should this do?" |
| 1 | **Skeptic gate** — challenge necessity, overlap, scope |
| 2 | **Description + name** — lock the routing contract |
| 3 | **Collect fields** — schema, category, consequence level, confirmation flag |
| 4 | **Routing** — collect endpoint target, HTTP method, auth type, parameter mapping |
| 5 | **Dependency check** — verify the tool context provides what's needed |
| 6 | **Confirm full spec** — sign off before any code is written |
| 7 | **Generate all files** — tool, tests, barrel registration |
| 8 | **Run tests** — must be green before proceeding |
| 9 | **Generate evals** — hand off to `/forge-eval` |
| 10 | **Generate verifiers** — create verifier stubs for the new tool |
| 11 | **Done** — summary of everything created |

---

## Runtime Features

- **ReAct loop** — multi-turn LLM + tool execution, streamed via SSE
- **HITL** — four levels (autonomous → paranoid), pause/resume with 5-minute TTL
- **Verifiers** — post-response quality pipeline (warnings + flags, ACIRU ordering)
- **Eval runner** — `node lib/index.js run --eval <path>` executes eval JSON, checks assertions, stores results in SQLite; `--record` / `--replay` for fixture-based testing
- **Observability** — token tracking, cost estimation, per-tool metrics in SQLite
- **Web component** — `<forge-chat>` drop-in chat widget (vanilla JS, zero deps)

---

## Optional Peer Dependencies

The sidecar core requires only `better-sqlite3`. Additional backends are loaded on demand when configured — install them only if you use them:

| Package | When needed |
|---------|-------------|
| `redis` or `ioredis` | `conversation.store: 'redis'` or `rateLimit.enabled: true` with Redis backend |
| `pg` | `database.type: 'postgres'` — Postgres conversation store, agent registry, and preferences |

```bash
# Redis backend
npm install ioredis          # or: npm install redis

# Postgres backend
npm install pg
```

If a required package is missing, the sidecar prints an actionable error on startup rather than crashing at import time.

---

## Exported Subpaths

All subpaths ship with TypeScript declarations.

```js
import { createSidecar }      from 'agent-tool-forge'               // main entry
import { reactLoop }           from 'tool-forge/react-engine'
import { createAuth }          from 'tool-forge/auth'
import { makeConversationStore } from 'tool-forge/conversation-store'
import { mergeDefaults }       from 'tool-forge/config'
import { makeHitlEngine }      from 'tool-forge/hitl-engine'
import { makePromptStore }     from 'tool-forge/prompt-store'
import { makePreferenceStore } from 'tool-forge/preference-store'
import { makeRateLimiter }     from 'tool-forge/rate-limiter'
import { getDb }               from 'tool-forge/db'
import { initSSE }             from 'tool-forge/sse'
import { PostgresStore }       from 'tool-forge/postgres-store'
import { buildSidecarContext, createSidecarRouter } from 'tool-forge/forge-service'
```

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/tui-workflow.md](docs/tui-workflow.md) | TUI walkthrough, start to finish |
| [docs/reference/config.md](docs/reference/config.md) | `forge.config.json` field reference |
| [docs/reference/api.md](docs/reference/api.md) | HTTP endpoints, SSE events, HITL flow |
| [docs/eval-runner-contract.md](docs/eval-runner-contract.md) | Eval file format and assertion spec |
| [docs/API-DISCOVERY.md](docs/API-DISCOVERY.md) | API discovery TUI |
| [docs/VERIFIER-FACTORY.md](docs/VERIFIER-FACTORY.md) | Verifier gap detection and stub generation |

---

## Repo Structure

```
lib/
  sidecar.js              # createSidecar() — package entry point
  index.js                # TUI + CLI entry point
  react-engine.js         # ReAct loop, SSE streaming
  hitl-engine.js          # HITL pause/resume
  verifier-runner.js      # Post-response verifier pipeline
  eval-runner.js          # Eval execution engine
  checks/                 # Deterministic assertion checks
  fixtures/               # Record/replay fixture store
  comparison/             # Run comparison + Wilson statistics
  runner/                 # Gate evaluation + CLI
  views/                  # TUI screens
  db.js                   # SQLite persistence
skills/
  forge-tool/             # 12-phase tool creation workflow
  forge-eval/             # Golden + labeled eval generation
  forge-mcp/              # MCP server generation
  forge-verifier/         # Verifier gap detection + stub generation
templates/                # Pseudo-code reference templates
docs/
  tui-workflow.md         # Start-to-finish TUI guide
  reference/
    config.md             # forge.config.json reference
    api.md                # HTTP + SSE reference
  eval-runner-contract.md # Eval file format spec
  API-DISCOVERY.md        # API discovery workflow
  VERIFIER-FACTORY.md     # Verifier gap detection + stub generation
example/
  tools/                  # Example tool files
  verification/           # Example verifiers
docs/examples/            # Example evals (golden, labeled)
widget/
  forge-chat.js           # <forge-chat> web component
```

---

## Standing on Shoulders

Tool-Forge integrates ideas and code from two excellent open-source projects:

- **[evalkit](https://github.com/wkhori/evalkit)** by wkhori — MIT License
  Provides the deterministic check suite (`lib/checks/`): content matching, tool selection verification, schema validation, and the `runChecks()` meta-runner. Used under MIT license with attribution in each file.

- **[agent-eval-kit](https://github.com/FlanaganSe/agent-eval-kit)** by FlanaganSe — MIT License
  Provides fixture-based record/replay (`lib/fixtures/`), statistical comparison with Wilson confidence intervals (`lib/comparison/`), gate evaluation (`lib/runner/gate.js`), and composition operators (`lib/checks/compose.js`). Used under MIT license with attribution in each file.

---

## License

MIT
