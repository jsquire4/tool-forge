# Real Code vs Pseudo-Code

Tool-Forge mixes **real runnable code** with **pseudo-code** (conceptual references). This document clarifies which is which.

---

## Real Code

These files are runnable (or become runnable after filling placeholders).

### Runnable examples (no placeholders)

| File | Description |
|------|-------------|
| `docs/examples/weather-api/get-weather.mcp.example.ts` | Complete MCP server. Run with `OPENWEATHER_API_KEY=xxx npx tsx get-weather.mcp.example.ts` |

### Real code templates (fill `{{placeholders}}` to run)

| File | Description |
|------|-------------|
| `templates/mcp-server-node.template.ts` | TypeScript MCP server scaffold. Real SDK imports, real structure. |
| `templates/mcp-server-python.template.py` | Python MCP server scaffold (FastMCP). Real dependencies. |
| `templates/mcp-server-bundle-node.template.ts` | Multi-tool MCP server bundle. |

---

## Pseudo-Code

These files are **conceptual references**. They do not compile or run as-is. Use them to understand the contract, then adapt to your stack.

| File | Why pseudo |
|------|------------|
| `templates/tool-definition.pseudo.ts` | Interface definitions with `EXTENSION POINT` comments. No real imports. |
| `templates/tool-result.pseudo.ts` | Interface only. Contract spec. |
| `templates/barrel-registry.pseudo.ts` | Pattern description with language-agnostic examples. |
| `templates/verifier-definition.pseudo.ts` | Interface definitions. Contract spec. |
| `templates/verifiers-barrel.pseudo.ts` | Verifier barrel pattern. |
| `docs/examples/weather-api/get-weather.tool.pseudo.ts` | Uses invalid import `'/* your validation library */'`. |

---

## Naming Conventions

- **`.example.ts`** — Runnable example (no placeholders needed).
- **`.template.ts` / `.template.py`** — Real code structure with `{{placeholders}}`. Fill to run.
- **`.pseudo.ts` / `.pseudo.py`** — Conceptual reference. Adapt to your stack; does not run as-is.
