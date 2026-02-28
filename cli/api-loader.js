/**
 * API Loader — Fetches endpoints from OpenAPI (URL or file) and manifest.
 * Merges and dedupes by path+method.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * @typedef {Object} ApiEndpoint
 * @property {string} path - API path (e.g. /api/v1/holdings)
 * @property {string} method - HTTP method (GET, POST, etc.)
 * @property {string} [name] - Suggested tool name (snake_case)
 * @property {string} [description] - Suggested tool description
 * @property {Record<string,unknown>} [params] - Parameter schema
 * @property {boolean} [requiresConfirmation] - HITL gate for write ops
 * @property {string} [source] - 'openapi' | 'manifest'
 */

/**
 * Derive tool name from path and method.
 * @param {string} path
 * @param {string} method
 * @returns {string}
 */
function deriveName(path, method) {
  const parts = path
    .replace(/^\/+/, '')
    .replace(/\/$/, '')
    .split('/')
    .filter(Boolean);
  const last = parts[parts.length - 1] || 'resource';
  const base = last.replace(/\{[^}]+\}/g, 'by_id');
  const verb = method === 'GET' ? 'get' : method === 'POST' ? 'create' : method.toLowerCase();
  return `${verb}_${base}`.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * Parse OpenAPI 3.x paths into ApiEndpoint array.
 * @param {object} spec - Parsed OpenAPI JSON
 * @returns {ApiEndpoint[]}
 */
function parseOpenApiPaths(spec) {
  const endpoints = [];
  const paths = spec.paths || {};
  const basePath = spec.servers?.[0]?.url?.replace(/\/$/, '') || '';

  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== 'object' || pathItem === null) continue;
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    for (const method of methods) {
      const op = pathItem[method];
      if (!op) continue;
      const fullPath = path.startsWith('/') ? path : `/${path}`;
      const name = deriveName(fullPath, method.toUpperCase());
      const params = {};
      for (const p of op.parameters || []) {
        if (p?.name) {
          params[p.name] = {
            type: p.schema?.type || 'string',
            description: p.description
          };
        }
      }
      if (pathItem.parameters) {
        for (const p of pathItem.parameters) {
          if (p?.name && !params[p.name]) {
            params[p.name] = {
              type: p.schema?.type || 'string',
              description: p.description
            };
          }
        }
      }
      endpoints.push({
        path: fullPath,
        method: method.toUpperCase(),
        name,
        description: op.summary || op.description || `${method.toUpperCase()} ${fullPath}`,
        params: Object.keys(params).length ? params : undefined,
        requiresConfirmation: ['post', 'put', 'patch', 'delete'].includes(method),
        source: 'openapi'
      });
    }
  }
  return endpoints;
}

/**
 * Load OpenAPI spec from URL.
 * @param {string} url
 * @returns {Promise<ApiEndpoint[]>}
 */
async function loadFromOpenApiUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`OpenAPI fetch failed: ${res.status} ${url}`);
  const spec = await res.json();
  return parseOpenApiPaths(spec);
}

/**
 * Load OpenAPI spec from file.
 * @param {string} filePath
 * @returns {ApiEndpoint[]}
 */
function loadFromOpenApiFile(filePath) {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) return [];
  const raw = readFileSync(abs, 'utf-8');
  let spec;
  try { spec = JSON.parse(raw); } catch (err) {
    throw new Error(`Failed to parse OpenAPI file ${filePath}: ${err.message}`);
  }
  return parseOpenApiPaths(spec);
}

/**
 * Load endpoints from manifest file.
 * @param {string} manifestPath
 * @returns {ApiEndpoint[]}
 */
function loadFromManifest(manifestPath) {
  const abs = resolve(process.cwd(), manifestPath);
  if (!existsSync(abs)) return [];
  const raw = readFileSync(abs, 'utf-8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch (err) {
    throw new Error(`Failed to parse manifest ${manifestPath}: ${err.message}`);
  }
  const endpoints = manifest.endpoints || [];
  return endpoints.map((e) => ({
    path: e.path,
    method: (e.method || 'GET').toUpperCase(),
    name: e.name || deriveName(e.path, e.method || 'GET'),
    description: e.description || `${e.method || 'GET'} ${e.path}`,
    params: e.params,
    requiresConfirmation: e.requiresConfirmation ?? false,
    source: 'manifest'
  }));
}

/**
 * Merge endpoints, dedupe by path+method (manifest overrides openapi).
 * @param {ApiEndpoint[][]} arrays
 * @returns {ApiEndpoint[]}
 */
function mergeEndpoints(...arrays) {
  const byKey = new Map();
  for (const arr of arrays) {
    for (const e of arr) {
      const key = `${e.method}:${e.path}`;
      byKey.set(key, e);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Safe JSON.parse — returns null on failure.
 * @param {string} str
 * @returns {object|null}
 */
function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Normalize a path for comparison: ensure leading slash, trim trailing slash, lowercase.
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  if (!p) return '';
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.replace(/\/$/, '').toLowerCase();
}

/**
 * Compute API coverage: which spec endpoints have a promoted tool with a matching
 * mcpRouting.endpoint (path) and mcpRouting.method.
 *
 * Matching is path+method, case-insensitive, path-only (no base URL).
 *
 * @param {object|null} spec - Parsed OpenAPI spec object
 * @param {import('better-sqlite3').Database} db
 * @returns {{ covered: ApiEndpoint[]; uncovered: ApiEndpoint[]; total: number }}
 */
export function computeCoverage(spec, db) {
  if (!spec?.paths) return { covered: [], uncovered: [], total: 0 };

  const endpoints = parseOpenApiPaths(spec);

  const promotedRows = db.prepare(
    `SELECT spec_json FROM tool_registry WHERE lifecycle_state = 'promoted'`
  ).all();

  // Build a set of "METHOD:normalizedPath" keys from promoted tools
  const coveredKeys = new Set();
  for (const row of promotedRows) {
    const toolSpec = safeParseJson(row.spec_json);
    if (!toolSpec?.mcpRouting?.endpoint) continue;
    const path = normalizePath(toolSpec.mcpRouting.endpoint);
    const method = (toolSpec.mcpRouting.method || '').toUpperCase();
    if (!path || !method) continue;
    coveredKeys.add(`${method}:${path}`);
  }

  const covered = [];
  const uncovered = [];

  for (const endpoint of endpoints) {
    const key = `${endpoint.method.toUpperCase()}:${normalizePath(endpoint.path)}`;
    if (coveredKeys.has(key)) {
      covered.push(endpoint);
    } else {
      uncovered.push(endpoint);
    }
  }

  return { covered, uncovered, total: endpoints.length };
}

/**
 * Load all APIs from config.
 * @param {object} config - forge.config.json api section
 * @returns {Promise<ApiEndpoint[]>}
 */
export async function loadApis(config) {
  const endpoints = [];
  const discovery = config?.discovery;
  const manifestPath = config?.manifestPath;

  if (discovery?.type === 'openapi') {
    if (discovery.url) {
      try {
        const fromUrl = await loadFromOpenApiUrl(discovery.url);
        endpoints.push(...fromUrl);
      } catch (err) {
        console.error(`OpenAPI URL failed: ${err.message}`);
      }
    }
    if (discovery.file) {
      const fromFile = loadFromOpenApiFile(discovery.file);
      endpoints.push(...fromFile);
    }
  }

  if (manifestPath) {
    const fromManifest = loadFromManifest(manifestPath);
    endpoints.push(...fromManifest);
  }

  return mergeEndpoints(endpoints);
}
