# TUI Workflow: Start to Finish

This guide walks through building, testing, and running an agent tool using the tool-forge TUI.

```bash
node lib/index.js
```

---

## Prerequisites

- `forge.config.json` in your project root (see [docs/reference/config.md](reference/config.md))
- At minimum: `anthropicApiKey` and your host app's base URL

---

## Step 1 — Launch the TUI

```bash
node lib/index.js
```

The main menu appears. Navigate with arrow keys, select with Enter.

---

## Step 2 — Configure Settings

Open **Settings** from the main menu.

Key fields to confirm on first run:
- **API key** — your Anthropic (or OpenAI) key
- **Default model** — e.g. `claude-sonnet-4-6`
- **HITL level** — `autonomous` (no confirmations) → `paranoid` (confirm everything)
- **Host app base URL** — where your host application is running (e.g. `http://localhost:3333`)

Settings are written to `forge.config.json`.

---

## Step 3 — Discover Your API (optional, sidecar deployments)

Open **Endpoints** from the main menu.

The API discovery screen reads your host app's OpenAPI spec or an `api-endpoints.json` manifest (see `api.manifestPath` in config) and shows available endpoints. Select endpoints to incorporate into your tool definitions.

See [docs/API-DISCOVERY.md](API-DISCOVERY.md) for details.

---

## Step 4 — Build a Tool with `/forge-tool`

Open **Forge Tool** from the main menu. This launches a Claude Code session with the `forge-tool` skill loaded.

The 12-phase dialogue runs in the Claude Code pane:

| Phase | Dialogue |
|-------|---------|
| 0 | You describe what the tool should do |
| 1 | Claude challenges necessity and overlap |
| 2 | You agree on name + description (the routing contract) |
| 3 | Collect schema, category, consequence level, confirmation flag |
| 4 | Routing — collect endpoint target, HTTP method, auth type, param mapping |
| 5 | Dependency check — does your host app provide what the tool needs? |
| 6 | Full spec review — you sign off |
| 7 | Claude generates the tool file, tests, and barrel registration |
| 8 | Tests run — must be green |
| 9 | Auto-hands off to `/forge-eval` |
| 10 | Generate verifier stubs |
| 11 | Done — summary of all files created |

When complete, the TUI returns you to the Tools & Evals list with the new tool registered.

---

## Step 5 — Review the Generated Tool

From **Tools & Evals**, select your new tool to view its definition:

- `name` — snake_case identifier used in tool calls
- `description` — the routing contract (what/when/when-not/source)
- `schema` — input field types and required/optional flags
- `category` — `read` | `write` | `delete` | `side_effect`
- `consequenceLevel` — `low` | `medium` | `high`
- `requiresConfirmation` — whether HITL gate triggers for this tool
- `version` — semver, used for eval staleness detection
- `status` — `active` | `deprecated` | `removed`

---

## Step 6 — Generate Evals with `/forge-eval`

The eval files were auto-generated in Phase 9. To regenerate or add more:

Open **Tools & Evals**, select your tool, and choose **Generate evals (AI)**.

`/forge-eval` produces two files:

| File | Contents |
|------|---------|
| `{toolName}.golden.json` | 5-10 single-tool routing cases, exact assertions |
| `{toolName}.labeled.json` | Multi-tool orchestration cases, difficulty tiers |

Assertions use three layers:
- `responseContains` — exact values proving real data was fetched
- `responseContainsAny` — synonym groups for domain flexibility
- `responseNotContains` — catches cop-outs and data leaks

See [docs/eval-runner-contract.md](eval-runner-contract.md) for the full assertion spec.

---

## Step 7 — Run Evals

### Via TUI

Open **Run Evals** and select the eval file. Progress is shown case-by-case. Results are stored in `forge.db` (SQLite).

### Via CLI

```bash
# Run golden evals for a tool
node lib/index.js run --eval docs/examples/weather-api/get-weather.golden.json

# Record fixture (saves real API responses for replay)
node lib/index.js run --eval docs/examples/weather-api/get-weather.golden.json --record

# Replay from fixture (no agent calls, zero cost)
node lib/index.js run --eval docs/examples/weather-api/get-weather.golden.json --replay

# Run a named suite
node lib/index.js run --eval docs/examples/weather-api/get-weather.golden.json --suite smoke
```

---

## Step 8 — Review Results

The TUI shows a per-case breakdown:
- Pass/fail status per case
- Tools called vs expected
- First failure reason (when failed)
- Latency per case

Summary line: `N/M passed | K failed | latency p50/p95`

Gate thresholds (configured in `forge.config.json` under `gates`) emit a non-zero exit code when violated — useful in CI.

---

## Step 9 — Start the Sidecar

Once you have tools and passing evals, start the runtime:

```js
import { createSidecar } from 'tool-forge'

const { server, ctx, close } = await createSidecar(
  { auth: { mode: 'trust' } },
  { port: 8001 }
)

// server is already listening on port 8001
// call close() on shutdown for clean teardown
```

Or via TUI: **Server → Start**.

---

## Step 10 — Chat and Verify

Send a message via the TUI chat pane, or via the `<forge-chat>` web component embedded in your host app:

```html
<forge-chat
  endpoint="http://localhost:8001"
  token="YOUR_JWT"
  theme="light">
</forge-chat>
```

The sidecar:
1. Streams the response over SSE (`session` → `text_delta` → `tool_call` → `tool_result` → `done`)
2. Pauses for HITL confirmation on gated tools (sends `hitl` event with `resumeToken`)
3. Runs verifiers after the final response
4. Persists token usage, tool metrics, and verifier results to SQLite

Resume a HITL-paused conversation:

```
POST /agent-api/chat/resume
{ "resumeToken": "...", "confirmed": true }
```

---

## Iterating

Add more tools: repeat Steps 4-8.

When tools change:
- Eval staleness warnings appear if the description hash has changed
- Re-run `/forge-eval` on changed tools to regenerate cases
- The `version` field in the tool definition triggers staleness detection automatically

---

## CI Integration

```bash
# Fails with exit code 1 if pass rate < gates.passRate
node lib/index.js run --eval evals/get_weather.golden.json
echo $?
```

Gate settings (configure in `forge.config.json` under `gates`):
- `passRate` — fraction of cases that must pass (e.g. `0.9` for 90%). Default: `null` (no gate).
- `p95LatencyMs` — maximum p95 latency in ms (e.g. `15000`). Default: `null` (no gate).

Recommended CI values: `passRate: 0.9`, `p95LatencyMs: 15000`.
