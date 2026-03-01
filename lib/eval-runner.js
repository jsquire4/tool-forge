/**
 * Standalone Eval Runner — no forge service required.
 *
 * Reads eval JSON files for a tool, calls Anthropic or OpenAI directly,
 * checks routing + content assertions, and stores results in SQLite.
 *
 * Modes:
 *   "routing-only" — single LLM turn; verifies which tools the model selects.
 *   "stub-based"   — multi-turn loop with stubbed tool results; activated when
 *                    the eval case includes a `stubs` field. Validates both
 *                    routing and final response content.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { llmTurn, normalizeUsage, modelConfigForName } from './api-client.js';
import { checkAdapter, checkResponseContainsAnyGroups, checkToolsAcceptable } from './checks/check-adapter.js';
import { runChecks } from './checks/run-checks.js';
import { computeActualCost } from './runner/cost-estimator.js';

// ── Stub-based multi-turn executor ─────────────────────────────────────────

/**
 * Run a multi-turn LLM conversation with stubbed tool results.
 *
 * When the model emits tool_use calls, each tool is answered with its
 * corresponding stub from the `stubs` map instead of running real tool code.
 * The loop continues until the model produces a text-only response or maxTurns
 * is reached.
 *
 * @param {object} opts
 * @param {string} opts.provider      - 'anthropic' | 'openai' (or compat)
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {object[]} opts.tools       - tool definitions with inputSchema
 * @param {string} opts.input         - user message
 * @param {object} opts.stubs         - { [toolName]: stubReturnObject }
 * @param {number} [opts.maxTurns=5]  - safety cap on loop iterations
 * @returns {{ toolsCalled: string[], responseText: string, usage: object|null, missingStubs: string[] }}
 */
export async function stubbedReactTurn({ provider, apiKey, model, systemPrompt, tools, input, stubs, maxTurns = 5 }) {
  const messages = [{ role: 'user', content: input }];
  const allToolsCalled = [];
  const missingStubs = [];
  let finalText = '';
  // M2: accumulate token counts across all turns instead of keeping only the last
  let accInputTokens = 0;
  let accOutputTokens = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llmTurn({
      provider, apiKey, model,
      system: systemPrompt,
      messages, tools,
      maxTokens: 1024,
      timeoutMs: 30_000
    });

    if (response.usage) {
      const n = normalizeUsage(response.usage, provider);
      accInputTokens += n.inputTokens;
      accOutputTokens += n.outputTokens;
    }
    if (response.text) finalText = response.text;
    if (!response.toolCalls?.length) break;

    const toolResults = [];
    for (const tc of response.toolCalls) {
      allToolsCalled.push(tc.name);
      const stubData = stubs[tc.name];
      if (stubData === undefined) missingStubs.push(tc.name);
      toolResults.push({
        toolCall: tc,
        result: { status: 200, body: stubData ?? { error: `no stub for "${tc.name}"` } }
      });
    }

    // Append provider-specific history (mirrors react-engine.js format)
    if (provider === 'anthropic') {
      messages.push({
        role: 'assistant',
        content: [
          ...(response.text ? [{ type: 'text', text: response.text }] : []),
          ...toolResults.map(({ toolCall }) => ({
            type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input
          }))
        ]
      });
      messages.push({
        role: 'user',
        content: toolResults.map(({ toolCall, result }) => ({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result.body)
        }))
      });
    } else {
      // L1: use '' instead of null — some OpenAI-compat providers reject content: null
      messages.push({
        role: 'assistant',
        content: response.text || '',
        tool_calls: toolResults.map(({ toolCall }) => ({
          id: toolCall.id, type: 'function',
          function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) }
        }))
      });
      for (const { toolCall, result } of toolResults) {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result.body) });
      }
    }
  }

  // Return accumulated normalized token counts so callers skip a second normalizeUsage call
  return {
    toolsCalled: allToolsCalled,
    responseText: finalText,
    usage: { inputTokens: accInputTokens, outputTokens: accOutputTokens },
    missingStubs
  };
}

// ── Assertion checker ──────────────────────────────────────────────────────

/**
 * Check assertions from an eval case against actual API response.
 * Returns array of failure strings (empty = pass).
 * Uses runChecks() from lib/checks/ for structured evaluation.
 */
function checkAssertions(evalCase, { toolsCalled, responseText, latencyMs, cost, missingStubs = [] }) {
  const failures = [];

  // Run structured checks via check-adapter + runChecks
  const input = checkAdapter(evalCase, { toolsCalled, responseText, latencyMs, cost });
  const result = runChecks(input);
  for (const [checkName, checkResult] of Object.entries(result.checks)) {
    if (!checkResult.pass) {
      failures.push(checkResult.reason ?? `${checkName} failed`);
    }
  }

  // responseContainsAny — anyOf groups (not natively in runChecks)
  const expect = evalCase.expect ?? {};
  if (expect.responseContainsAny?.length) {
    const anyResult = checkResponseContainsAnyGroups(responseText, expect.responseContainsAny);
    if (!anyResult.pass) failures.push(anyResult.reason);
  }

  // toolsAcceptable — acceptable alternative tool sets
  if (expect.toolsAcceptable !== undefined) {
    const acceptResult = checkToolsAcceptable(toolsCalled, expect.toolsAcceptable);
    if (!acceptResult.pass) failures.push(acceptResult.reason);
  }

  // noToolErrors — in stub mode: fails if any tool was called without a stub entry.
  // In routing-only mode (no stubs): this assertion is a no-op because tools are
  // never executed, so success/failure cannot be determined. Set `stubs` on the
  // eval case to make this assertion meaningful.
  if (expect.noToolErrors && missingStubs.length > 0) {
    failures.push(`noToolErrors: tools called without stubs: [${missingStubs.join(', ')}]`);
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
 * Load tools from the tools directory, returning objects with inputSchema.
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
    return { name, description, inputSchema: forgeSchemaToJsonSchema(rawSchema) };
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

  // Determine provider + key.
  // If config.model is explicitly set, detect its provider and resolve the matching key.
  // Otherwise fall back to whichever key is available (Anthropic preferred).
  let provider, model, apiKey;
  if (config?.model) {
    const mc = modelConfigForName(config.model, env);
    provider = mc.provider;
    model    = mc.model;
    apiKey   = mc.apiKey;
    if (!apiKey) {
      throw new Error(`No API key found for provider "${provider}" (model: ${model}). Add the key to .env in Settings.`);
    }
  } else {
    const anthropicKey = env['ANTHROPIC_API_KEY'];
    const openaiKey    = env['OPENAI_API_KEY'];
    if (!anthropicKey && !openaiKey) {
      throw new Error('No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env in Settings.');
    }
    const useAnthropic = !!anthropicKey;
    provider = useAnthropic ? 'anthropic' : 'openai';
    model    = useAnthropic ? 'claude-sonnet-4-6' : 'gpt-4o-mini';
    apiKey   = useAnthropic ? anthropicKey : openaiKey;
  }

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

  const results = [];
  const caseRows = [];
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
      caseRows.push({ case_id: evalCase.id, tool_name: toolName, status: 'skipped', reason: 'no input message', tools_called: null, latency_ms: null, model });
      continue;
    }

    let apiResult;
    let stubbedResult;
    let inputTokens = 0;
    let outputTokens = 0;
    const t0 = Date.now();
    // C1: require at least one stub key — empty object {} stays routing-only
    const hasStubs = evalCase.stubs && typeof evalCase.stubs === 'object' && Object.keys(evalCase.stubs).length > 0;
    try {
      if (hasStubs) {
        stubbedResult = await stubbedReactTurn({
          provider, apiKey, model, systemPrompt, tools,
          input,
          stubs: evalCase.stubs,
          maxTurns: evalCase.maxTurns ?? 5
        });
        apiResult = { toolsCalled: stubbedResult.toolsCalled, responseText: stubbedResult.responseText };
        // M2: stubbedReactTurn returns pre-accumulated normalized tokens; use directly
        inputTokens = stubbedResult.usage.inputTokens;
        outputTokens = stubbedResult.usage.outputTokens;
      } else {
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
        ({ inputTokens, outputTokens } = normalizeUsage(turnResult.usage ?? null, provider));
      }
    } catch (err) {
      failed++;
      const reason = `API error: ${err.message}`;
      onProgress?.({ done: i + 1, total: allCases.length, caseId: evalCase.id, passed: false, reason });
      results.push({ id: evalCase.id, description: evalCase.description, status: 'failed', reason });
      caseRows.push({ case_id: evalCase.id, tool_name: toolName, status: 'failed', reason, tools_called: null, latency_ms: Date.now() - t0, model, input_tokens: null, output_tokens: null });
      continue;
    }

    const latency_ms = Date.now() - t0;
    // M3: compute actual cost from observed token counts
    const cost = computeActualCost(inputTokens, outputTokens, model);
    const failures = checkAssertions(evalCase, {
      toolsCalled: apiResult.toolsCalled,
      responseText: apiResult.responseText,
      latencyMs: latency_ms,
      cost,
      missingStubs: stubbedResult?.missingStubs ?? []
    });
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
    caseRows.push({
      case_id: evalCase.id,
      tool_name: toolName,
      status: casePassed ? 'passed' : 'failed',
      reason,
      tools_called: JSON.stringify(apiResult.toolsCalled),
      latency_ms,
      model,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null
    });
  }

  // Persist to SQLite
  try {
    const dbPath = resolve(projectRoot, config?.dbPath || 'forge.db');
    const { getDb, insertEvalRun, insertEvalRunCases } = await import('./db.js');
    const db = getDb(dbPath);
    const evalType = allCases.every((c) => c._evalType === 'golden') ? 'golden'
      : allCases.every((c) => c._evalType === 'labeled') ? 'labeled'
      : 'mixed';
    const passRate = allCases.length > 0 ? passed / allCases.length : 0;
    const evalRunId = insertEvalRun(db, {
      tool_name: toolName,
      eval_type: evalType,
      total_cases: allCases.length,
      passed,
      failed,
      skipped,
      notes: `provider:${provider} model:${model}`,
      model,
      pass_rate: passRate,
      sample_type: 'targeted'
    });
    if (caseRows.length > 0) {
      insertEvalRunCases(db, caseRows.map((r) => ({ ...r, eval_run_id: evalRunId })));
    }
  } catch (_) { /* db write failure is non-fatal */ }

  return { total: allCases.length, passed, failed, skipped, cases: results, provider, model };
}

// ── Multi-pass eval runner ────────────────────────────────────────────────

/**
 * Run evals across a model matrix, collecting per-model results.
 * Model matrix is resolved from config.modelMatrix (list of model name strings).
 * Each model's provider + API key is resolved automatically via modelConfigForName.
 *
 * @param {string} toolName
 * @param {object} config  - full forge config (must include dbPath for env resolution)
 * @param {string} projectRoot
 * @param {{ modelMatrix?: string[] }} [options]  - override matrix; defaults to config.modelMatrix
 * @param {function} [onProgress]  - called with { model, done, total, caseId, passed }
 * @returns {Promise<{ perModel: Record<string, { passed, failed, total, pass_rate }> }>}
 */
export async function runEvalsMultiPass(toolName, config, projectRoot, options = {}, onProgress) {
  // Resolve env for API key lookup
  const env = loadEnv(projectRoot);

  const matrixNames = options.modelMatrix || config?.modelMatrix || [];
  if (matrixNames.length === 0) {
    throw new Error('No model matrix configured. Add "modelMatrix" to forge.config.json.');
  }

  const perModel = {};

  for (const modelName of matrixNames) {
    const mc = modelConfigForName(modelName, env);
    if (!mc.apiKey) {
      perModel[modelName] = { error: `No API key found for provider "${mc.provider}"` };
      continue;
    }

    // Build a config override for this model
    const modelConfig = { ...config, model: modelName, models: { ...config?.models, eval: modelName } };

    try {
      const result = await runEvals(
        toolName,
        modelConfig,
        projectRoot,
        (progress) => onProgress?.({ model: modelName, ...progress })
      );
      perModel[modelName] = {
        passed: result.passed,
        failed: result.failed,
        total: result.total,
        skipped: result.skipped,
        pass_rate: result.total > 0 ? result.passed / result.total : 0,
        provider: result.provider
      };
    } catch (err) {
      perModel[modelName] = { error: err.message };
    }
  }

  return { perModel };
}

// ── Random sample helper ──────────────────────────────────────────────────

/**
 * Pull n random eval run cases from OTHER tools for blind drift detection.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName - The tool to EXCLUDE from sampling
 * @param {number} n
 * @returns {object[]} eval case rows with _sampleType: 'sampled'
 */
export function withRandomSample(db, toolName, n) {
  try {
    const rows = db.prepare(`
      SELECT * FROM eval_run_cases
      WHERE tool_name != ?
      ORDER BY RANDOM()
      LIMIT ?
    `).all(toolName, n);
    return rows.map((r) => ({ ...r, _sampleType: 'sampled' }));
  } catch (_) {
    return [];
  }
}
