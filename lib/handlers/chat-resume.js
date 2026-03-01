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
import { readBody, sendJson, loadPromotedTools, extractJwt } from '../http-utils.js';
import { insertChatAudit } from '../db.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, hitlEngine, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry, verifierRunner }
 */
export async function handleChatResume(req, res, ctx) {
  const { auth, hitlEngine, db } = ctx;
  const startTime = Date.now();
  let auditUserId = 'anon';
  let auditSessionId = null;
  let auditAgentId = null;
  let auditModel = null;
  let auditStatusCode = 200;
  let auditErrorMessage = null;
  let auditToolCount = 0;
  let auditHitlTriggered = 0;
  let auditWarningsCount = 0;

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: 'anon', route: '/agent-api/chat/resume',
          status_code: 401, duration_ms: Date.now() - startTime,
          error_message: authResult.error ?? 'Unauthorized'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }
  const userId = authResult.userId;
  auditUserId = userId;

  // 1b. Rate limiting — applied after auth (per-user)
  if (ctx.rateLimiter) {
    const rlResult = await ctx.rateLimiter.check(authResult.userId, '/agent-api/chat/resume');
    if (!rlResult.allowed) {
      res.setHeader?.('Retry-After', String(rlResult.retryAfter ?? 60));
      if (db) {
        try {
          insertChatAudit(db, {
            session_id: '', user_id: userId, route: '/agent-api/chat/resume',
            status_code: 429, duration_ms: Date.now() - startTime,
            error_message: 'Rate limit exceeded'
          });
        } catch { /* non-fatal */ }
      }
      sendJson(res, 429, { error: 'Rate limit exceeded', retryAfter: rlResult.retryAfter });
      return;
    }
  }

  // 2. Parse body
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat/resume',
          status_code: 413, duration_ms: Date.now() - startTime,
          error_message: err.message
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 413, { error: err.message });
    return;
  }
  if (!body.resumeToken) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat/resume',
          status_code: 400, duration_ms: Date.now() - startTime,
          error_message: 'resumeToken is required'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 400, { error: 'resumeToken is required' });
    return;
  }

  // 3. Check confirmed FIRST — a cancellation needs no engine at all
  if (body.confirmed !== true) {
    // Cancellation returns 200 regardless of token validity — the end state
    // (not resuming) is the same whether the token was valid or expired.
    // Clients that need to distinguish "cancelled" from "token not found"
    // should do a GET /hitl/status check before cancelling.
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat/resume',
          status_code: 200, duration_ms: Date.now() - startTime,
          error_message: null
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 200, { message: 'Cancelled' });
    return;
  }

  // 4. Check hitlEngine exists (only needed for actual resume)
  if (!hitlEngine) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat/resume',
          status_code: 501, duration_ms: Date.now() - startTime,
          error_message: 'HITL engine not available'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 501, { error: 'HITL engine not available' });
    return;
  }

  // 5. NOW consume the pause state
  const pausedState = await hitlEngine.resume(body.resumeToken);
  if (!pausedState) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat/resume',
          status_code: 404, duration_ms: Date.now() - startTime,
          error_message: 'Resume token not found or expired'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 404, { error: 'Resume token not found or expired' });
    return;
  }

  // 6. Recover agent from pause state (graceful degradation if agent gone)
  const { preferenceStore, promptStore, conversationStore, config, env, agentRegistry } = ctx;
  const userJwt = extractJwt(req);

  auditSessionId = pausedState.sessionId ?? null;

  let agent = null;
  if (agentRegistry && pausedState.agentId) {
    agent = agentRegistry.resolveAgent(pausedState.agentId);
    // If agent no longer exists/disabled, fall back to base config (graceful degradation)
  }

  auditAgentId = agent?.agent_id ?? pausedState.agentId ?? null;

  const scopedConfig = agentRegistry ? agentRegistry.buildAgentConfig(config, agent) : config;
  const effective = await preferenceStore.resolveEffective(userId, scopedConfig, env);

  auditModel = effective.model;

  // Pre-validate API key
  if (!effective.apiKey) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: auditSessionId ?? '', user_id: userId,
          agent_id: auditAgentId ?? null, route: '/agent-api/chat/resume',
          status_code: 500, duration_ms: Date.now() - startTime,
          model: auditModel ?? null,
          error_message: `No API key configured for provider "${effective.provider}"`
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 500, {
      error: `No API key configured for provider "${effective.provider}". Set the appropriate environment variable.`
    });
    return;
  }

  const systemPrompt = agentRegistry
    ? await agentRegistry.resolveSystemPrompt(agent, promptStore, scopedConfig)
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
      if (event.type === 'hitl' && !hitlEngine) {
        auditStatusCode = 500;
        auditErrorMessage = 'HITL triggered but engine not available; cannot pause';
        sse.send('error', { message: 'HITL triggered but engine not available; cannot pause' });
        sse.close();
        return;
      }
      if (event.type === 'hitl' && hitlEngine) {
        auditHitlTriggered = 1;
        if (assistantText && pausedState.sessionId) {
          try {
            await conversationStore.persistMessage(pausedState.sessionId, 'chat', 'assistant', assistantText, agent?.agent_id ?? pausedState.agentId, userId);
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

      // Track counts for audit log
      if (event.type === 'tool_call') auditToolCount++;
      if (event.type === 'tool_warning') auditWarningsCount++;

      if (event.type === 'text_delta') assistantText += event.content;
      if (event.type === 'text') assistantText = event.content;
      if (event.type === 'done' && assistantText && pausedState.sessionId) {
        try {
          await conversationStore.persistMessage(pausedState.sessionId, 'chat', 'assistant', assistantText, agent?.agent_id ?? pausedState.agentId, userId);
        } catch (err) {
          process.stderr.write(`[chat-resume] Failed to persist assistant message: ${err.message}\n`);
        }
      }
    }
  } catch (err) {
    auditStatusCode = 500;
    auditErrorMessage = err.message;
    sse.send('error', { type: 'error', message: err.message });
  } finally {
    sse.close();
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: auditSessionId ?? '',
          user_id: auditUserId,
          agent_id: auditAgentId ?? null,
          route: '/agent-api/chat/resume',
          status_code: auditStatusCode,
          duration_ms: Date.now() - startTime,
          model: auditModel ?? null,
          tool_count: auditToolCount,
          hitl_triggered: auditHitlTriggered,
          warnings_count: auditWarningsCount,
          error_message: auditErrorMessage ?? null
        });
      } catch { /* audit failure is non-fatal */ }
    }
  }
}
