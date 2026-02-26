# ToolDefinition → MCP Field Mapping

## Core Field Mapping

| ToolDefinition | MCP Equivalent | Notes |
|---|---|---|
| `name` | tool name | snake_case, used as the registered tool identifier |
| `description` | tool description | The full routing contract — do not truncate |
| `schema` | `inputSchema` | Zod (TS) or Pydantic (Python) — auto-validated by MCP SDK |
| `category: 'read'` | `readOnlyHint: true` | Tool does not modify its environment |
| `category: 'write'` | `readOnlyHint: false` | Tool performs mutations |
| `category: 'analysis'` | `readOnlyHint: true` | Computes insights, no mutations |
| `consequenceLevel: 'high'` + `category: 'write'` | `destructiveHint: true` | Irreversible or high-impact writes |
| `consequenceLevel: 'low/medium'` or `category != 'write'` | `destructiveHint: false` | Safe or reversible operations |
| `timeout` | server-side timeout | Applied in the tool handler, not an MCP protocol field |
| `execute()` return `data` | `content` + `structuredContent` | Text for display, structured for programmatic use |
| `execute()` return `error` | `content` with `isError: true` | Error message in text content |
| `tags` | (no direct equivalent) | Can be included in description or server metadata |
| `requiresConfirmation` | `destructiveHint: true` (closest) | MCP has no HITL — client decides based on hints |

## Annotation Inference

| ToolDefinition | → `readOnlyHint` | → `destructiveHint` | → `idempotentHint` | → `openWorldHint` |
|---|---|---|---|---|
| `category: 'read'` | `true` | `false` | `true` (reads are idempotent) | `true` (calls external API) |
| `category: 'write'`, low consequence | `false` | `false` | depends on operation | `true` |
| `category: 'write'`, high consequence | `false` | `true` | `false` (usually) | `true` |
| `category: 'analysis'` | `true` | `false` | `true` | `false` (local computation) |

**Note:** `openWorldHint` should be `true` if the tool makes external API calls (most tools) and `false` if it only performs local computation.

## Schema Conversion

### Zod → MCP inputSchema (TypeScript)

No conversion needed — the MCP TypeScript SDK accepts Zod schemas directly via `registerTool`.

```typescript
server.registerTool("tool_name", {
  inputSchema: { city: z.string(), units: z.enum(["metric", "imperial"]).default("metric") },
  // ...
}, handler);
```

### Pydantic → MCP inputSchema (Python)

No conversion needed — FastMCP accepts Pydantic models directly via the function signature.

```python
class GetWeatherInput(BaseModel):
    city: str = Field(..., description="City name")
    units: str = Field(default="metric", description="Temperature units")

@mcp.tool(name="get_weather")
async def get_weather(params: GetWeatherInput) -> str:
    ...
```

### Other validation libraries → JSON Schema

If your tool uses a different validation library, convert to JSON Schema manually:

```json
{
  "type": "object",
  "properties": {
    "city": { "type": "string", "description": "City name" },
    "units": { "type": "string", "enum": ["metric", "imperial"], "default": "metric" }
  },
  "required": ["city"]
}
```

## Response Mapping

### Success (ToolResult with data)

```
ToolResult: { tool: "get_weather", fetchedAt: "...", data: { temp: 72, conditions: "sunny" } }

→ MCP Response:
{
  content: [{ type: "text", text: "Temperature: 72°F, Conditions: Sunny" }],
  structuredContent: { temp: 72, conditions: "sunny" }
}
```

### Error (ToolResult with error)

```
ToolResult: { tool: "get_weather", fetchedAt: "...", error: "City not found" }

→ MCP Response:
{
  content: [{ type: "text", text: "Error: City not found" }],
  isError: true
}
```

## What MCP Doesn't Have

| ToolDefinition feature | MCP status |
|---|---|
| `requiresConfirmation` | No protocol-level HITL. Use `destructiveHint` as a signal; client decides. |
| `consequenceLevel` | No direct field. Encoded via `destructiveHint`. |
| `dependsOn` | No tool dependency declaration in MCP. Handle in server implementation. |
| `version` | No per-tool versioning. Use server version instead. |
| `fetchedAt` timestamp | Not an MCP concept. Include in `structuredContent` if needed. |
