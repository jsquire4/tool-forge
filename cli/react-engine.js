/**
 * ReAct Engine — standalone ReAct loop module.
 *
 * Async generator that yields typed events. Transport-agnostic:
 * caller converts events to SSE, console output, or whatever.
 *
 * Event types:
 *   text         — assistant text chunk
 *   tool_call    — assistant wants to call a tool
 *   tool_result  — tool execution result
 *   tool_warning — verifier returned 'warn' outcome
 *   hitl         — loop paused for human confirmation
 *   done         — loop complete (includes usage summary)
 *   error        — unrecoverable error
 */

import { llmTurn, llmTurnStreaming, normalizeUsage } from './api-client.js';
import { getAllToolRegistry, insertMcpCallLog } from './db.js';

/**
 * @typedef {'text'|'text_delta'|'tool_call'|'tool_result'|'tool_warning'|'hitl'|'done'|'error'} ReactEventType
 * @typedef {{ type: ReactEventType, content?, tool?, args?, result?, resumeToken?, message?, usage? }} ReactEvent
 */

/**
 * Run a ReAct loop. Yields ReactEvent objects via async generator.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {object[]} opts.tools          — forge-format tool defs
 * @param {object[]} opts.messages       — conversation history
 * @param {number}   [opts.maxTurns=10]  — safety limit
 * @param {number}   [opts.maxTokens=4096] — per-turn
 * @param {object}   opts.forgeConfig    — for tool routing
 * @param {Database} opts.db             — for tool registry reads + MCP log writes
 * @param {string|null} [opts.userJwt]   — forwarded to tool HTTP calls
 * @param {boolean}  [opts.stream=false]  — enable token-level streaming
 * @param {object}   [opts.hooks]        — { shouldPause, onAfterToolCall }
 * @yields {ReactEvent}
 */
export async function* reactLoop(opts) {
  const {
    provider, apiKey, model, systemPrompt, tools, messages,
    maxTurns = 10, maxTokens = 4096,
    forgeConfig = {}, db = null, userJwt = null,
    hooks = {}, stream = false
  } = opts;

  const shouldPause = hooks.shouldPause ?? (() => ({ pause: false }));
  const onAfterToolCall = hooks.onAfterToolCall ?? (() => ({ outcome: 'pass' }));

  const conversationMessages = [...messages];
  let totalUsage = { inputTokens: 0, outputTokens: 0 };

  for (let turn = 0; turn < maxTurns; turn++) {
    let response;
    try {
      if (stream) {
        let fullText = '';
        const streamGen = llmTurnStreaming({
          provider, apiKey, model,
          system: systemPrompt,
          messages: conversationMessages,
          tools,
          maxTokens
        });
        for await (const chunk of streamGen) {
          if (chunk.type === 'text_delta') {
            yield { type: 'text_delta', content: chunk.text };
            fullText += chunk.text;
          } else if (chunk.type === 'done') {
            fullText = chunk.text; // authoritative
            response = {
              text: fullText,
              toolCalls: chunk.toolCalls,
              rawContent: null,
              stopReason: chunk.stopReason,
              usage: chunk.usage
            };
          }
        }
        if (!response) {
          yield { type: 'error', message: 'LLM stream ended without completion' };
          return;
        }
      } else {
        response = await llmTurn({
          provider, apiKey, model,
          system: systemPrompt,
          messages: conversationMessages,
          tools,
          maxTokens
        });
      }
    } catch (err) {
      yield { type: 'error', message: `LLM call failed: ${err.message}` };
      return;
    }

    // Accumulate usage
    if (response.usage) {
      const normalized = normalizeUsage(response.usage, provider);
      totalUsage.inputTokens += normalized.inputTokens;
      totalUsage.outputTokens += normalized.outputTokens;
    }

    // Emit text if present
    if (response.text) {
      yield { type: 'text', content: response.text };
    }

    // If no tool calls, the loop is done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      yield { type: 'done', usage: totalUsage };
      return;
    }

    // Process tool calls
    const toolResults = [];
    for (const toolCall of response.toolCalls) {
      yield { type: 'tool_call', tool: toolCall.name, args: toolCall.input, id: toolCall.id };

      // Check HITL before execution
      let pauseCheck;
      try { pauseCheck = shouldPause(toolCall); } catch { pauseCheck = { pause: false }; }
      if (pauseCheck.pause) {
        yield {
          type: 'hitl',
          tool: toolCall.name,
          args: toolCall.input,
          message: pauseCheck.message ?? 'Tool call requires confirmation',
          pendingToolCalls: response.toolCalls,
          conversationMessages: [...conversationMessages],
          turnIndex: turn
        };
        return;
      }

      // Execute tool
      let result;
      try {
        result = await executeToolCall(toolCall.name, toolCall.input, forgeConfig, db, userJwt);
      } catch (err) {
        result = { status: 0, body: { error: err.message }, error: err.message };
      }

      yield { type: 'tool_result', tool: toolCall.name, result: result.body, id: toolCall.id };

      // Run verifiers
      let verifyResult;
      try { verifyResult = await onAfterToolCall(toolCall.name, toolCall.input, result); } catch { verifyResult = { outcome: 'pass' }; }
      if (verifyResult.outcome === 'warn') {
        yield { type: 'tool_warning', tool: toolCall.name, message: verifyResult.message, verifier: verifyResult.verifierName };
      } else if (verifyResult.outcome === 'block') {
        yield {
          type: 'hitl',
          tool: toolCall.name,
          message: verifyResult.message ?? 'Verifier blocked tool result',
          verifier: verifyResult.verifierName,
          pendingToolCalls: response.toolCalls,
          conversationMessages: [...conversationMessages],
          turnIndex: turn
        };
        return;
      }

      toolResults.push({ toolCall, result });
    }

    // Add tool call history in the correct format for the provider
    if (provider === 'anthropic') {
      // Anthropic expects assistant message with content array, then user message with tool_result blocks
      conversationMessages.push({
        role: 'assistant',
        content: [
          ...(response.text ? [{ type: 'text', text: response.text }] : []),
          ...toolResults.map(({ toolCall }) => ({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input
          }))
        ]
      });
      conversationMessages.push({
        role: 'user',
        content: toolResults.map(({ toolCall, result }) => ({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result.body)
        }))
      });
    } else {
      // OpenAI-compatible: assistant message with tool_calls array, then individual tool role messages
      conversationMessages.push({
        role: 'assistant',
        content: response.text || null,
        tool_calls: toolResults.map(({ toolCall }) => ({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input
        }))
      });
      for (const { toolCall, result } of toolResults) {
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.body)
        });
      }
    }
  }

  // Safety limit reached
  yield { type: 'error', message: `ReAct loop reached maxTurns limit (${maxTurns})` };
}

/**
 * Execute a single tool call — routes to the app's API endpoint.
 * Adapted from mcp-server.js callToolEndpoint for direct use by the ReAct loop.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {object} forgeConfig — forge config with api.baseUrl
 * @param {Database|null} db — for MCP call logging
 * @param {string|null} userJwt — forwarded as Authorization header
 * @returns {Promise<{ status: number, body: object, error: string|null }>}
 */
export async function executeToolCall(toolName, args, forgeConfig, db, userJwt) {
  // Look up tool spec in registry
  let spec;
  if (db) {
    const rows = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
    const row = rows.find(r => r.tool_name === toolName);
    if (!row) {
      return { status: 404, body: { error: `Tool "${toolName}" not found in registry` }, error: 'Tool not found' };
    }
    try {
      spec = JSON.parse(row.spec_json);
    } catch {
      return { status: 500, body: { error: `Tool "${toolName}" has malformed spec_json` }, error: 'Malformed spec' };
    }
  } else {
    return { status: 500, body: { error: 'No database available for tool lookup' }, error: 'No db' };
  }

  const routing = spec.mcpRouting || {};
  if (!routing.endpoint) {
    return { status: 400, body: { error: `Tool "${toolName}" has no mcpRouting.endpoint` }, error: 'No endpoint' };
  }

  const baseUrl = (forgeConfig.api?.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
  const path = routing.endpoint;
  const method = (routing.method || 'GET').toUpperCase();
  const paramMap = routing.paramMap || {};

  // Build URL with path params substituted; collect query and body params
  let url = baseUrl + path;
  const queryParams = new URLSearchParams();
  const bodyObj = {};

  for (const [toolParam, mapping] of Object.entries(paramMap)) {
    const val = args[toolParam];
    if (val === undefined) continue;
    if (mapping.path) {
      url = url.replace(`{${mapping.path}}`, encodeURIComponent(String(val)));
    } else if (mapping.query) {
      queryParams.set(mapping.query, String(val));
    } else if (mapping.body) {
      bodyObj[mapping.body] = val;
    }
  }

  if ([...queryParams].length > 0) url += '?' + queryParams.toString();

  const fetchOpts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30_000)
  };

  // Forward user JWT if present
  if (userJwt) {
    fetchOpts.headers['Authorization'] = `Bearer ${userJwt}`;
  }

  if (['POST', 'PUT', 'PATCH'].includes(method) && Object.keys(bodyObj).length > 0) {
    fetchOpts.body = JSON.stringify(bodyObj);
  }

  const startMs = Date.now();
  try {
    const res = await fetch(url, fetchOpts);
    const text = await res.text();
    const latencyMs = Date.now() - startMs;

    let body;
    try { body = JSON.parse(text); } catch { body = { text }; }

    // Log to MCP call log
    if (db) {
      try {
        insertMcpCallLog(db, {
          tool_name: toolName,
          input_json: JSON.stringify(args),
          output_json: text.slice(0, 10_000),
          status_code: res.status,
          latency_ms: latencyMs,
          error: res.ok ? null : text.slice(0, 500)
        });
      } catch { /* log failure is non-fatal */ }
    }

    return {
      status: res.status,
      body,
      error: res.ok ? null : `HTTP ${res.status}: ${text.slice(0, 200)}`
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    if (db) {
      try {
        insertMcpCallLog(db, {
          tool_name: toolName,
          input_json: JSON.stringify(args),
          status_code: 0,
          latency_ms: latencyMs,
          error: err.message
        });
      } catch { /* log failure is non-fatal */ }
    }
    return { status: 0, body: { error: err.message }, error: err.message };
  }
}
