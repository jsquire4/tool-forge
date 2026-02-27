/**
 * Standalone Eval Runner — no forge service required.
 *
 * Reads eval JSON files for a tool, calls Anthropic or OpenAI directly,
 * checks routing + content assertions, and stores results in SQLite.
 *
 * Mode: "routing-only" — verifies which tools the model selects.
 * Full tool execution (noToolErrors, responseContains after execution) is
 * out of scope unless the tool returns deterministic stub data.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { request as httpsRequest } from 'https';

// ── API helpers ────────────────────────────────────────────────────────────

function httpsPost(hostname, path, headers, body, timeoutMs = 30_000) {
  return new Promise((res, rej) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } },
      (resp) => {
        let data = '';
        resp.on('data', (d) => { data += d; });
        resp.on('end', () => res({ status: resp.statusCode, body: data }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('API timeout')); });
    req.on('error', rej);
    req.write(payload);
    req.end();
  });
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.jsonSchema || { type: 'object', properties: {}, required: [] }
  };
}

function toOpenAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.jsonSchema || { type: 'object', properties: {} }
    }
  };
}

async function callAnthropic(apiKey, model, systemPrompt, userMessage, tools) {
  const body = {
    model: model || 'claude-sonnet-4-6',
    max_tokens: 1024,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: userMessage }],
    tools: tools.map(toAnthropicTool)
  };
  const result = await httpsPost('api.anthropic.com', '/v1/messages', {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': apiKey
  }, body);

  const data = JSON.parse(result.body);
  if (data.error) throw new Error(`Anthropic API: ${data.error.message}`);
  const toolsCalled = (data.content || []).filter((b) => b.type === 'tool_use').map((b) => b.name);
  const responseText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { toolsCalled, responseText };
}

async function callOpenAI(apiKey, model, systemPrompt, userMessage, tools) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });

  const body = {
    model: model || 'gpt-4o-mini',
    messages,
    tools: tools.map(toOpenAiTool),
    tool_choice: 'auto'
  };
  const result = await httpsPost('api.openai.com', '/v1/chat/completions', {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  }, body);

  const data = JSON.parse(result.body);
  if (data.error) throw new Error(`OpenAI API: ${data.error.message}`);
  const message = data.choices?.[0]?.message || {};
  const toolsCalled = (message.tool_calls || []).map((tc) => tc.function?.name).filter(Boolean);
  const responseText = message.content || '';
  return { toolsCalled, responseText };
}

// ── Assertion checker ──────────────────────────────────────────────────────

function setsEqual(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/**
 * Check assertions from an eval case against actual API response.
 * Returns array of failure strings (empty = pass).
 */
function checkAssertions(evalCase, { toolsCalled, responseText }) {
  const expect = evalCase.expect || {};
  const failures = [];

  // ── Routing assertions ──────────────────────────────────────────────────

  if (expect.toolsCalled !== undefined) {
    if (!setsEqual(expect.toolsCalled, toolsCalled)) {
      failures.push(
        `tools: expected [${expect.toolsCalled.join(', ')}] got [${toolsCalled.join(', ')}]`
      );
    }
  }

  if (expect.toolsAcceptable !== undefined) {
    const anyMatch = expect.toolsAcceptable.some((acceptable) => {
      if (acceptable.includes('__none__') && toolsCalled.length === 0) return true;
      return setsEqual(acceptable, toolsCalled);
    });
    if (!anyMatch) {
      failures.push(`tools: [${toolsCalled.join(', ')}] not in any acceptable set`);
    }
  }

  // ── Response content assertions ─────────────────────────────────────────
  // Only checked against the model's preamble text (before tool calls).
  // If the model only returned tool_use blocks and no text, these are skipped.

  const checkText = responseText.length > 0;

  if (expect.responseNonEmpty) {
    if (!checkText && toolsCalled.length === 0) {
      failures.push('expected non-empty response (no text, no tool calls)');
    }
  }

  if (checkText) {
    if (expect.responseContains) {
      for (const str of expect.responseContains) {
        if (!responseText.includes(str)) {
          failures.push(`response should contain "${str}"`);
        }
      }
    }

    if (expect.responseContainsAny) {
      for (const group of expect.responseContainsAny) {
        if (!group.some((str) => responseText.includes(str))) {
          failures.push(`response should contain any of [${group.join(', ')}]`);
        }
      }
    }

    if (expect.responseNotContains) {
      for (const str of expect.responseNotContains) {
        if (responseText.includes(str)) {
          failures.push(`response should NOT contain "${str}"`);
        }
      }
    }
  }

  return failures;
}

// ── Tool schema extraction ─────────────────────────────────────────────────

/**
 * Convert forge tool schema format to JSON Schema.
 * Input: { city: { type: 'string' }, units: { type: 'string', optional: true } }
 * Output: { type: 'object', properties: { city: {...}, units: {...} }, required: ['city'] }
 */
function forgeSchemaToJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const properties = {};
  const required = [];
  for (const [key, val] of Object.entries(schema)) {
    properties[key] = { type: val.type || 'string' };
    if (val.description) properties[key].description = val.description;
    if (!val.optional) required.push(key);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * Extract schema object from tool file source using a basic brace-matcher.
 * Returns null if not parseable.
 */
function extractSchemaFromSource(source) {
  const schemaMatch = source.match(/schema:\s*\{/);
  if (!schemaMatch) return null;

  const start = source.indexOf('{', schemaMatch.index + schemaMatch[0].length - 1);
  let depth = 0;
  let end = start;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }

  const block = source.slice(start, end + 1);
  // Convert JS object literal to evaluable form (very limited — handles simple cases)
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return ${block}`);
    return fn();
  } catch (_) {
    return null;
  }
}

/**
 * Load tools from the tools directory, returning objects with jsonSchema.
 */
export function getToolsForEval(config) {
  const project = config?.project || {};
  const toolsDir = resolve(process.cwd(), project.toolsDir || 'example/tools');
  if (!existsSync(toolsDir)) return [];

  const files = readdirSync(toolsDir).filter(
    (f) => f.endsWith('.tool.ts') || f.endsWith('.tool.js')
  );

  return files.map((file) => {
    const source = readFileSync(join(toolsDir, file), 'utf-8');
    const nameM = source.match(/name:\s*['"]([^'"]+)['"]/);
    const descM = source.match(/description:\s*['"`]([^'"`]+)['"`]/);
    const name = nameM?.[1] ?? file.replace(/\.tool\.(ts|js)$/, '');
    const description = descM?.[1] ?? '';
    const rawSchema = extractSchemaFromSource(source);
    return { name, description, jsonSchema: forgeSchemaToJsonSchema(rawSchema) };
  });
}

// ── Eval file discovery ────────────────────────────────────────────────────

/**
 * Find eval files for a tool. Searches evalsDir (and project root) for
 * patterns: {toolName}.golden.json, {toolName}.labeled.json
 */
export function findEvalFiles(toolName, config) {
  const project = config?.project || {};
  const evalsDir = resolve(process.cwd(), project.evalsDir || 'docs/examples');

  const candidates = [
    join(evalsDir, `${toolName}.golden.json`),
    join(evalsDir, `${toolName}.labeled.json`),
    // Also check one level up if toolName matches a subdirectory
    join(evalsDir, toolName, `${toolName}.golden.json`),
    join(evalsDir, toolName, `${toolName}.labeled.json`),
    // With hyphens
    join(evalsDir, `${toolName.replace(/_/g, '-')}.golden.json`),
    join(evalsDir, `${toolName.replace(/_/g, '-')}.labeled.json`)
  ];

  return candidates
    .filter(existsSync)
    .filter((v, i, a) => a.indexOf(v) === i); // dedup
}

// ── Env reader ─────────────────────────────────────────────────────────────

function loadEnv(projectRoot) {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    out[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── Main runner ────────────────────────────────────────────────────────────

/**
 * Run evals for a tool.
 *
 * @param {string} toolName
 * @param {object} config  - full forge config
 * @param {string} projectRoot
 * @param {function} onProgress - called after each case: ({ done, total, caseId, passed, reason })
 * @returns {{ total, passed, failed, skipped, cases, provider, model }}
 */
export async function runEvals(toolName, config, projectRoot, onProgress) {
  const env = loadEnv(projectRoot);

  // Determine provider + key
  const anthropicKey = env['ANTHROPIC_API_KEY'];
  const openaiKey    = env['OPENAI_API_KEY'];

  if (!anthropicKey && !openaiKey) {
    throw new Error('No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env in Settings.');
  }

  const useAnthropic = !!anthropicKey;
  const provider = useAnthropic ? 'anthropic' : 'openai';
  const model = config?.model || (useAnthropic ? 'claude-sonnet-4-6' : 'gpt-4o-mini');

  // Load system prompt
  let systemPrompt = '';
  if (config?.systemPromptPath) {
    const spPath = resolve(projectRoot, config.systemPromptPath);
    if (existsSync(spPath)) {
      try { systemPrompt = readFileSync(spPath, 'utf-8'); } catch (_) { /* ignore */ }
    }
  }

  // Load tool definitions
  const tools = getToolsForEval(config);
  if (tools.length === 0) {
    throw new Error(`No tool files found in ${config?.project?.toolsDir || 'example/tools'}`);
  }

  // Find eval files
  const evalFiles = findEvalFiles(toolName, config);
  if (evalFiles.length === 0) {
    throw new Error(
      `No eval files found for "${toolName}". ` +
      `Expected files like ${toolName}.golden.json in ${config?.project?.evalsDir || 'docs/examples'}`
    );
  }

  // Load all eval cases
  const allCases = [];
  for (const file of evalFiles) {
    const type = file.includes('.golden.') ? 'golden' : 'labeled';
    const cases = JSON.parse(readFileSync(file, 'utf-8'));
    for (const c of cases) allCases.push({ ...c, _evalType: type });
  }

  const callApi = useAnthropic ? callAnthropic : callOpenAI;
  const apiKey  = useAnthropic ? anthropicKey : openaiKey;

  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < allCases.length; i++) {
    const evalCase = allCases[i];
    const input = evalCase.input?.message ?? '';

    if (!input) {
      skipped++;
      onProgress?.({ done: i + 1, total: allCases.length, caseId: evalCase.id, passed: null, reason: 'no input message' });
      results.push({ id: evalCase.id, description: evalCase.description, status: 'skipped', reason: 'no input message' });
      continue;
    }

    let apiResult;
    try {
      apiResult = await callApi(apiKey, model, systemPrompt, input, tools);
    } catch (err) {
      failed++;
      const reason = `API error: ${err.message}`;
      onProgress?.({ done: i + 1, total: allCases.length, caseId: evalCase.id, passed: false, reason });
      results.push({ id: evalCase.id, description: evalCase.description, status: 'failed', reason });
      continue;
    }

    const failures = checkAssertions(evalCase, apiResult);
    const casePassed = failures.length === 0;

    if (casePassed) passed++;
    else failed++;

    const reason = failures.length > 0 ? failures.join('; ') : null;
    onProgress?.({ done: i + 1, total: allCases.length, caseId: evalCase.id, passed: casePassed, reason, toolsCalled: apiResult.toolsCalled });
    results.push({
      id: evalCase.id,
      description: evalCase.description,
      difficulty: evalCase.difficulty,
      status: casePassed ? 'passed' : 'failed',
      reason,
      toolsCalled: apiResult.toolsCalled
    });
  }

  // Persist to SQLite
  try {
    const dbPath = resolve(projectRoot, config?.dbPath || 'forge.db');
    const { getDb, insertEvalRun } = await import('./db.js');
    const db = getDb(dbPath);
    const evalType = allCases.every((c) => c._evalType === 'golden') ? 'golden'
      : allCases.every((c) => c._evalType === 'labeled') ? 'labeled'
      : 'mixed';
    insertEvalRun(db, {
      tool_name: toolName,
      eval_type: evalType,
      total_cases: allCases.length,
      passed,
      failed,
      notes: `provider:${provider} model:${model}`
    });
  } catch (_) { /* db write failure is non-fatal */ }

  return { total: allCases.length, passed, failed, skipped, cases: results, provider, model };
}
