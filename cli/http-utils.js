/**
 * Shared HTTP helpers for sidecar request handlers.
 */

import { getAllToolRegistry } from './db.js';

const MAX_BODY_SIZE = 1_048_576; // 1 MB

/**
 * Read and JSON-parse a request body. Returns {} on parse failure.
 * Rejects bodies larger than MAX_BODY_SIZE.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * Send a JSON response with the given status code.
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Extract a JWT from an HTTP request.
 * Checks Authorization: Bearer <token> first, then falls back to ?token= query param.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractJwt(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7) || null;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token') || null;
  } catch { return null; }
}

/**
 * Load promoted tools from the tool registry and convert to LLM-format tool defs.
 * @param {import('better-sqlite3').Database} db
 * @param {string|string[]} [allowlist='*'] — '*' for all, or array of tool_names to include
 * @returns {{ toolRows: object[], tools: object[] }}
 */
export function loadPromotedTools(db, allowlist = '*') {
  let toolRows = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
  if (Array.isArray(allowlist)) {
    const allowSet = new Set(allowlist);
    toolRows = toolRows.filter(r => allowSet.has(r.tool_name));
  }
  const tools = [];
  for (const row of toolRows) {
    try {
      const spec = JSON.parse(row.spec_json);
      const schema = spec.schema || {};
      const properties = {};
      const required = [];
      for (const [k, v] of Object.entries(schema)) {
        properties[k] = { type: v.type || 'string', description: v.description || k };
        if (!v.optional) required.push(k);
      }
      tools.push({
        name: spec.name || row.tool_name,
        description: spec.description || '',
        inputSchema: { type: 'object', properties, required }
      });
    } catch { /* skip malformed specs */ }
  }
  return { toolRows, tools };
}
