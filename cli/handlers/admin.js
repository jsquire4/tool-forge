/**
 * Admin API — runtime config updates for app-owners.
 *
 * PUT /forge-admin/config/:section — update a config section
 * GET /forge-admin/config          — read current effective config
 *
 * Protected by adminKey (Bearer token).
 * Runtime overlay: in-memory Map merged on top of file config.
 * NOT written back to forge.config.json.
 */

import { authenticateAdmin } from '../auth.js';

const VALID_SECTIONS = ['model', 'hitl', 'permissions', 'conversation'];

// Runtime overlay — survives across requests but not restarts
const runtimeOverlay = new Map();

/**
 * PUT /forge-admin/config/:section
 */
export async function handleAdminConfig(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');

  // Admin auth
  const adminKey = ctx.config.adminKey;
  if (!adminKey) {
    sendJson(res, 503, { error: 'No adminKey configured' });
    return;
  }
  const authResult = authenticateAdmin(req, adminKey);
  if (!authResult.authenticated) {
    sendJson(res, 403, { error: authResult.error ?? 'Forbidden' });
    return;
  }

  if (req.method === 'GET') {
    return handleAdminConfigGet(req, res, ctx);
  }

  if (req.method === 'PUT') {
    const pathParts = url.pathname.split('/').filter(Boolean);
    // /forge-admin/config/:section → pathParts = ['forge-admin', 'config', section]
    const section = pathParts[2];

    if (!section || !VALID_SECTIONS.includes(section)) {
      sendJson(res, 400, { error: `Invalid section. Must be one of: ${VALID_SECTIONS.join(', ')}` });
      return;
    }

    const body = await readBody(req);
    runtimeOverlay.set(section, body);

    // Apply overlay to live config
    applyOverlay(ctx.config, section, body);

    sendJson(res, 200, { ok: true, section, applied: body });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

/**
 * GET /forge-admin/config
 */
function handleAdminConfigGet(req, res, ctx) {
  const effective = { ...ctx.config };
  // Merge runtime overlay
  for (const [section, values] of runtimeOverlay) {
    applyOverlay(effective, section, values);
  }
  sendJson(res, 200, effective);
}

function applyOverlay(config, section, values) {
  switch (section) {
    case 'model':
      if (values.defaultModel) config.defaultModel = values.defaultModel;
      break;
    case 'hitl':
      if (values.defaultHitlLevel) config.defaultHitlLevel = values.defaultHitlLevel;
      break;
    case 'permissions':
      if (values.allowUserModelSelect !== undefined) config.allowUserModelSelect = values.allowUserModelSelect;
      if (values.allowUserHitlConfig !== undefined) config.allowUserHitlConfig = values.allowUserHitlConfig;
      break;
    case 'conversation':
      if (values.window) config.conversation = { ...config.conversation, window: values.window };
      break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Reset runtime overlay — used by tests.
 */
export function _resetOverlay() {
  runtimeOverlay.clear();
}
