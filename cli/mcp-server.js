/**
 * MCP Server — Creates an MCP Server instance that proxies tool calls
 * to internal API endpoints defined in tool_registry.
 *
 * Usage: const server = createMcpServer(db, config);
 *   then: const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
 *         await server.connect(transport);
 *         await transport.handleRequest(req, res, parsedBody);
 */

import { Server } from '@modelcontextprotocol/sdk/server';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getAllToolRegistry, insertMcpCallLog } from './db.js';

/**
 * Safe JSON.parse — returns null on failure.
 * @param {string} str
 * @returns {object|null}
 */
function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Call a tool's mcpRouting endpoint with the provided arguments.
 * Builds URL from config.api.baseUrl + tool's mcpRouting.endpoint.
 * Maps tool arguments to path params, query params, or body via paramMap.
 *
 * @param {object} spec - Parsed tool spec with mcpRouting
 * @param {object} args - Tool call arguments
 * @param {object} config - forge config with api.baseUrl
 * @returns {Promise<{ status: number; body: object; error: string|null }>}
 */
async function callToolEndpoint(spec, args, config) {
  const baseUrl = (config.api?.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const routing = spec.mcpRouting || {};
  const path = routing.endpoint || '/';
  const method = (routing.method || 'GET').toUpperCase();
  const paramMap = routing.paramMap || {};

  // Build URL with path params substituted; collect query and body params
  let url = baseUrl + path;
  const queryParams = new URLSearchParams();
  const bodyObj = {};

  for (const [toolParam, mapping] of Object.entries(paramMap)) {
    const val = args[toolParam];
    if (val === undefined) continue;
    if (mapping.path) {
      url = url.replace(`{${mapping.path}}`, encodeURIComponent(String(val)));
    } else if (mapping.query) {
      queryParams.set(mapping.query, String(val));
    } else if (mapping.body) {
      bodyObj[mapping.body] = val;
    }
  }

  if ([...queryParams].length > 0) url += '?' + queryParams.toString();

  const fetchOpts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30_000)
  };
  if (['POST', 'PUT', 'PATCH'].includes(method) && Object.keys(bodyObj).length > 0) {
    fetchOpts.body = JSON.stringify(bodyObj);
  }

  const res = await fetch(url, fetchOpts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return {
    status: res.status,
    body,
    error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 200)}`
  };
}

/**
 * Create an MCP Server that exposes promoted tools from tool_registry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - forge.config.json contents
 * @returns {import('@modelcontextprotocol/sdk/server').Server}
 */
export function createMcpServer(db, config) {
  const server = new Server(
    { name: 'forge-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // ── tools/list ──────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rows = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
    const tools = [];
    for (const row of rows) {
      const spec = safeParseJson(row.spec_json);
      if (!spec) {
        console.error(`[mcp-server] Skipping tool "${row.tool_name}": malformed spec_json`);
        continue;
      }
      const schema = spec.schema || {};
      const properties = {};
      const required = [];
      for (const [k, v] of Object.entries(schema)) {
        properties[k] = {
          type: v.type || 'string',
          description: v.description || k
        };
        if (!v.optional) required.push(k);
      }
      tools.push({
        name: spec.name || row.tool_name,
        description: spec.description || '',
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {})
        }
      });
    }
    return { tools };
  });

  // ── tools/call ───────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const rows = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
    const row = rows.find(r => {
      const s = safeParseJson(r.spec_json);
      return (s?.name || r.tool_name) === name;
    });

    if (!row) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" not found or not promoted` }],
        isError: true
      };
    }

    const spec = safeParseJson(row.spec_json);
    if (!spec?.mcpRouting?.endpoint) {
      return {
        content: [{ type: 'text', text: `Tool "${name}" has no mcpRouting configured` }],
        isError: true
      };
    }

    const start = Date.now();
    let result;
    try {
      result = await callToolEndpoint(spec, args, config);
    } catch (err) {
      const latency_ms = Date.now() - start;
      try {
        insertMcpCallLog(db, {
          tool_name: name,
          input_json: JSON.stringify(args),
          status_code: 0,
          latency_ms,
          error: err.message
        });
      } catch (logErr) {
        console.error('[mcp-server] Failed to log call error:', logErr.message);
      }
      return {
        content: [{ type: 'text', text: `Connection error: ${err.message}` }],
        isError: true
      };
    }

    const latency_ms = Date.now() - start;
    try {
      insertMcpCallLog(db, {
        tool_name: name,
        input_json: JSON.stringify(args),
        output_json: JSON.stringify(result.body),
        status_code: result.status,
        latency_ms,
        error: result.error || null
      });
    } catch (logErr) {
      console.error('[mcp-server] Failed to log call:', logErr.message);
    }

    if (result.error) {
      return {
        content: [{ type: 'text', text: result.error }],
        isError: true
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.body, null, 2) }],
      structuredContent: result.body,
      isError: false
    };
  });

  return server;
}
