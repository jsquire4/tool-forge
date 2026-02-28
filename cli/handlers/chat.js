/**
 * Chat handler — POST /agent-api/chat
 *
 * Authenticates the user, loads preferences + prompt, starts a ReAct loop,
 * and streams events back as SSE.
 *
 * Request:
 *   POST /agent-api/chat
 *   Header: Authorization: Bearer <userJwt>
 *   Body: { message: string, sessionId?: string }
 *
 * Response: SSE stream of ReactEvent objects
 */

import { initSSE } from '../sse.js';
import { reactLoop } from '../react-engine.js';
import { getAllToolRegistry, getVerifiersForTool } from '../db.js';
import { readBody, sendJson } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, promptStore, preferenceStore, conversationStore, db, config, env, hooks }
 */
export async function handleChat(req, res, ctx) {
  const { auth, promptStore, preferenceStore, conversationStore, db, config, env } = ctx;

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }
  const userId = authResult.userId;
  const userJwt = (req.headers.authorization ?? '').slice(7) || null;

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
  const toolRows = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
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
        jsonSchema: { type: 'object', properties, required }
      });
    } catch { /* skip malformed specs */ }
  }

  // 8. Start SSE stream
  const sse = initSSE(res);

  // Send session info
  sse.send('session', { sessionId });

  // 9. Build per-request hooks
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

  // 10. Run ReAct loop
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

    let assistantText = '';
    for await (const event of gen) {
      sse.send(event.type, event);

      // Accumulate assistant text for persistence
      if (event.type === 'text') {
        assistantText += event.content;
      }

      // Persist on completion
      if (event.type === 'done' && assistantText) {
        await conversationStore.persistMessage(sessionId, 'chat', 'assistant', assistantText);
      }
    }
  } catch (err) {
    sse.send('error', { type: 'error', message: err.message });
  }

  sse.close();
}

