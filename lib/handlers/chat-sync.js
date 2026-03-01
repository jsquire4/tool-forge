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
 *   Body: { message: string, sessionId?: string, agentId?: string }
 *
 * Response (200):
 *   { conversationId, agentId?, message, toolCalls, warnings, flags }
 *
 * Response (409 — HITL pause):
 *   { resumeToken, tool, message }
 */

import { reactLoop } from '../react-engine.js';
import { readBody, sendJson, loadPromotedTools, extractJwt } from '../http-utils.js';
import { insertChatAudit } from '../db.js';

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} ctx — { auth, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry, hitlEngine, verifierRunner }
 */
export async function handleChatSync(req, res, ctx) {
  const { auth, promptStore, preferenceStore, conversationStore, db, config, env, agentRegistry } = ctx;
  const startTime = Date.now();

  // 1. Authenticate
  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: 'anon', route: '/agent-api/chat-sync',
          status_code: 401, duration_ms: Date.now() - startTime,
          error_message: authResult.error ?? 'Unauthorized'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }
  const userId = authResult.userId;
  const userJwt = extractJwt(req);

  // 1b. Rate limiting — applied after auth (per-user)
  if (ctx.rateLimiter) {
    const rlResult = await ctx.rateLimiter.check(userId, '/agent-api/chat-sync');
    if (!rlResult.allowed) {
      res.setHeader?.('Retry-After', String(rlResult.retryAfter ?? 60));
      if (db) {
        try {
          insertChatAudit(db, {
            session_id: '', user_id: userId, route: '/agent-api/chat-sync',
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
          session_id: '', user_id: userId, route: '/agent-api/chat-sync',
          status_code: 413, duration_ms: Date.now() - startTime,
          error_message: err.message
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 413, { error: err.message });
    return;
  }
  if (!body.message) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat-sync',
          status_code: 400, duration_ms: Date.now() - startTime,
          error_message: 'message is required'
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 400, { error: 'message is required' });
    return;
  }

  // 3. Resolve agent
  const requestedAgentId = body.agentId || null;
  let agent = null;
  if (agentRegistry) {
    agent = agentRegistry.resolveAgent(requestedAgentId);
    if (requestedAgentId && !agent) {
      if (db) {
        try {
          insertChatAudit(db, {
            session_id: '', user_id: userId, route: '/agent-api/chat-sync',
            status_code: 404, duration_ms: Date.now() - startTime,
            error_message: `Agent "${requestedAgentId}" not found or disabled`
          });
        } catch { /* non-fatal */ }
      }
      sendJson(res, 404, { error: `Agent "${requestedAgentId}" not found or disabled` });
      return;
    }
  }

  // 4. Build agent-scoped config
  const scopedConfig = agentRegistry ? agentRegistry.buildAgentConfig(config, agent) : config;

  // 5. Resolve user preferences
  const effective = await preferenceStore.resolveEffective(userId, scopedConfig, env);

  // 6. Pre-validate API key
  if (!effective.apiKey) {
    if (db) {
      try {
        insertChatAudit(db, {
          session_id: '', user_id: userId, route: '/agent-api/chat-sync',
          status_code: 500, duration_ms: Date.now() - startTime,
          error_message: `No API key configured for provider "${effective.provider}"`
        });
      } catch { /* non-fatal */ }
    }
    sendJson(res, 500, {
      error: `No API key configured for provider "${effective.provider}". Set the appropriate environment variable.`
    });
    return;
  }

  // 7. Get system prompt
  const systemPrompt = agentRegistry
    ? await agentRegistry.resolveSystemPrompt(agent, promptStore, scopedConfig)
    : (promptStore.getActivePrompt() || config.systemPrompt || 'You are a helpful assistant.');

  // 7. Session management
  let sessionId = body.sessionId;
  if (!sessionId) {
    sessionId = conversationStore.createSession();
  }

  // Audit metadata — populated throughout
  const auditMeta = {
    session_id: sessionId,
    user_id: userId,
    agent_id: agent?.agent_id ?? null,
    route: '/agent-api/chat-sync',
    model: effective.model,
    message_text: body.message?.slice(0, 500) ?? null,
    tool_count: 0,
    hitl_triggered: 0,
    warnings_count: 0,
    status_code: 200,
    error_message: null
  };

  // 8. Load history
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
    process.stderr.write(`[chat-sync] Failed to persist user message: ${err.message}\n`);
  }

  // 10. Load promoted tools (with agent allowlist filtering)
  const allowlist = agent?.tool_allowlist ?? '*';
  const parsedAllowlist = (allowlist !== '*') ? (() => { try { const parsed = JSON.parse(allowlist); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() : '*';
  const { toolRows, tools } = loadPromotedTools(db, parsedAllowlist);

  // 10. Build per-request hooks
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

  // 11. Run ReAct loop and buffer events
  const result = { conversationId: sessionId, message: '', toolCalls: [], warnings: [], flags: [] };
  if (agent) result.agentId = agent.agent_id;

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
      hooks
    });

    for await (const event of gen) {
      switch (event.type) {
        case 'text':
          result.message = event.content;
          break;
        case 'tool_call':
          result.toolCalls.push({ id: event.id, name: event.tool, args: event.args });
          auditMeta.tool_count++;
          break;
        case 'tool_result': {
          const tc = result.toolCalls.find(t => t.id === event.id);
          if (tc) tc.result = event.result;
          break;
        }
        case 'tool_warning':
          result.warnings.push({ tool: event.tool, message: event.message, verifier: event.verifier });
          auditMeta.warnings_count++;
          break;
        case 'hitl': {
          auditMeta.hitl_triggered = 1;
          // Persist any text accumulated before the pause
          if (result.message) {
            await conversationStore.persistMessage(sessionId, 'chat', 'assistant', result.message, agent?.agent_id, userId);
          }
          // Require hitlEngine to persist pause state
          if (!hitlEngine) {
            auditMeta.status_code = 500;
            auditMeta.error_message = 'HITL engine not available; cannot pause';
            return sendJson(res, 500, { error: 'HITL engine not available; cannot pause' });
          }
          let resumeToken;
          try {
            resumeToken = await hitlEngine.pause({
              sessionId,
              agentId: agent?.agent_id ?? null,
              conversationMessages: event.conversationMessages,
              pendingToolCalls: event.pendingToolCalls,
              turnIndex: event.turnIndex,
              tool: event.tool,
              args: event.args
            });
          } catch (pauseErr) {
            auditMeta.status_code = 500;
            auditMeta.error_message = 'Failed to persist HITL state';
            return sendJson(res, 500, { error: 'Failed to persist HITL state' });
          }
          auditMeta.status_code = 409;
          return sendJson(res, 409, { resumeToken, tool: event.tool, message: event.message });
        }
        case 'error':
          result.flags.push(event.message);
          auditMeta.error_message = event.message;
          break;
        case 'done':
          break; // handled after loop
      }
    }
  } catch (err) {
    result.flags.push(err.message);
    auditMeta.status_code = 500;
    auditMeta.error_message = err.message;
  } finally {
    if (db) {
      try {
        insertChatAudit(db, { ...auditMeta, duration_ms: Date.now() - startTime });
      } catch { /* audit failure is non-fatal */ }
    }
  }

  // Persist assistant message + respond
  if (result.message) {
    try {
      await conversationStore.persistMessage(sessionId, 'chat', 'assistant', result.message, agent?.agent_id, userId);
    } catch (err) {
      process.stderr.write(`[chat-sync] Failed to persist assistant message: ${err.message}\n`);
    }
  }
  sendJson(res, 200, result);
}
