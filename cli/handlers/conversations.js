/**
 * Conversation management endpoints.
 *
 * GET    /agent-api/conversations              — list sessions
 * GET    /agent-api/conversations/:sessionId    — get history
 * DELETE /agent-api/conversations/:sessionId    — delete session
 */

import { sendJson } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — sidecar context
 */
export async function handleConversations(req, res, ctx) {
  const { auth, conversationStore, db } = ctx;

  // Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  // segments: ['agent-api', 'conversations', sessionId?]
  // Also handle /agent-api/v1/conversations/...
  const convIndex = segments.indexOf('conversations');
  const sessionId = convIndex >= 0 ? segments[convIndex + 1] : undefined;

  // GET /agent-api/conversations — list sessions
  if (req.method === 'GET' && !sessionId) {
    try {
      const rows = db.prepare(
        `SELECT session_id, agent_id,
                MAX(created_at) AS last_updated,
                MIN(created_at) AS started_at
         FROM conversations
         GROUP BY session_id
         ORDER BY last_updated DESC`
      ).all();

      const sessions = rows.map(r => ({
        sessionId: r.session_id,
        agentId: r.agent_id ?? null,
        startedAt: r.started_at,
        lastUpdated: r.last_updated
      }));

      sendJson(res, 200, { sessions });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to list conversations: ${err.message}` });
    }
    return;
  }

  // GET /agent-api/conversations/:sessionId — get history
  if (req.method === 'GET' && sessionId) {
    try {
      const messages = await conversationStore.getHistory(sessionId);
      sendJson(res, 200, { sessionId, messages });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to load history: ${err.message}` });
    }
    return;
  }

  // DELETE /agent-api/conversations/:sessionId — delete session
  if (req.method === 'DELETE' && sessionId) {
    try {
      db.prepare('DELETE FROM conversations WHERE session_id = ?').run(sessionId);
      sendJson(res, 200, { deleted: true });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to delete session: ${err.message}` });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}
