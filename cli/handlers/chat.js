/**
 * Chat handler — POST /agent-api/chat
 *
 * Authenticates the user, loads preferences + prompt, starts a ReAct loop,
 * and streams events back as SSE.
 *
 * Request:
 *   POST /agent-api/chat
 *   Header: Authorization: Bearer <userJwt>
 *   Body: { message: string, sessionId?: string, agentId?: string }
 *
 * Response: SSE stream of ReactEvent objects
 */

import { initSSE } from '../sse.js';
import { reactLoop } from '../react-engine.js';
import { readBody, sendJson, loadPromotedTools, extractJwt } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry, hitlEngine, verifierRunner }
 */
export async function handleChat(req, res, ctx) {
  const { auth, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry } = ctx;

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }
  const userId = authResult.userId;
  const userJwt = extractJwt(req);

  // 2. Parse body
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: err.message });
    return;
  }
  if (!body.message) {
    sendJson(res, 400, { error: 'message is required' });
    return;
  }

  // 3. Resolve agent
  const requestedAgentId = body.agentId || null;
  let agent = null;
  if (agentRegistry) {
    agent = agentRegistry.resolveAgent(requestedAgentId);
    if (requestedAgentId && !agent) {
      sendJson(res, 404, { error: `Agent "${requestedAgentId}" not found or disabled` });
      return;
    }
  }

  // 4. Build agent-scoped config
  const scopedConfig = agentRegistry ? agentRegistry.buildAgentConfig(config, agent) : config;

  // 5. Resolve user preferences against scoped config
  const effective = preferenceStore.resolveEffective(userId, scopedConfig, env);

  // 6. Pre-validate API key before starting SSE
  if (!effective.apiKey) {
    sendJson(res, 500, {
      error: `No API key configured for provider "${effective.provider}". Set the appropriate environment variable.`
    });
    return;
  }

  // 7. Get system prompt (agent → global → config → fallback)
  const systemPrompt = agentRegistry
    ? agentRegistry.resolveSystemPrompt(agent, promptStore, scopedConfig)
    : (promptStore.getActivePrompt() || config.systemPrompt || 'You are a helpful assistant.');

  // 8. Session management
  let sessionId = body.sessionId;
  if (!sessionId) {
    sessionId = conversationStore.createSession();
  }

  // 9. Load history
  const rawHistory = await conversationStore.getHistory(sessionId);
  const window = scopedConfig.conversation?.window ?? 25;
  const history = rawHistory.slice(-window).map(row => ({
    role: row.role,
    content: row.content
  }));

  // Add current message to history
  const messages = [...history, { role: 'user', content: body.message }];

  // Persist user message
  try {
    await conversationStore.persistMessage(sessionId, 'chat', 'user', body.message, agent?.agent_id, userId);
  } catch (err) {
    process.stderr.write(`[chat] Failed to persist user message: ${err.message}\n`);
  }

  // 10. Load promoted tools (with agent allowlist filtering)
  const allowlist = agent?.tool_allowlist ?? '*';
  const parsedAllowlist = (allowlist !== '*') ? (() => { try { const parsed = JSON.parse(allowlist); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() : '*';
  const { toolRows, tools } = loadPromotedTools(db, parsedAllowlist);

  // 11. Start SSE stream
  const sse = initSSE(res);

  // Send session info (include agentId for client correlation)
  const sessionEvent = { sessionId };
  if (agent) sessionEvent.agentId = agent.agent_id;
  sse.send('session', sessionEvent);

  // 12. Build per-request hooks
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

  // 13. Run ReAct loop
  try {
    const gen = reactLoop({
      provider: effective.provider,
      apiKey: effective.apiKey,
      model: effective.model,
      systemPrompt,
      tools,
      messages,
      maxTurns: scopedConfig.maxTurns ?? 10,
      maxTokens: scopedConfig.maxTokens ?? 4096,
      forgeConfig: scopedConfig,
      db,
      userJwt,
      hooks,
      stream: true
    });

    let assistantText = '';
    for await (const event of gen) {
      // HITL fix: intercept hitl events, persist partial text, persist pause state, attach resumeToken
      if (event.type === 'hitl' && hitlEngine) {
        if (assistantText) {
          await conversationStore.persistMessage(sessionId, 'chat', 'assistant', assistantText, agent?.agent_id, userId);
        }
        const resumeToken = await hitlEngine.pause({
          sessionId,
          agentId: agent?.agent_id ?? null,
          conversationMessages: event.conversationMessages,
          pendingToolCalls: event.pendingToolCalls,
          turnIndex: event.turnIndex,
          tool: event.tool,
          args: event.args
        });
        sse.send('hitl', {
          type: 'hitl',
          tool: event.tool,
          message: event.message,
          resumeToken
        });
        assistantText = '';
        continue;
      }

      sse.send(event.type, event);

      // Accumulate assistant text for persistence
      if (event.type === 'text_delta') {
        assistantText += event.content;
      }
      if (event.type === 'text') {
        assistantText = event.content; // authoritative overwrite
      }

      // Persist on completion
      if (event.type === 'done' && assistantText) {
        await conversationStore.persistMessage(sessionId, 'chat', 'assistant', assistantText, agent?.agent_id, userId);
      }
    }
  } catch (err) {
    sse.send('error', { type: 'error', message: err.message });
  }

  sse.close();
}
