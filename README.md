# Tool-Forge

Structured dialogue skills for building LLM agent tools, eval suites, and MCP servers.

**Thesis:** Tool engineering is a discipline. A structured 10-phase dialogue produces better tools faster than ad-hoc coding. The eval suite is the proof.

## What's Inside

| Skill | Purpose | Invocation |
|-------|---------|------------|
| `/forge-tool` | Build a new agent tool via 10-phase structured dialogue | Walk through requirements, challenge necessity, generate implementation |
| `/forge-eval` | Generate golden + labeled eval suites for a tool | Deterministic assertions, difficulty tiers, seed data templates |
| `/forge-mcp` | Generate an MCP server from a ToolDefinition | Same tool spec → both agent tool and MCP server |

**API TUI** — Discover APIs (OpenAPI + manifest), select endpoints without tools, create MCP/tools. Runs `cli/index.js`. See `docs/API-DISCOVERY.md`.

**`/forge-verifier`** — Gap detection and verifier creation. Reports tools without verifier coverage, generates verifier stubs. Run `node cli/index.js --verifiers` for a quick gap report.

Plus: pseudo-code templates, a worked example (weather API), and an architecture guide.

## Quick Start

### Try the CLI (no setup needed)

```bash
git clone https://github.com/your-username/tool-forge.git
cd tool-forge

# See which API endpoints don't have tools yet (reads config/api-endpoints.template.json)
node cli/index.js
# or: npm start

# See verifier coverage gaps for the example tools
node cli/index.js --verifiers
# or: npm run verifiers
```

Both commands use the `example/` directory — real `.tool.js` and `.verifier.js` files wired to the CLI. No stack setup required.

### Install Skills

Copy the skills you want into your Claude Code skills directory:

```bash
# Global install (available in all projects)
cp -r tool-forge/skills/forge-tool ~/.claude/skills/
cp -r tool-forge/skills/forge-eval ~/.claude/skills/
cp -r tool-forge/skills/forge-mcp  ~/.claude/skills/

# Or project-local install
cp -r tool-forge/skills/forge-tool .claude/skills/
```

### Use Skills

In any Claude Code session:

```
/forge-tool    # Start the 10-phase tool creation dialogue
/forge-eval    # Generate evals for an existing tool
/forge-mcp     # Generate an MCP server from a ToolDefinition
```

## How It Works

### The 10-Phase Tool Dialogue (`/forge-tool`)

| Phase | What Happens |
|-------|-------------|
| 0 | **Read current state** — discover existing tools in your registry |
| 1 | **Creative exploration** — open-ended "what should this tool do?" |
| 2 | **Skeptic gate** — challenge necessity, overlap, scope |
| 3 | **Description + name** — lock the routing contract (the critical field) |
| 4 | **Collect fields** — schema, category, consequence level, confirmation |
| 5 | **Dependency check** — verify the tool context provides what's needed |
| 6 | **Confirm full spec** — user signs off before any code is written |
| 7 | **Generate code** — tool, tests, barrel registration |
| 8 | **Run tests** — must be green before proceeding |
| 9 | **Generate evals** — hand off to `/forge-eval` |

### The Eval Strategy (`/forge-eval`)

Two tiers of deterministic (no LLM-as-judge) eval cases:

- **Golden evals** (5-10 per tool) — Single-tool routing sanity checks. One prompt, one expected tool, exact assertions.
- **Labeled evals** (scales with registry) — Multi-tool orchestration under ambiguity. Difficulty tiers: straightforward, ambiguous, edge/adversarial.

Assertions use three layers:
- `responseContains` — exact values proving real data was fetched
- `responseContainsAny` — synonym groups for domain precision with flexibility
- `responseNotContains` — catches cop-outs, imprecision, and data leaks

### MCP as Packaging (`/forge-mcp`)

The same `ToolDefinition` that drives your agent tool can generate an MCP server scaffold:

| ToolDefinition field | MCP equivalent |
|---------------------|----------------|
| `name` | tool name (snake_case) |
| `description` | tool description |
| `schema` | `inputSchema` |
| `category: 'read'` | `readOnlyHint: true` |
| `category: 'write'` + high consequence | `destructiveHint: true` |
| `timeout` | server-side timeout |
| `execute()` return | MCP `content` + `structuredContent` |

## Key Design Decisions

1. **Pseudo-code over real code** — Templates use language-agnostic pseudo-code with extension point comments. The LLM using the skill adapts to your stack — the LLM IS the adapter layer.

2. **No eval runner** — The repo ships eval case schemas and generation skills, not a runnable harness. The runner is too stack-specific. Architecture docs explain the runner contract.

3. **Config is optional** — `forge.config.json` front-loads answers to common skill questions (language, test framework, validation library) but isn't required. Skills work via dialogue alone.

4. **Skills reference files, not inline** — SKILL.md files stay under ~400 lines. Detailed specs live in `references/`. Progressive disclosure keeps the main skill readable.

## Repo Structure

```
skills/
  forge-tool/           # 10-phase tool creation workflow
  forge-eval/           # Golden + labeled eval generation
  forge-mcp/            # MCP server generation
templates/              # Pseudo-code + real MCP templates (see docs/REAL-VS-PSEUDO.md)
docs/
  architecture.md       # 9-layer architecture guide
  blog-post.md          # The thesis explained
  REAL-VS-PSEUDO.md     # Which files are runnable vs conceptual
  examples/weather-api/ # Worked example (tool=pseudo, MCP=real runnable)
config/
  forge.config.template.json
```

## Standing on Shoulders

Tool-Forge integrates ideas and code from two excellent open-source projects:

- **[evalkit](https://github.com/wkhori/evalkit)** by wkhori — MIT License
  Provides the deterministic check suite (`lib/checks/`): content matching, tool selection verification, schema validation, and the `runChecks()` meta-runner. Used under MIT license with attribution in each file.

- **[agent-eval-kit](https://github.com/FlanaganSe/agent-eval-kit)** by FlanaganSe — MIT License
  Provides fixture-based record/replay (`lib/fixtures/`), statistical comparison with Wilson confidence intervals (`lib/comparison/`), gate evaluation (`lib/runner/gate.js`), and composition operators (`lib/checks/compose.js`). Used under MIT license with attribution in each file.

## Background

This workflow was extracted from a production project where 6 agent tools and 100+ evals were built in ~2 hours using structured skill-driven dialogue. The workflow — not the stack-specific code — is the valuable artifact. Tool-Forge generalizes it for any framework, any language.

## License

MIT
