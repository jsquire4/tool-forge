/**
 * Chat Resume handler — POST /agent-api/chat/resume
 *
 * Resumes a paused HITL state. If the user confirms, the ReAct loop
 * continues from where it paused. If rejected, the pause state is discarded.
 *
 * Request:
 *   POST /agent-api/chat/resume
 *   Header: Authorization: Bearer <userJwt>
 *   Body: { resumeToken: string, confirmed: boolean }
 *
 * Response:
 *   If confirmed: SSE stream of remaining ReactEvent objects
 *   If rejected:  JSON { message: "Cancelled" }
 *   If expired:   410 Gone
 */

import { initSSE } from '../sse.js';
import { reactLoop } from '../react-engine.js';
import { getAllToolRegistry } from '../db.js';
import { readBody, sendJson } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, hitlEngine, promptStore, preferenceStore, conversationStore, db, config, env }
 */
export async function handleChatResume(req, res, ctx) {
  const { auth, hitlEngine } = ctx;

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  // 2. Parse body
  const body = await readBody(req);
  if (!body.resumeToken) {
    sendJson(res, 400, { error: 'resumeToken is required' });
    return;
  }

  // 3. Retrieve paused state
  if (!hitlEngine) {
    sendJson(res, 501, { error: 'HITL engine not initialized' });
    return;
  }

  const pausedState = await hitlEngine.resume(body.resumeToken);
  if (!pausedState) {
    sendJson(res, 410, { error: 'Resume token expired or invalid' });
    return;
  }

  // 4. If rejected, return cancellation
  if (!body.confirmed) {
    sendJson(res, 200, { message: 'Cancelled' });
    return;
  }

  // 5. Resume the ReAct loop
  const { preferenceStore, promptStore, conversationStore, db, config, env } = ctx;
  const userId = authResult.userId;
  const userJwt = (req.headers.authorization ?? '').slice(7) || null;
  const effective = preferenceStore.resolveEffective(userId, config, env);
  const systemPrompt = promptStore.getActivePrompt() || config.systemPrompt || 'You are a helpful assistant.';

  // Load promoted tools
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
    } catch { /* skip */ }
  }

  // Start SSE
  const sse = initSSE(res);

  const hooks = ctx.hooks ?? {};

  try {
    // Continue from paused conversation messages
    const gen = reactLoop({
      provider: effective.provider,
      apiKey: effective.apiKey,
      model: effective.model,
      systemPrompt,
      tools,
      messages: pausedState.conversationMessages ?? [],
      maxTurns: config.maxTurns ?? 10,
      forgeConfig: config,
      db,
      userJwt,
      hooks
    });

    let assistantText = '';
    for await (const event of gen) {
      sse.send(event.type, event);
      if (event.type === 'text') assistantText += event.content;
      if (event.type === 'done' && assistantText && pausedState.sessionId) {
        await conversationStore.persistMessage(pausedState.sessionId, 'chat', 'assistant', assistantText);
      }
    }
  } catch (err) {
    sse.send('error', { type: 'error', message: err.message });
  }

  sse.close();
}

