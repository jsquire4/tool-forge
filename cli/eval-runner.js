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
import { llmTurn } from './api-client.js';

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
  // Text assertions are checked against the model's preamble text.
  // If requiresPreamble is true and the model returned only tool calls (no text),
  // text assertions fail. Otherwise they are skipped when no text is present.

  const requiresPreamble = evalCase.requiresPreamble === true;
  const checkText = responseText.length > 0;

  if (requiresPreamble && !checkText && toolsCalled.length > 0) {
    failures.push('requiresPreamble: model returned only tool calls, no preamble text');
  }

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
    let cases;
    try {
      cases = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse eval file ${file}: ${err.message}`);
    }
    for (const c of cases) allCases.push({ ...c, _evalType: type });
  }

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
      const turnResult = await llmTurn({
        provider,
        apiKey,
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: input }],
        tools,
        maxTokens: 1024,
        timeoutMs: 30_000
      });
      apiResult = {
        toolsCalled: turnResult.toolCalls.map((tc) => tc.name),
        responseText: turnResult.text
      };
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
      skipped,
      notes: `provider:${provider} model:${model}`
    });
  } catch (_) { /* db write failure is non-fatal */ }

  return { total: allCases.length, passed, failed, skipped, cases: results, provider, model };
}
