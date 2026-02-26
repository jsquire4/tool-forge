# Pending Tool Spec — API-Driven Tool Creation

When the Forge API TUI (`cli/index.js`) selects an endpoint to turn into a tool, it writes `forge-pending-tool.json` to the project root. The forge-tool skill detects this file and uses it as the starting point, skipping creative exploration.

---

## File Location

`forge-pending-tool.json` (project root)

---

## Format

```json
{
  "_source": "forge-api-tui",
  "_createdAt": "2025-02-26T12:00:00.000Z",
  "endpoint": {
    "path": "/api/v1/portfolio/holdings",
    "method": "GET",
    "name": "get_holdings",
    "description": "Retrieves position-level holdings with allocation and performance.",
    "params": {
      "symbols": { "type": "array", "items": "string", "optional": true },
      "assetClass": { "type": "string", "enum": ["equity", "bond", "etf"], "optional": true }
    },
    "requiresConfirmation": false
  },
  "project": { ... }
}
```

---

## Forge-Tool Flow When Pending Spec Exists

1. **Phase 0:** Read current state (existing tools, config). **Check for `forge-pending-tool.json`.**
2. **If pending spec exists:**
   - Load the endpoint
   - Present: "I found a pending spec for `GET /api/v1/portfolio/holdings` → `get_holdings`. Create this tool?"
   - If user confirms: **skip Phase 1 (creative exploration)**. Use the endpoint as the spec.
   - Proceed to Phase 2 (skeptic gate) — optionally shortened since the endpoint is already defined.
   - Phase 3: Refine description, name, trigger phrases (endpoint gives a head start)
   - Phases 4–9: Continue as normal. **Generate evals in Phase 9.**
   - **After success: delete or rename `forge-pending-tool.json`** so it isn't used again.
3. **If no pending spec:** Proceed with normal Phase 1 (creative exploration).

---

## After Tool Creation

Once the tool is generated and tests pass, Phase 9 runs `/forge-eval` (if available) to generate golden and labeled evals. The tool→eval factory is triggered automatically.
