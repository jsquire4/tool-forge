/**
 * Shared LLM client — Anthropic + OpenAI.
 * Used by forge-engine, forge-file-writer, forge-eval-generator, forge-verifier-generator, chat.js, eval-runner.js
 *
 * No external dependencies — uses built-in `https` module only.
 */

import { request as httpsRequest } from 'https';

// ── Transport ──────────────────────────────────────────────────────────────

/**
 * Perform an HTTPS POST request.
 *
 * @param {string} hostname      - e.g. 'api.anthropic.com'
 * @param {string} path          - e.g. '/v1/messages'
 * @param {object} headers       - HTTP headers (Content-Type etc.)
 * @param {object} body          - Request body (will be JSON-serialised)
 * @param {number} [timeoutMs]   - Request timeout in ms (default 60 000)
 * @returns {Promise<{ status: number, body: string }>}
 */
export function httpsPost(hostname, path, headers, body, timeoutMs = 60_000) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname,
        path,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }
      },
      (resp) => {
        let data = '';
        resp.on('error', rej);
        resp.on('data', (d) => { data += d; });
        resp.on('end', () => res({ status: resp.statusCode, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('API timeout')));
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

// ── Tool format converters ─────────────────────────────────────────────────

/**
 * Convert a forge-format tool to Anthropic tool format.
 *
 * @param {{ name: string, description?: string, inputSchema?: object }} t
 * @returns {{ name: string, description: string, input_schema: object }}
 */
export function toAnthropicTool(t) {
  return {
    name: t.name,
    description: t.description || '',
    input_schema: t.inputSchema || { type: 'object', properties: {} }
  };
}

/**
 * Convert a forge-format tool to OpenAI tool format.
 *
 * @param {{ name: string, description?: string, inputSchema?: object }} t
 * @returns {{ type: 'function', function: { name: string, description: string, parameters: object } }}
 */
export function toOpenAiTool(t) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} }
    }
  };
}

// ── Unified LLM turn ───────────────────────────────────────────────────────

/**
 * Perform a single LLM turn against Anthropic or OpenAI.
 *
 * @param {object}   opts
 * @param {'anthropic'|'openai'} opts.provider
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {string}   [opts.system]      - System prompt (optional)
 * @param {object[]} opts.messages      - Provider-format message history
 * @param {object[]} [opts.tools]       - Forge-format tools (auto-converted per provider)
 * @param {number}   [opts.maxTokens]   - Default 4096
 * @param {number}   [opts.timeoutMs]   - Default 60 000
 * @returns {Promise<{
 *   text: string,
 *   toolCalls: Array<{ id: string, name: string, input: object }>,
 *   rawContent: any,
 *   stopReason: string|null,
 *   usage: object|null
 * }>}
 */
export async function llmTurn({
  provider,
  apiKey,
  model,
  system,
  messages,
  tools = [],
  maxTokens = 4096,
  timeoutMs = 60_000
}) {
  if (provider === 'anthropic') {
    return _anthropicTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
  }
  if (provider === 'openai') {
    return _openaiTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
  }
  if (provider === 'google') {
    return _geminiTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
  }
  if (provider === 'deepseek') {
    return _deepseekTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
  }
  throw new Error(`llmTurn: unknown provider "${provider}". Expected 'anthropic', 'openai', 'google', or 'deepseek'.`);
}

/**
 * Normalise provider-specific usage objects to a common shape.
 * Anthropic: { input_tokens, output_tokens }
 * OpenAI/DeepSeek/Gemini-compat: { prompt_tokens, completion_tokens }
 *
 * @param {object|null} usage - Raw usage object from API response
 * @param {string} provider
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
export function normalizeUsage(usage, provider) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  if (provider === 'anthropic') {
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0
    };
  }
  // OpenAI-compatible (openai, google, deepseek)
  return {
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0
  };
}

// ── Internal: Anthropic ────────────────────────────────────────────────────

async function _anthropicTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {})
  };

  const raw = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey
    },
    body,
    timeoutMs
  );

  let data;
  try {
    data = JSON.parse(raw.body);
  } catch (_) {
    throw new Error(
      `Anthropic API returned non-JSON (status ${raw.status}): ${raw.body.slice(0, 120)}`
    );
  }

  if (data.error) throw new Error(`Anthropic API: ${data.error.message}`);

  const content = data.content || [];
  const textBlocks    = content.filter((b) => b.type === 'text');
  const toolUseBlocks = content.filter((b) => b.type === 'tool_use');

  return {
    text:       textBlocks.map((b) => b.text).join('\n'),
    toolCalls:  toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
    rawContent: content,
    stopReason: data.stop_reason ?? null,
    usage:      data.usage ?? null
  };
}

// ── Internal: OpenAI ───────────────────────────────────────────────────────

async function _openaiTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : [...messages];

  const body = {
    model,
    max_tokens: maxTokens,
    messages: msgs,
    ...(tools.length ? { tools: tools.map(toOpenAiTool), tool_choice: 'auto' } : {})
  };

  const raw = await httpsPost(
    'api.openai.com',
    '/v1/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body,
    timeoutMs
  );

  let data;
  try {
    data = JSON.parse(raw.body);
  } catch (_) {
    throw new Error(
      `OpenAI API returned non-JSON (status ${raw.status}): ${raw.body.slice(0, 120)}`
    );
  }

  if (data.error) throw new Error(`OpenAI API: ${data.error.message}`);

  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    input: (() => {
      try { return JSON.parse(tc.function?.arguments || '{}'); } catch (_) { return {}; }
    })()
  }));

  return {
    text:       msg.content || '',
    toolCalls,
    rawContent: msg,
    stopReason: data.choices?.[0]?.finish_reason ?? null,
    usage:      data.usage ?? null
  };
}

// ── Internal: Google Gemini (OpenAI-compatible endpoint) ──────────────────

async function _geminiTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  // Gemini exposes an OpenAI-compatible endpoint — same JSON shape, different host + auth
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : [...messages];

  const body = {
    model,
    max_tokens: maxTokens,
    messages: msgs,
    ...(tools.length ? { tools: tools.map(toOpenAiTool), tool_choice: 'auto' } : {})
  };

  const raw = await httpsPost(
    'generativelanguage.googleapis.com',
    '/v1beta/openai/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body,
    timeoutMs
  );

  let data;
  try {
    data = JSON.parse(raw.body);
  } catch (_) {
    throw new Error(
      `Gemini API returned non-JSON (status ${raw.status}): ${raw.body.slice(0, 120)}`
    );
  }

  if (data.error) throw new Error(`Gemini API: ${data.error.message || JSON.stringify(data.error)}`);

  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    input: (() => {
      try { return JSON.parse(tc.function?.arguments || '{}'); } catch (_) { return {}; }
    })()
  }));

  return {
    text:       msg.content || '',
    toolCalls,
    rawContent: msg,
    stopReason: data.choices?.[0]?.finish_reason ?? null,
    usage:      data.usage ?? null
  };
}

// ── Internal: DeepSeek (OpenAI-compatible) ────────────────────────────────

async function _deepseekTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : [...messages];

  const body = {
    model,
    max_tokens: maxTokens,
    messages: msgs,
    ...(tools.length ? { tools: tools.map(toOpenAiTool), tool_choice: 'auto' } : {})
  };

  const raw = await httpsPost(
    'api.deepseek.com',
    '/v1/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body,
    timeoutMs
  );

  let data;
  try {
    data = JSON.parse(raw.body);
  } catch (_) {
    throw new Error(
      `DeepSeek API returned non-JSON (status ${raw.status}): ${raw.body.slice(0, 120)}`
    );
  }

  if (data.error) throw new Error(`DeepSeek API: ${data.error.message || JSON.stringify(data.error)}`);

  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    input: (() => {
      try { return JSON.parse(tc.function?.arguments || '{}'); } catch (_) { return {}; }
    })()
  }));

  return {
    text:       msg.content || '',
    toolCalls,
    rawContent: msg,
    stopReason: data.choices?.[0]?.finish_reason ?? null,
    usage:      data.usage ?? null
  };
}

// ── Model config resolver ──────────────────────────────────────────────────

/**
 * Hardcoded default models per role.
 * Callers that need a different default should pass it in config.models[role].
 */
const ROLE_DEFAULTS = {
  generation: 'claude-sonnet-4-6',
  eval:       'claude-sonnet-4-6',
  verifier:   'claude-sonnet-4-6',
  secondary:  null
};

/**
 * Detect provider from model name.
 *
 * @param {string} model
 * @returns {'anthropic'|'openai'|'google'|'deepseek'}
 */
export function detectProvider(model) {
  if (!model) return 'anthropic';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o4')
  ) return 'openai';
  // Fallback: assume anthropic for unknown model names
  return 'anthropic';
}

/**
 * Resolve the API key for a given provider from environment variables.
 *
 * @param {string} provider
 * @param {object} env — process.env or equivalent
 * @returns {string|null}
 */
export function resolveApiKey(provider, env) {
  switch (provider) {
    case 'anthropic': return env?.ANTHROPIC_API_KEY ?? null;
    case 'openai':    return env?.OPENAI_API_KEY ?? null;
    case 'google':    return env?.GOOGLE_API_KEY ?? env?.GEMINI_API_KEY ?? null;
    case 'deepseek':  return env?.DEEPSEEK_API_KEY ?? null;
    default:          return env?.ANTHROPIC_API_KEY ?? null;
  }
}

/**
 * Resolve provider, model, and API key from forge config + environment variables.
 *
 * Priority for model:
 *   1. config.models?.[role]
 *   2. config.model
 *   3. Hardcoded default for the role
 *
 * Priority for API key (by provider):
 *   anthropic → ANTHROPIC_API_KEY
 *   openai    → OPENAI_API_KEY
 *   google    → GOOGLE_API_KEY or GEMINI_API_KEY
 *   deepseek  → DEEPSEEK_API_KEY
 *   Returns null apiKey if key is not present (callers must check).
 *
 * @param {object}      config  - Forge config object (may be null/undefined)
 * @param {object}      env     - Key/value env object (e.g. from process.env or loadEnv())
 * @param {string}      [role]  - 'generation' | 'eval' | 'verifier' | 'secondary'
 * @returns {{ provider: 'anthropic'|'openai'|'google'|'deepseek', apiKey: string|null, model: string|null }}
 */
export function resolveModelConfig(config, env, role = 'generation') {
  const model =
    config?.models?.[role] ??
    config?.model ??
    ROLE_DEFAULTS[role] ??
    null;

  const provider = detectProvider(model);
  const apiKey = resolveApiKey(provider, env);

  return { provider, apiKey, model };
}

/**
 * Build a modelConfig object for a specific model string, resolving provider + key from env.
 * Convenience wrapper used by the model matrix runner.
 *
 * @param {string} modelName
 * @param {object} env
 * @returns {{ provider: string, apiKey: string|null, model: string }}
 */
export function modelConfigForName(modelName, env) {
  if (!modelName) throw new Error('modelConfigForName: modelName is required');
  const provider = detectProvider(modelName);
  const apiKey = resolveApiKey(provider, env);
  return { provider, apiKey, model: modelName };
}

// ── Streaming Transport ───────────────────────────────────────────────────

/**
 * Perform an HTTPS POST request that resolves with the raw IncomingMessage stream
 * instead of buffering. On non-2xx, buffers the error body and throws.
 *
 * @param {string} hostname
 * @param {string} path
 * @param {object} headers
 * @param {object} body
 * @param {number} [timeoutMs=120000]
 * @returns {Promise<import('http').IncomingMessage>}
 */
export function httpsPostStream(hostname, path, headers, body, timeoutMs = 120_000) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname,
        path,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) }
      },
      (resp) => {
        resp.on('error', rej);
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          res(resp);
        } else {
          // Buffer error body and throw
          let data = '';
          resp.on('data', (d) => { data += d; });
          resp.on('end', () => rej(new Error(`HTTP ${resp.statusCode}: ${data.slice(0, 300)}`)));
        }
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('API stream timeout')));
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

// ── SSE Frame Parser ──────────────────────────────────────────────────────

/**
 * Shared async generator that splits an IncomingMessage into SSE frames.
 * Yields { event: string|null, data: string }.
 *
 * @param {import('http').IncomingMessage} stream
 * @yields {{ event: string|null, data: string }}
 */
export async function* parseSSEFrames(stream) {
  let buffer = '';
  let currentEvent = null;
  let dataLines = [];

  for await (const chunk of stream) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line === '') {
        // Frame separator — emit if we have data
        if (dataLines.length > 0) {
          yield { event: currentEvent, data: dataLines.join('\n') };
        }
        currentEvent = null;
        dataLines = [];
      }
    }
  }
  // Flush any remaining frame
  if (dataLines.length > 0) {
    yield { event: currentEvent, data: dataLines.join('\n') };
  }
}

// ── Anthropic Stream Parser ───────────────────────────────────────────────

/**
 * Parse an Anthropic SSE stream. Yields text_delta events and a final done event.
 *
 * @param {import('http').IncomingMessage} stream
 * @yields {{ type: 'text_delta', text: string } | { type: 'done', text: string, toolCalls: Array, usage: object, stopReason: string|null }}
 */
export async function* parseAnthropicStream(stream) {
  let textBlocks = [];
  let currentTextIndex = -1;
  const toolCallBlocks = []; // { id, name, inputFragments: [] }
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  for await (const frame of parseSSEFrames(stream)) {
    if (frame.data === '[DONE]') break;

    let parsed;
    try { parsed = JSON.parse(frame.data); } catch { continue; }

    const eventType = frame.event || parsed.type;

    if (eventType === 'message_start' && parsed.message?.usage) {
      usage.input_tokens = parsed.message.usage.input_tokens || 0;
    }

    if (eventType === 'content_block_start') {
      const block = parsed.content_block;
      if (block?.type === 'text') {
        currentTextIndex = textBlocks.length;
        textBlocks.push('');
      } else if (block?.type === 'tool_use') {
        toolCallBlocks.push({ id: block.id, name: block.name, inputFragments: [] });
      }
    }

    if (eventType === 'content_block_delta') {
      const delta = parsed.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        if (currentTextIndex >= 0) textBlocks[currentTextIndex] += delta.text;
        yield { type: 'text_delta', text: delta.text };
      } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
        const lastTool = toolCallBlocks[toolCallBlocks.length - 1];
        if (lastTool) lastTool.inputFragments.push(delta.partial_json);
      }
    }

    if (eventType === 'content_block_stop') {
      // Reset current text index so subsequent text blocks start fresh
      currentTextIndex = -1;
    }

    if (eventType === 'message_delta') {
      if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
      if (parsed.usage?.output_tokens) usage.output_tokens = parsed.usage.output_tokens;
    }

    if (eventType === 'message_stop') {
      break;
    }
  }

  const fullText = textBlocks.join('\n');
  const toolCalls = toolCallBlocks.map(tc => {
    let input = {};
    if (tc.inputFragments.length > 0) {
      try { input = JSON.parse(tc.inputFragments.join('')); } catch { /* malformed */ }
    }
    return { id: tc.id, name: tc.name, input };
  });

  yield { type: 'done', text: fullText, toolCalls, usage, stopReason };
}

// ── OpenAI-Compatible Stream Parser ───────────────────────────────────────

/**
 * Parse an OpenAI-compatible SSE stream (OpenAI, Gemini, DeepSeek).
 * Yields text_delta events and a final done event.
 *
 * @param {import('http').IncomingMessage} stream
 * @param {string} providerName — for error messages
 * @yields {{ type: 'text_delta', text: string } | { type: 'done', text: string, toolCalls: Array, usage: object|null, stopReason: string|null }}
 */
export async function* parseOpenAICompatStream(stream, providerName) {
  let fullText = '';
  const toolCallBuffers = {}; // keyed by index
  let stopReason = null;
  let usage = null;

  for await (const frame of parseSSEFrames(stream)) {
    if (frame.data.trim() === '[DONE]') break;

    let parsed;
    try { parsed = JSON.parse(frame.data); } catch { continue; }

    // Usage (OpenAI sends in final chunk)
    if (parsed.usage) usage = parsed.usage;

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason) stopReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) continue;

    // Text content
    if (delta.content) {
      fullText += delta.content;
      yield { type: 'text_delta', text: delta.content };
    }

    // Tool calls — streamed incrementally by index
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallBuffers[idx]) {
          toolCallBuffers[idx] = { id: tc.id || '', name: tc.function?.name || '', argFragments: [] };
        }
        if (tc.id) toolCallBuffers[idx].id = tc.id;
        if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name;
        if (tc.function?.arguments) toolCallBuffers[idx].argFragments.push(tc.function.arguments);
      }
    }
  }

  const toolCalls = Object.values(toolCallBuffers).map(tc => {
    let input = {};
    if (tc.argFragments.length > 0) {
      try { input = JSON.parse(tc.argFragments.join('')); } catch { /* malformed */ }
    }
    return { id: tc.id, name: tc.name, input };
  });

  yield { type: 'done', text: fullText, toolCalls, usage, stopReason };
}

// ── Provider Stream Turn Functions ────────────────────────────────────────

async function* _anthropicStreamTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs }) {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    ...(system ? { system } : {}),
    messages,
    ...(tools.length ? { tools: tools.map(toAnthropicTool) } : {})
  };

  const stream = await httpsPostStream(
    'api.anthropic.com',
    '/v1/messages',
    {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey
    },
    body,
    timeoutMs
  );

  yield* parseAnthropicStream(stream);
}

async function* _openaiCompatStreamTurn(hostname, path, headers, { model, system, messages, tools, maxTokens, timeoutMs }) {
  const msgs = system
    ? [{ role: 'system', content: system }, ...messages]
    : [...messages];

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    messages: msgs,
    ...(tools.length ? { tools: tools.map(toOpenAiTool), tool_choice: 'auto' } : {})
  };

  const stream = await httpsPostStream(hostname, path, headers, body, timeoutMs);
  yield* parseOpenAICompatStream(stream, 'openai-compat');
}

async function* _openaiStreamTurn(opts) {
  yield* _openaiCompatStreamTurn(
    'api.openai.com',
    '/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    opts
  );
}

async function* _geminiStreamTurn(opts) {
  yield* _openaiCompatStreamTurn(
    'generativelanguage.googleapis.com',
    '/v1beta/openai/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    opts
  );
}

async function* _deepseekStreamTurn(opts) {
  yield* _openaiCompatStreamTurn(
    'api.deepseek.com',
    '/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    opts
  );
}

// ── Unified Streaming LLM Turn ────────────────────────────────────────────

/**
 * Perform a single streaming LLM turn. Async generator that yields
 * { type: 'text_delta', text } during the stream, and
 * { type: 'done', text, toolCalls, usage, stopReason } at end.
 *
 * Same opts as llmTurn.
 *
 * @param {object} opts
 * @yields {{ type: 'text_delta', text: string } | { type: 'done', text: string, toolCalls: Array, usage: object, stopReason: string|null }}
 */
export async function* llmTurnStreaming({
  provider,
  apiKey,
  model,
  system,
  messages,
  tools = [],
  maxTokens = 4096,
  timeoutMs = 120_000
}) {
  if (provider === 'anthropic') {
    yield* _anthropicStreamTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
    return;
  }
  if (provider === 'openai') {
    yield* _openaiStreamTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
    return;
  }
  if (provider === 'google') {
    yield* _geminiStreamTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
    return;
  }
  if (provider === 'deepseek') {
    yield* _deepseekStreamTurn({ apiKey, model, system, messages, tools, maxTokens, timeoutMs });
    return;
  }
  throw new Error(`llmTurnStreaming: unknown provider "${provider}". Expected 'anthropic', 'openai', 'google', or 'deepseek'.`);
}
