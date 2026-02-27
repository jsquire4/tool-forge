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
 * @param {{ name: string, description?: string, jsonSchema?: object }} t
 * @returns {{ name: string, description: string, input_schema: object }}
 */
export function toAnthropicTool(t) {
  return {
    name: t.name,
    description: t.description || '',
    input_schema: t.jsonSchema || { type: 'object', properties: {} }
  };
}

/**
 * Convert a forge-format tool to OpenAI tool format.
 *
 * @param {{ name: string, description?: string, jsonSchema?: object }} t
 * @returns {{ type: 'function', function: { name: string, description: string, parameters: object } }}
 */
export function toOpenAiTool(t) {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.jsonSchema || { type: 'object', properties: {} }
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
  throw new Error(`llmTurn: unknown provider "${provider}". Expected 'anthropic' or 'openai'.`);
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
    stopReason: msg.finish_reason ?? null,
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
 * @returns {'anthropic'|'openai'}
 */
function detectProvider(model) {
  if (!model) return 'anthropic';
  if (model.startsWith('claude-')) return 'anthropic';
  if (
    model.startsWith('gpt-') ||
    model.startsWith('o1') ||
    model.startsWith('o3')
  ) return 'openai';
  // Fallback: assume anthropic for unknown model names
  return 'anthropic';
}

/**
 * Resolve provider, model, and API key from forge config + environment variables.
 *
 * Priority for model:
 *   1. config.models?.[role]
 *   2. config.model
 *   3. Hardcoded default for the role
 *
 * Priority for API key:
 *   - ANTHROPIC_API_KEY if provider is 'anthropic'
 *   - OPENAI_API_KEY if provider is 'openai'
 *   Returns null apiKey if neither is present (callers must check).
 *
 * @param {object}      config  - Forge config object (may be null/undefined)
 * @param {object}      env     - Key/value env object (e.g. from process.env or loadEnv())
 * @param {string}      [role]  - 'generation' | 'eval' | 'verifier' | 'secondary'
 * @returns {{ provider: 'anthropic'|'openai', apiKey: string|null, model: string|null }}
 */
export function resolveModelConfig(config, env, role = 'generation') {
  const model =
    config?.models?.[role] ??
    config?.model ??
    ROLE_DEFAULTS[role] ??
    null;

  const provider = detectProvider(model);

  const apiKey =
    provider === 'anthropic'
      ? (env?.ANTHROPIC_API_KEY ?? null)
      : (env?.OPENAI_API_KEY ?? null);

  return { provider, apiKey, model };
}
