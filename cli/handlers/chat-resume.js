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
import { readBody, sendJson, loadPromotedTools } from '../http-utils.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, hitlEngine, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry, verifierRunner }
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
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 413, { error: err.message });
    return;
  }
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

  // 5. Recover agent from pause state (graceful degradation if agent gone)
  const { preferenceStore, promptStore, conversationStore, db, config, env, agentRegistry } = ctx;
  const userId = authResult.userId;
  let userJwt = (req.headers.authorization ?? '').slice(7) || null;
  if (!userJwt && req.url) {
    try { userJwt = new URL(req.url, 'http://localhost').searchParams.get('token') || null; } catch { /* malformed URL */ }
  }

  let agent = null;
  if (agentRegistry && pausedState.agentId) {
    agent = agentRegistry.resolveAgent(pausedState.agentId);
    // If agent no longer exists/disabled, fall back to base config (graceful degradation)
  }

  const scopedConfig = agentRegistry ? agentRegistry.buildAgentConfig(config, agent) : config;
  const effective = preferenceStore.resolveEffective(userId, scopedConfig, env);

  // Pre-validate API key
  if (!effective.apiKey) {
    sendJson(res, 500, {
      error: `No API key configured for provider "${effective.provider}". Set the appropriate environment variable.`
    });
    return;
  }

  const systemPrompt = agentRegistry
    ? agentRegistry.resolveSystemPrompt(agent, promptStore, scopedConfig)
    : (promptStore.getActivePrompt() || config.systemPrompt || 'You are a helpful assistant.');

  // Load promoted tools with agent allowlist
  const allowlist = agent?.tool_allowlist ?? '*';
  const parsedAllowlist = (allowlist !== '*') ? (() => { try { const parsed = JSON.parse(allowlist); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() : '*';
  const { toolRows, tools } = loadPromotedTools(db, parsedAllowlist);

  // Start SSE
  const sse = initSSE(res);

  // Build per-request hooks
  const { verifierRunner } = ctx;
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
        verifierRunner.logResult(pausedState.sessionId, toolName, vResult);
      }
      return vResult;
    }
  };

  try {
    // Continue from paused conversation messages
    const gen = reactLoop({
      provider: effective.provider,
      apiKey: effective.apiKey,
      model: effective.model,
      systemPrompt,
      tools,
      messages: pausedState.conversationMessages ?? [],
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
      // Handle nested HITL pauses during resume — persist partial text first
      if (event.type === 'hitl' && hitlEngine) {
        if (assistantText && pausedState.sessionId) {
          try {
            await conversationStore.persistMessage(pausedState.sessionId, 'chat', 'assistant', assistantText, agent?.agent_id ?? pausedState.agentId);
          } catch (err) {
            process.stderr.write(`[chat-resume] Failed to persist partial assistant message: ${err.message}\n`);
          }
        }
        const resumeToken = await hitlEngine.pause({
          sessionId: pausedState.sessionId,
          agentId: agent?.agent_id ?? pausedState.agentId ?? null,
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
      if (event.type === 'text_delta') assistantText += event.content;
      if (event.type === 'text') assistantText = event.content;
      if (event.type === 'done' && assistantText && pausedState.sessionId) {
        try {
          await conversationStore.persistMessage(pausedState.sessionId, 'chat', 'assistant', assistantText, agent?.agent_id ?? pausedState.agentId);
        } catch (err) {
          process.stderr.write(`[chat-resume] Failed to persist assistant message: ${err.message}\n`);
        }
      }
    }
  } catch (err) {
    sse.send('error', { type: 'error', message: err.message });
  }

  sse.close();
}
