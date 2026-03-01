# API Discovery and Tool Creation

The Forge API TUI discovers available API endpoints, shows which ones don't have tools yet, and lets you create MCP/tools from them. Creating a tool triggers the tool→eval factory.

---

## Flow

```
1. Run: node lib/index.js  (or npm run api in cli/)
2. TUI loads APIs (OpenAPI + manifest)
3. TUI loads existing tools (from barrel/files)
4. TUI shows: "APIs without tools: [list]"
5. Select one (or "m" for manual entry)
6. Confirm: "Create MCP/tool for X?"
7. Writes forge-pending-tool.json
8. Run /forge-tool in Claude
9. forge-tool detects pending spec, uses it, generates tool + evals
```

---

## Configuration

### forge.config.json

```json
{
  "api": {
    "discovery": {
      "type": "openapi",
      "url": "http://localhost:3333/api-json"
    },
    "manifestPath": "api-endpoints.json"
  }
}
```

- **discovery.url** — Fetch OpenAPI from a running service (sidecar)
- **discovery.file** — Or use `"file": "openapi.json"` for a local spec
- **manifestPath** — Manual endpoints when OpenAPI is unavailable

### api-endpoints.json (manifest)

Copy from `config/api-endpoints.template.json`. Add endpoints:

```json
{
  "baseUrl": "${API_BASE_URL}",
  "endpoints": [
    {
      "path": "/api/v1/holdings",
      "method": "GET",
      "name": "get_holdings",
      "description": "Retrieves position-level holdings.",
      "params": {
        "symbols": { "type": "array", "items": "string", "optional": true }
      },
      "requiresConfirmation": false
    }
  ]
}
```

---

## Manual Entry

- In the TUI: press `m` to add an endpoint manually
- Or run: `node lib/index.js --manual` to skip discovery and add one directly

---

## Output

`forge-pending-tool.json` is written to the project root. Run `/forge-tool` in Claude; it will detect the file and use it as the starting point. After the tool is created, the file is removed (or you can delete it).
