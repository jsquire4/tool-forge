/**
 * Chat Sync handler — POST /agent-api/chat-sync
 *
 * Synchronous variant of the chat endpoint. Reuses all shared infrastructure
 * (auth, preferences, prompt, session, history, hooks, reactLoop) but buffers
 * events and returns a single JSON response instead of SSE.
 *
 * Request:
 *   POST /agent-api/chat-sync
 *   Header: Authorization: Bearer <userJwt>  (or ?token=<jwt> query param)
 *   Body: { message: string, sessionId?: string }
 *
 * Response (200):
 *   { conversationId, message, toolCalls, warnings, flags }
 *
 * Response (409 — HITL pause):
 *   { resumeToken, tool, message }
 */

import { reactLoop } from '../react-engine.js';
import { readBody, sendJson, loadPromotedTools } from '../http-utils.js';

/**
 * Extract JWT token from header or query param.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
function extractJwt(req) {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const hdr = authHeader.slice(7);
    if (hdr) return hdr;
  }
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      return url.searchParams.get('token') || null;
    } catch { /* malformed URL */ }
  }
  return null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, promptStore, preferenceStore, conversationStore, db, config, env, hooks }
 */
export async function handleChatSync(req, res, ctx) {
  const { auth, promptStore, preferenceStore, conversationStore, db, config, env } = ctx;

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }
  const userId = authResult.userId;
  const userJwt = extractJwt(req);

  // 2. Parse body
  const body = await readBody(req);
  if (!body.message) {
    sendJson(res, 400, { error: 'message is required' });
    return;
  }

  // 3. Resolve user preferences
  const effective = preferenceStore.resolveEffective(userId, config, env);

  // 4. Get system prompt
  const systemPrompt = promptStore.getActivePrompt() || config.systemPrompt || 'You are a helpful assistant.';

  // 5. Session management
  let sessionId = body.sessionId;
  if (!sessionId) {
    sessionId = conversationStore.createSession();
  }

  // 6. Load history
  const rawHistory = await conversationStore.getHistory(sessionId);
  const window = config.conversation?.window ?? 25;
  const history = rawHistory.slice(-window).map(row => ({
    role: row.role,
    content: row.content
  }));

  // Add current message to history
  const messages = [...history, { role: 'user', content: body.message }];

  // Persist user message
  await conversationStore.persistMessage(sessionId, 'chat', 'user', body.message);

  // 7. Load promoted tools
  const { toolRows, tools } = loadPromotedTools(db);

  // 8. Build per-request hooks
  const { hitlEngine, verifierRunner } = ctx;
  if (verifierRunner) {
    try { await verifierRunner.loadFromDb(db); } catch { /* non-fatal */ }
  }

  const hooks = {
    shouldPause(toolCall) {
      if (!hitlEngine) return { pause: false };
      let toolSpec = {};
      const row = toolRows.find(r => r.tool_name === toolCall.name);
      if (row?.spec_json) {
        try { toolSpec = JSON.parse(row.spec_json); } catch { /* ignore */ }
      }
      return {
        pause: hitlEngine.shouldPause(effective.hitlLevel, toolSpec),
        message: `Tool "${toolCall.name}" requires confirmation`
      };
    },
    async onAfterToolCall(toolName, args, result) {
      if (!verifierRunner) return { outcome: 'pass' };
      const vResult = await verifierRunner.verify(toolName, args, result);
      if (vResult.outcome !== 'pass') {
        verifierRunner.logResult(sessionId, toolName, vResult);
      }
      return vResult;
    }
  };

  // 9. Run ReAct loop and buffer events
  const result = { conversationId: sessionId, message: '', toolCalls: [], warnings: [], flags: [] };

  try {
    const gen = reactLoop({
      provider: effective.provider,
      apiKey: effective.apiKey,
      model: effective.model,
      systemPrompt,
      tools,
      messages,
      maxTurns: config.maxTurns ?? 10,
      maxTokens: config.maxTokens ?? 4096,
      forgeConfig: config,
      db,
      userJwt,
      hooks
    });

    for await (const event of gen) {
      switch (event.type) {
        case 'text':
          result.message += event.content;
          break;
        case 'tool_call':
          result.toolCalls.push({ id: event.id, name: event.tool, args: event.args });
          break;
        case 'tool_result': {
          const tc = result.toolCalls.find(t => t.id === event.id);
          if (tc) tc.result = event.result;
          break;
        }
        case 'tool_warning':
          result.warnings.push({ tool: event.tool, message: event.message, verifier: event.verifier });
          break;
        case 'hitl':
          // Persist any text accumulated before the pause
          if (result.message) {
            await conversationStore.persistMessage(sessionId, 'chat', 'assistant', result.message);
          }
          return sendJson(res, 409, { resumeToken: event.resumeToken, tool: event.tool, message: event.message });
        case 'error':
          result.flags.push(event.message);
          break;
        case 'done':
          break; // handled after loop
      }
    }
  } catch (err) {
    result.flags.push(err.message);
  }

  // Persist assistant message + respond
  if (result.message) {
    await conversationStore.persistMessage(sessionId, 'chat', 'assistant', result.message);
  }
  sendJson(res, 200, result);
}
