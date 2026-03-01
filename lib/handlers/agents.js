/**
 * Admin Agent API — CRUD for multi-agent registry.
 *
 * All routes require adminKey (Bearer token).
 *
 * Routes:
 *   GET    /forge-admin/agents              — list all agents
 *   GET    /forge-admin/agents/:agentId     — get one
 *   POST   /forge-admin/agents              — create
 *   PUT    /forge-admin/agents/:agentId     — update
 *   DELETE /forge-admin/agents/:agentId     — delete
 *   POST   /forge-admin/agents/:agentId/set-default — set default
 */

import { authenticateAdmin } from '../auth.js';
import { readBody, sendJson } from '../http-utils.js';

const AGENT_ID_RE = /^[a-z0-9_-]{1,64}$/;
const VALID_HITL_LEVELS = new Set(['autonomous', 'cautious', 'standard', 'paranoid']);

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { config, agentRegistry }
 */
export async function handleAgents(req, res, ctx) {
  const { config, agentRegistry } = ctx;

  // Admin auth
  const adminKey = config.adminKey;
  if (!adminKey) {
    sendJson(res, 503, { error: 'No adminKey configured' });
    return;
  }
  const authResult = authenticateAdmin(req, adminKey);
  if (!authResult.authenticated) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (!agentRegistry) {
    sendJson(res, 501, { error: 'Agent registry not initialized' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  // /forge-admin/agents/:agentId/set-default or /forge-admin/agents/:agentId or /forge-admin/agents
  const pathParts = url.pathname.split('/').filter(Boolean);
  // pathParts: ['forge-admin', 'agents', agentId?, 'set-default'?]
  const agentId = pathParts[2] || null;
  const action = pathParts[3] || null;

  if (agentId && !AGENT_ID_RE.test(agentId)) {
    sendJson(res, 400, { error: 'Invalid agent ID format' });
    return;
  }

  // POST /forge-admin/agents/:agentId/set-default
  if (req.method === 'POST' && agentId && action === 'set-default') {
    const existing = agentRegistry.getAgent(agentId);
    if (!existing) {
      sendJson(res, 404, { error: `Agent "${agentId}" not found` });
      return;
    }
    agentRegistry.setDefault(agentId);
    sendJson(res, 200, { ok: true, agentId });
    return;
  }

  // GET /forge-admin/agents
  if (req.method === 'GET' && !agentId) {
    const agents = agentRegistry.getAllAgents();
    sendJson(res, 200, { agents });
    return;
  }

  // GET /forge-admin/agents/:agentId
  if (req.method === 'GET' && agentId) {
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      sendJson(res, 404, { error: `Agent "${agentId}" not found` });
      return;
    }
    sendJson(res, 200, agent);
    return;
  }

  // POST /forge-admin/agents — create
  if (req.method === 'POST' && !agentId) {
    const body = await readBody(req);
    const err = validateAgentBody(body, true);
    if (err) {
      sendJson(res, 400, { error: err });
      return;
    }

    // Check for duplicates
    if (agentRegistry.getAgent(body.id)) {
      sendJson(res, 409, { error: `Agent "${body.id}" already exists` });
      return;
    }

    agentRegistry.upsertAgent(bodyToRow(body));
    sendJson(res, 201, agentRegistry.getAgent(body.id));
    return;
  }

  // PUT /forge-admin/agents/:agentId — update
  if (req.method === 'PUT' && agentId) {
    const existing = agentRegistry.getAgent(agentId);
    if (!existing) {
      sendJson(res, 404, { error: `Agent "${agentId}" not found` });
      return;
    }

    const body = await readBody(req);
    const err = validateAgentBody(body, false);
    if (err) {
      sendJson(res, 400, { error: err });
      return;
    }

    // Merge: existing values as base, body overrides. Mark as admin-edited (seeded_from_config=0).
    const row = bodyToRow({ ...rowToBody(existing), ...body, id: agentId, seeded_from_config: 0 });
    agentRegistry.upsertAgent(row);
    sendJson(res, 200, agentRegistry.getAgent(agentId));
    return;
  }

  // DELETE /forge-admin/agents/:agentId
  if (req.method === 'DELETE' && agentId) {
    const existing = agentRegistry.getAgent(agentId);
    if (!existing) {
      sendJson(res, 404, { error: `Agent "${agentId}" not found` });
      return;
    }
    agentRegistry.deleteAgent(agentId);
    // If we deleted the default, auto-promote the first remaining enabled agent
    if (existing.is_default) {
      const remaining = agentRegistry.getAllAgents().filter(a => a.enabled);
      if (remaining.length > 0) {
        agentRegistry.setDefault(remaining[0].agent_id);
      }
    }
    sendJson(res, 200, { ok: true, deleted: agentId });
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}

/**
 * Validate an agent request body.
 * @param {object} body
 * @param {boolean} isCreate — if true, id and displayName are required
 * @returns {string|null} error message or null
 */
function validateAgentBody(body, isCreate) {
  if (isCreate) {
    if (!body.id || typeof body.id !== 'string' || !AGENT_ID_RE.test(body.id)) {
      return 'id is required and must match /^[a-z0-9_-]{1,64}$/';
    }
    if (!body.displayName || typeof body.displayName !== 'string') {
      return 'displayName is required';
    }
  }
  if (body.defaultHitlLevel !== undefined && !VALID_HITL_LEVELS.has(body.defaultHitlLevel)) {
    return `defaultHitlLevel must be one of: ${[...VALID_HITL_LEVELS].join(', ')}`;
  }
  if (body.toolAllowlist !== undefined && body.toolAllowlist !== '*' && !Array.isArray(body.toolAllowlist)) {
    return 'toolAllowlist must be "*" or an array of tool names';
  }
  if (body.maxTurns !== undefined && (typeof body.maxTurns !== 'number' || body.maxTurns < 1 || !Number.isInteger(body.maxTurns))) {
    return 'maxTurns must be a positive integer';
  }
  if (body.maxTokens !== undefined && (typeof body.maxTokens !== 'number' || body.maxTokens < 1 || !Number.isInteger(body.maxTokens))) {
    return 'maxTokens must be a positive integer';
  }
  return null;
}

/**
 * Convert API request body to DB row format.
 */
function bodyToRow(body) {
  return {
    agent_id: body.id,
    display_name: body.displayName,
    description: body.description ?? null,
    system_prompt: body.systemPrompt ?? null,
    default_model: body.defaultModel ?? null,
    default_hitl_level: body.defaultHitlLevel ?? null,
    allow_user_model_select: body.allowUserModelSelect ? 1 : 0,
    allow_user_hitl_config: body.allowUserHitlConfig ? 1 : 0,
    tool_allowlist: Array.isArray(body.toolAllowlist) ? JSON.stringify(body.toolAllowlist) : (body.toolAllowlist ?? '*'),
    max_turns: body.maxTurns ?? null,
    max_tokens: body.maxTokens ?? null,
    is_default: body.isDefault ? 1 : 0,
    enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
    seeded_from_config: body.seeded_from_config ?? 0,
  };
}

/**
 * Convert DB row to API body format (for merge on update).
 */
function rowToBody(row) {
  let toolAllowlist = row.tool_allowlist;
  if (toolAllowlist && toolAllowlist !== '*') {
    try { toolAllowlist = JSON.parse(toolAllowlist); } catch { /* keep string */ }
  }
  return {
    id: row.agent_id,
    displayName: row.display_name,
    description: row.description,
    systemPrompt: row.system_prompt,
    defaultModel: row.default_model,
    defaultHitlLevel: row.default_hitl_level,
    allowUserModelSelect: !!row.allow_user_model_select,
    allowUserHitlConfig: !!row.allow_user_hitl_config,
    toolAllowlist,
    maxTurns: row.max_turns,
    maxTokens: row.max_tokens,
    isDefault: !!row.is_default,
    enabled: !!row.enabled,
    seeded_from_config: Boolean(row.seeded_from_config)
  };
}
