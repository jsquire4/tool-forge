---
name: forge-mcp
description: Generate an MCP (Model Context Protocol) server from a ToolDefinition. Maps tool fields to MCP equivalents and produces a scaffold in TypeScript or Python. Use when you have an existing tool and want to expose it as an MCP server.
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
---

# Forge MCP

Generate an MCP server scaffold from an existing ToolDefinition. The same tool spec that drives your agent can also produce an MCP server — one definition, two packaging formats.

> Before starting, read `references/tool-to-mcp-mapping.md` for the field mapping table and `references/mcp-templates.md` for the Node + Python scaffold patterns.

---

## When to Use

- **Standalone:** You have an existing ToolDefinition and want an MCP server for it.
- **From /forge-tool:** Phase 7 of `/forge-tool` can ask "also generate MCP?" If yes, this skill runs automatically.

---

## Phase 1: Read the ToolDefinition

1. Find the tool implementation file (from the user or by searching the project)
2. Extract these fields:
   - `name` → MCP tool name (snake_case)
   - `description` → MCP tool description
   - `schema` → MCP `inputSchema`
   - `category` → maps to `readOnlyHint` / `destructiveHint`
   - `consequenceLevel` → maps to `destructiveHint`
   - `timeout` → server-side timeout
   - `execute()` return shape → MCP `content` + `structuredContent`

3. Present the mapping to the user:

```
ToolDefinition → MCP Mapping:

  name:           {{name}}
  description:    {{description}} (first 200 chars shown in tool list)
  inputSchema:    {{schema_summary}}
  readOnlyHint:   {{true if category == 'read'}}
  destructiveHint: {{true if category == 'write' AND consequenceLevel == 'high'}}
  idempotentHint: {{inferred from tool behavior}}
  timeout:        {{timeout}}ms

Target language: [TypeScript / Python]?
Transport: [stdio / streamable-http]?
```

---

## Phase 2: Choose Language + Transport

Ask the user (or read from `forge.config.json`):

1. **Language:** TypeScript (recommended) or Python
2. **Transport:** stdio (local) or streamable HTTP (remote)
3. **Server name:** `{{service}}-mcp-server` (TS) or `{{service}}_mcp` (Python)

---

## Phase 3: Generate the MCP Server

### For TypeScript

Generate a complete MCP server using `@modelcontextprotocol/sdk`:

- `package.json` with correct dependencies
- `tsconfig.json` with strict mode
- `src/index.ts` with server initialization, tool registration, transport setup
- Input schema converted from tool schema to Zod (if not already Zod)

### For Python

Generate a complete MCP server using FastMCP:

- `requirements.txt` or `pyproject.toml`
- Main server file with `@mcp.tool` decorator, Pydantic input model
- Input schema converted from tool schema to Pydantic (if not already Pydantic)

### Field Mapping

> See `references/tool-to-mcp-mapping.md` for the complete mapping table.

Key mappings:
- `category: 'read'` → `readOnlyHint: true, destructiveHint: false`
- `category: 'write'` + `consequenceLevel: 'high'` → `destructiveHint: true`
- `execute()` success → `content: [{ type: "text", text: formatted }], structuredContent: data`
- `execute()` error → `content: [{ type: "text", text: errorMessage }], isError: true`

---

## Phase 4: Verify

1. For TypeScript: ensure `npm run build` would compile (check for syntax errors)
2. For Python: ensure `python -m py_compile` would pass
3. Present the generated files for user review

---

## Phase 5: Report

```
MCP server generated for tool `{{name}}`:

Files created:
  + {{server_dir}}/package.json (or requirements.txt)
  + {{server_dir}}/src/index.ts (or server.py)
  + {{server_dir}}/tsconfig.json (TypeScript only)

To run:
  cd {{server_dir}}
  npm install && npm run build && npm start  (TypeScript)
  pip install -r requirements.txt && python server.py  (Python)

To test:
  npx @modelcontextprotocol/inspector
```

---

## Rules

- **One tool, one MCP server.** Each generated server exposes a single tool. Bundle multiple tools by running this skill multiple times and combining into one server manually.
- **Adapt the schema.** Convert the tool's validation schema to the target language's equivalent (Zod for TS, Pydantic for Python).
- **Preserve the description.** The MCP tool description should be the same routing contract from the ToolDefinition — do not simplify or truncate it.
- **Include annotations.** Always set `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` based on the tool's category and behavior.
- **Error handling.** Convert ToolResult errors to MCP error responses with `isError: true`.
- **Structured content.** When the tool returns structured data, use both `content` (text) and `structuredContent` (typed object).
