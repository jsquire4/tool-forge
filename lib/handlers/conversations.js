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
  const { auth, conversationStore } = ctx;

  // Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  const userId = authResult.userId;

  if (!userId) {
    sendJson(res, 401, { error: 'Token has no user identity claim' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  // segments: ['agent-api', 'conversations', sessionId?]
  // Also handle /agent-api/v1/conversations/...
  const convIndex = segments.indexOf('conversations');
  const sessionId = convIndex >= 0 ? segments[convIndex + 1] : undefined;

  // GET /agent-api/conversations — list sessions (user-scoped)
  if (req.method === 'GET' && !sessionId) {
    try {
      const sessions = await conversationStore.listSessions(userId);
      sendJson(res, 200, { sessions });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to list conversations: ${err.message}` });
    }
    return;
  }

  // GET /agent-api/conversations/:sessionId — get history (ownership check)
  if (req.method === 'GET' && sessionId) {
    try {
      const ownerUserId = await conversationStore.getSessionUserId(sessionId);
      if (ownerUserId === undefined) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (ownerUserId !== userId) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      const messages = await conversationStore.getHistory(sessionId);
      sendJson(res, 200, { sessionId, messages });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to load history: ${err.message}` });
    }
    return;
  }

  // DELETE /agent-api/conversations/:sessionId — delete session (ownership check)
  if (req.method === 'DELETE' && sessionId) {
    try {
      const sessionUserId = await conversationStore.getSessionUserId(sessionId);
      if (sessionUserId === undefined) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      if (sessionUserId !== userId) {
        sendJson(res, 403, { error: 'Forbidden' });
        return;
      }
      await conversationStore.deleteSession(sessionId, userId);
      sendJson(res, 200, { deleted: true });
    } catch (err) {
      sendJson(res, 500, { error: `Failed to delete session: ${err.message}` });
    }
    return;
  }

  sendJson(res, 405, { error: 'Method not allowed' });
}
