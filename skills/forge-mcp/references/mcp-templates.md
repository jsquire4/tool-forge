# MCP Server Templates — Node + Python Scaffolds

## TypeScript (Node) Template

### Project Structure

```
{{name}}-mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── dist/
```

### package.json

```json
{
  "name": "{{name}}-mcp-server",
  "version": "1.0.0",
  "description": "MCP server for {{name}}",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "clean": "rm -rf dist"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.6.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### src/index.ts (stdio transport)

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "{{name}}-mcp-server",
  version: "1.0.0"
});

// ── Input Schema ────────────────────────────────────────────────────────────

// EXTENSION POINT: Replace with the tool's actual schema
const InputSchema = z.object({
  // {{schema_fields}}
}).strict();

type Input = z.infer<typeof InputSchema>;

// ── Tool Registration ───────────────────────────────────────────────────────

server.registerTool(
  "{{tool_name}}",
  {
    title: "{{Tool Display Name}}",
    description: `{{description}}`,
    inputSchema: InputSchema,
    annotations: {
      readOnlyHint: {{readOnlyHint}},
      destructiveHint: {{destructiveHint}},
      idempotentHint: {{idempotentHint}},
      openWorldHint: {{openWorldHint}}
    }
  },
  async (params: Input) => {
    try {
      // EXTENSION POINT: Replace with the tool's actual implementation
      // This is where context.client.get(...) becomes a direct API call
      const data = await fetchData(params);

      // Format for display
      const textContent = formatAsText(data);

      return {
        content: [{ type: "text", text: textContent }],
        structuredContent: data
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

// ── Helpers ─────────────────────────────────────────────────────────────────

// EXTENSION POINT: Replace with actual API call
async function fetchData(params: Input): Promise<unknown> {
  // const response = await fetch(`${API_BASE_URL}/endpoint`, { ... });
  // return response.json();
  throw new Error("Not implemented — replace with actual API call");
}

// EXTENSION POINT: Replace with actual formatting
function formatAsText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("{{name}}-mcp-server running via stdio");
}

main().catch(error => {
  console.error("Server error:", error);
  process.exit(1);
});
```

### src/index.ts (streamable HTTP transport)

Add `express` to dependencies and replace the main function:

```typescript
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

async function main() {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT || '3000');
  app.listen(port, () => {
    console.error(`{{name}}-mcp-server running on http://localhost:${port}/mcp`);
  });
}
```

---

## Python Template

### Project Structure

```
{{name}}_mcp/
├── server.py
├── requirements.txt
└── pyproject.toml (optional)
```

### requirements.txt

```
mcp>=1.0.0
httpx>=0.27.0
pydantic>=2.0.0
```

### server.py (stdio transport)

```python
#!/usr/bin/env python3
"""MCP Server for {{name}}."""

from typing import Optional
import httpx
from pydantic import BaseModel, Field, ConfigDict
from mcp.server.fastmcp import FastMCP

# ── Server ───────────────────────────────────────────────────────────────────

mcp = FastMCP("{{name}}_mcp")

# ── Input Model ──────────────────────────────────────────────────────────────

# EXTENSION POINT: Replace with the tool's actual input model
class ToolInput(BaseModel):
    """Input model for {{tool_name}}."""
    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_assignment=True,
        extra='forbid'
    )

    # {{schema_fields}}
    # example: city: str = Field(..., description="City name", min_length=1)

# ── Tool ─────────────────────────────────────────────────────────────────────

@mcp.tool(
    name="{{tool_name}}",
    annotations={
        "title": "{{Tool Display Name}}",
        "readOnlyHint": {{read_only_hint}},
        "destructiveHint": {{destructive_hint}},
        "idempotentHint": {{idempotent_hint}},
        "openWorldHint": {{open_world_hint}}
    }
)
async def tool_handler(params: ToolInput) -> str:
    """{{description}}"""
    try:
        # EXTENSION POINT: Replace with actual API call
        data = await _fetch_data(params)
        return _format_response(data)
    except Exception as e:
        return _handle_error(e)

# ── Helpers ──────────────────────────────────────────────────────────────────

async def _fetch_data(params: ToolInput) -> dict:
    """EXTENSION POINT: Replace with actual API call."""
    async with httpx.AsyncClient() as client:
        # response = await client.get(f"{API_BASE_URL}/endpoint", params={...})
        # response.raise_for_status()
        # return response.json()
        raise NotImplementedError("Replace with actual API call")

def _format_response(data: dict) -> str:
    """EXTENSION POINT: Replace with actual formatting."""
    import json
    return json.dumps(data, indent=2)

def _handle_error(e: Exception) -> str:
    """Consistent error formatting."""
    if isinstance(e, httpx.HTTPStatusError):
        status = e.response.status_code
        if status == 404:
            return "Error: Resource not found."
        elif status == 429:
            return "Error: Rate limit exceeded. Please wait."
        return f"Error: API request failed with status {status}"
    elif isinstance(e, httpx.TimeoutException):
        return "Error: Request timed out."
    return f"Error: {type(e).__name__}: {str(e)}"

# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
```

### server.py (streamable HTTP transport)

Replace the main block:

```python
if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "3000"))
    mcp.run(transport="streamable_http", port=port)
```
