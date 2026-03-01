/**
 * Tools list endpoint — GET /agent-api/tools
 *
 * Returns promoted tools, optionally filtered by agent allowlist.
 */

import { sendJson, loadPromotedTools } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — sidecar context
 */
export async function handleToolsList(req, res, ctx) {
  const { auth, db, agentRegistry } = ctx;

  // Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  // Optional ?agent=<id> query param
  const url = new URL(req.url, 'http://localhost');
  const agentParam = url.searchParams.get('agent');

  let allowlist = '*';
  if (agentParam && agentRegistry) {
    const agent = agentRegistry.resolveAgent(agentParam);
    if (!agent) {
      sendJson(res, 404, { error: `Agent "${agentParam}" not found or disabled` });
      return;
    }
    const raw = agent.tool_allowlist ?? '*';
    if (raw !== '*') {
      try {
        const parsed = JSON.parse(raw);
        allowlist = Array.isArray(parsed) ? parsed : '*';
      } catch {
        allowlist = '*';
      }
    }
  }

  try {
    const { tools } = loadPromotedTools(db, allowlist);
    // Map to { name, description, schema } shape
    const result = tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      schema: t.inputSchema ?? {}
    }));
    sendJson(res, 200, { tools: result });
  } catch (err) {
    sendJson(res, 500, { error: `Failed to load tools: ${err.message}` });
  }
}
