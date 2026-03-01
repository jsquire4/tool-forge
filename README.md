# tool-forge

Production LLM agent sidecar + Claude Code skill library for building, testing, and running tool-calling agents.

**Two jobs, one package:**
1. **Sidecar runtime** — deploy alongside your app. Handles the full ReAct loop, HITL gates, verifier pipeline, eval runner, and observability.
2. **Skill library** — Claude Code skills that generate tools, eval suites, and MCP servers via structured 11-phase dialogue.

---

## Quick Start

### As a runtime package

```bash
npm install tool-forge
```

```js
import { createSidecar } from 'tool-forge'
import { ALL_TOOLS } from './tools/index.js'

const sidecar = createSidecar({
  tools: ALL_TOOLS,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
})

sidecar.listen(8001)
```

### With the TUI

```bash
node lib/index.js
```

See [docs/tui-workflow.md](docs/tui-workflow.md) for a start-to-finish walkthrough.

### Install Claude Code Skills

```bash
# Global install (available in all projects)
cp -r tool-forge/skills/forge-tool ~/.claude/skills/
cp -r tool-forge/skills/forge-eval ~/.claude/skills/
cp -r tool-forge/skills/forge-mcp  ~/.claude/skills/
```

Then in any Claude Code session:

```
/forge-tool    # 11-phase tool creation dialogue
/forge-eval    # Generate golden + labeled eval suites
/forge-mcp     # Generate an MCP server from a ToolDefinition
```

---

## Skills

| Skill | Purpose |
|-------|---------|
| `/forge-tool` | 11-phase structured dialogue: challenge necessity, lock the description contract, generate tool + tests + evals |
| `/forge-eval` | Generate golden (5-10 cases) and labeled (multi-tool) eval suites with deterministic assertions |
| `/forge-mcp` | Generate an MCP server scaffold from a ToolDefinition |

### The 11-Phase `/forge-tool` Dialogue

| Phase | What Happens |
|-------|-------------|
| 0 | **Start** — read registry, detect existing tools |
| 1 | **Creative exploration** — open-ended "what should this do?" |
| 2 | **Skeptic gate** — challenge necessity, overlap, scope |
| 3 | **Description + name** — lock the routing contract |
| 4 | **Collect fields** — schema, category, consequence level, confirmation flag |
| 5 | **Dependency check** — verify the tool context provides what's needed |
| 6 | **Confirm full spec** — sign off before any code is written |
| 7 | **Generate all files** — tool, tests, barrel registration |
| 8 | **Run tests** — must be green before proceeding |
| 9 | **Generate evals** — hand off to `/forge-eval` |
| 10 | **Report output** — summary of everything created |

---

## Runtime Features

- **ReAct loop** — multi-turn LLM + tool execution, streamed via SSE
- **HITL** — four levels (autonomous → paranoid), pause/resume with 5-minute TTL
- **Verifiers** — post-response quality pipeline (warnings + flags, ACIRU ordering)
- **Eval runner** — `node lib/index.js run --eval <path>` executes eval JSON, checks assertions, stores results in SQLite; `--record` / `--replay` for fixture-based testing
- **Observability** — token tracking, cost estimation, per-tool metrics in SQLite
- **Web component** — `<forge-chat>` drop-in chat widget (vanilla JS, zero deps)

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/tui-workflow.md](docs/tui-workflow.md) | TUI walkthrough, start to finish |
| [docs/reference/config.md](docs/reference/config.md) | `forge.config.json` field reference |
| [docs/reference/api.md](docs/reference/api.md) | HTTP endpoints, SSE events, HITL flow |
| [docs/architecture.md](docs/architecture.md) | 5-layer architecture + topology patterns |
| [docs/eval-runner-contract.md](docs/eval-runner-contract.md) | Eval file format and assertion spec |
| [docs/API-DISCOVERY.md](docs/API-DISCOVERY.md) | API discovery TUI |
| [docs/REAL-VS-PSEUDO.md](docs/REAL-VS-PSEUDO.md) | Which templates are runnable vs conceptual |

---

## Repo Structure

```
lib/
  sidecar.js              # createSidecar() — package entry point
  index.js                # TUI + CLI entry point
  react-engine.js         # ReAct loop, SSE streaming
  hitl-engine.js          # HITL pause/resume
  verifier-engine.js      # Post-response verifier pipeline
  eval-runner.js          # Eval execution engine
  checks/                 # Deterministic assertion checks
  fixtures/               # Record/replay fixture store
  comparison/             # Run comparison + Wilson statistics
  runner/                 # Gate evaluation + CLI
  views/                  # TUI screens
  db.js                   # SQLite persistence
skills/
  forge-tool/             # 11-phase tool creation workflow
  forge-eval/             # Golden + labeled eval generation
  forge-mcp/              # MCP server generation
templates/                # Pseudo-code reference templates (see docs/REAL-VS-PSEUDO.md)
docs/
  tui-workflow.md         # Start-to-finish TUI guide
  reference/
    config.md             # forge.config.json reference
    api.md                # HTTP + SSE reference
  architecture.md         # 5-layer architecture guide
  eval-runner-contract.md # Eval file format spec
  API-DISCOVERY.md        # API discovery workflow
example/
  tools/                  # Example tool files
  evals/                  # Example eval JSON
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
