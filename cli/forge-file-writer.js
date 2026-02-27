/**
 * Forge File Writer — generates tool file content via LLM.
 * Does NOT write to disk — returns content strings for forge.js to preview and confirm.
 *
 * @module forge-file-writer
 */

import { llmTurn } from './api-client.js';

// ── JSON extraction ────────────────────────────────────────────────────────

/**
 * Extract a JSON object from raw LLM response text.
 * Tries ```json...``` fenced block first, then falls back to first `{` to
 * its matching closing `}`.
 *
 * @param {string} text - Raw LLM response text
 * @returns {object} Parsed JSON object
 * @throws {Error} If no valid JSON object can be found or parsed
 */
function extractJson(text) {
  // Strategy 1: ```json ... ``` fenced block
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1]);
  }

  // Strategy 2: first `{` to its matching `}`
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in LLM response');
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error('Unbalanced JSON object in LLM response');
}

/**
 * Validate that the parsed LLM output has the required shape.
 *
 * @param {unknown} obj
 * @returns {{ toolFile: string, testFile: string, barrelLine: string|undefined }}
 * @throws {Error} If required fields are missing or wrong type
 */
function validateLlmOutput(obj) {
  if (!obj || typeof obj !== 'object') {
    throw new Error('LLM response did not parse to an object');
  }
  if (typeof obj.toolFile !== 'string' || obj.toolFile.trim() === '') {
    throw new Error('LLM response missing required string field: toolFile');
  }
  if (typeof obj.testFile !== 'string' || obj.testFile.trim() === '') {
    throw new Error('LLM response missing required string field: testFile');
  }
  return {
    toolFile: obj.toolFile,
    testFile: obj.testFile,
    barrelLine: typeof obj.barrelLine === 'string' ? obj.barrelLine : undefined
  };
}

// ── Prompt builder ─────────────────────────────────────────────────────────

/**
 * Build the system prompt for the LLM code-generation request.
 *
 * @param {object} spec - Tool specification
 * @param {string[]} existingTools - Names of already-registered tools
 * @returns {string}
 */
function buildSystemPrompt(spec, existingTools) {
  const tagsStr        = spec.tags?.join(', ')          || '';
  const dependsOnStr   = spec.dependsOn?.join(', ')     || '';
  const triggersStr    = spec.triggerPhrases?.join(', ') || '';
  const schemaStr      = JSON.stringify(spec.schema ?? {}, null, 2);
  const existingStr    = existingTools.length
    ? existingTools.join(', ')
    : '(none)';

  return `You are generating a JavaScript tool file for an LLM agent tool-forge project. \
Generate production-ready code with NO TODOs or stubs, except for the single \
// EXTENSION POINT comment inside execute() where real API/business logic would go.

Tool spec:
- Name: ${spec.name}
- Description: ${spec.description}
- Category: ${spec.category}
- Consequence level: ${spec.consequenceLevel}
- Requires confirmation: ${spec.requiresConfirmation}
- Timeout: ${spec.timeout || 30000}
- Schema: ${schemaStr}
- Tags: ${tagsStr}
- Depends on: ${dependsOnStr}
- Trigger phrases: ${triggersStr}

Existing registered tools (for barrel import reference): ${existingStr}

--- TOOL FILE FORMAT ---
The file must be a JavaScript ESM module (.js) exporting a named const.
Follow this exact shape (adapt field values from the spec above):

/**
 * ${spec.name} — <one-line description>
 */

export const ${_camelName(spec.name)}Tool = {
  name: '${spec.name}',
  description: '<full description>',
  schema: <schema as JS object literal — not JSON>,
  category: '${spec.category}',
  consequenceLevel: '${spec.consequenceLevel}',
  requiresConfirmation: ${spec.requiresConfirmation},
  timeout: ${spec.timeout || 30000},
  version: '1.0.0',
  status: 'active',
  tags: ${JSON.stringify(spec.tags ?? [])},
  dependsOn: ${JSON.stringify(spec.dependsOn ?? [])},
  triggerPhrases: ${JSON.stringify(spec.triggerPhrases ?? [])},

  async execute(params, _context) {
    // EXTENSION POINT: implement actual logic here
    // params are validated against schema before this is called
    return {
      tool: '${spec.name}',
      fetchedAt: new Date().toISOString(),
      data: null
    };
  }
};

--- TEST FILE FORMAT ---
The test file must be a JavaScript ESM module using describe/it/expect (Jest or Vitest style).
It tests the exported tool object — NOT the execute() implementation.

import { ${_camelName(spec.name)}Tool } from '../${spec.name}.tool.js';

describe('${spec.name}', () => {
  it('has required fields', () => {
    expect(${_camelName(spec.name)}Tool.name).toBe('${spec.name}');
    expect(typeof ${_camelName(spec.name)}Tool.description).toBe('string');
    expect(typeof ${_camelName(spec.name)}Tool.execute).toBe('function');
  });
  it('schema matches spec', () => {
    // assert each expected schema key is present
  });
  it('execute returns expected shape', async () => {
    const result = await ${_camelName(spec.name)}Tool.execute({}, {});
    expect(result).toHaveProperty('tool', '${spec.name}');
    expect(result).toHaveProperty('fetchedAt');
  });
});

--- BARREL LINE FORMAT ---
The barrelLine must be a single ESM named re-export, e.g.:
export { ${_camelName(spec.name)}Tool } from './${spec.name}.tool.js';

--- RESPONSE FORMAT ---
Respond ONLY with a JSON object — no prose, no markdown outside the JSON itself.
Required keys:
  "toolFile"   — full file content as a string (the complete .tool.js file)
  "testFile"   — full test file content as a string (the complete .tool.test.js file)
  "barrelLine" — single export line to add to the barrel index (string)

Example response shape:
{
  "toolFile": "/** ... */\\nexport const myTool = { ... };",
  "testFile": "import { myTool } from '../my_tool.tool.js';\\ndescribe(...)",
  "barrelLine": "export { myTool } from './my_tool.tool.js';"
}`;
}

// ── Camel-case helper ──────────────────────────────────────────────────────

/**
 * Convert a snake_case tool name to camelCase for the exported const.
 * e.g. "get_weather" → "getWeather"
 *
 * @param {string} name
 * @returns {string}
 */
function _camelName(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate tool file content via LLM.
 *
 * Does NOT write to disk. Returns content strings and computed paths so the
 * caller (forge.js) can preview and confirm before writing.
 *
 * @param {object}   opts
 * @param {object}   opts.spec              - Tool specification
 * @param {string}   opts.spec.name         - Snake_case tool name
 * @param {string}   opts.spec.description  - Human-readable description
 * @param {object}   [opts.spec.schema]     - Parameter schema
 * @param {string}   [opts.spec.category]   - 'read' | 'write' | 'delete' | 'action'
 * @param {string}   [opts.spec.consequenceLevel] - 'low' | 'medium' | 'high'
 * @param {boolean}  [opts.spec.requiresConfirmation]
 * @param {number}   [opts.spec.timeout]
 * @param {string[]} [opts.spec.tags]
 * @param {string[]} [opts.spec.dependsOn]
 * @param {string[]} [opts.spec.triggerPhrases]
 * @param {object}   opts.projectConfig     - forge.config.json contents
 * @param {string}   opts.projectRoot       - Absolute path to project root
 * @param {object}   opts.modelConfig       - { provider, apiKey, model }
 * @param {string}   opts.modelConfig.provider  - 'anthropic' | 'openai'
 * @param {string}   opts.modelConfig.apiKey
 * @param {string}   opts.modelConfig.model
 * @param {string[]} [opts.existingTools]   - Existing tool names for barrel example
 *
 * @returns {Promise<{
 *   toolFile: { path: string, content: string },
 *   testFile: { path: string, content: string },
 *   barrelDiff: { path: string, lineToAdd: string } | null
 * }>}
 *
 * @throws {Error} If LLM returns invalid JSON after 2 retries
 */
export async function generateToolFiles({
  spec,
  projectConfig,
  projectRoot,
  modelConfig,
  existingTools = []
}) {
  const toolsDir = projectConfig?.project?.toolsDir || 'example/tools';

  // Resolve absolute base directory for path construction
  const absToolsDir = toolsDir.startsWith('/')
    ? toolsDir
    : `${projectRoot}/${toolsDir}`;

  const toolFilePath  = `${absToolsDir}/${spec.name}.tool.js`;
  const testFilePath  = `${absToolsDir}/__tests__/${spec.name}.tool.test.js`;
  const barrelPath    = `${absToolsDir}/index.js`;

  const systemPrompt = buildSystemPrompt(spec, existingTools);
  const userMessage  = `Generate the tool file, test file, and barrel line for the "${spec.name}" tool.`;

  const messages = [{ role: 'user', content: userMessage }];

  const MAX_RETRIES = 2;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let responseText;

    try {
      const turn = await llmTurn({
        provider:  modelConfig.provider,
        apiKey:    modelConfig.apiKey,
        model:     modelConfig.model,
        system:    systemPrompt,
        messages,
        maxTokens: 8192,
        timeoutMs: 120_000
      });

      responseText = turn.text;
    } catch (err) {
      // Network / API errors propagate immediately — no retry benefit
      throw new Error(
        `LLM API call failed while generating tool "${spec.name}": ${err.message}`
      );
    }

    if (!responseText || responseText.trim() === '') {
      lastError = new Error(
        `LLM returned an empty response on attempt ${attempt}/${MAX_RETRIES}`
      );
      // Append a nudge for the retry
      messages.push({ role: 'assistant', content: responseText || '' });
      messages.push({
        role: 'user',
        content:
          'Your response was empty. Please respond with ONLY a JSON object containing ' +
          '"toolFile", "testFile", and "barrelLine" keys.'
      });
      continue;
    }

    let parsed;
    try {
      parsed = extractJson(responseText);
    } catch (parseErr) {
      lastError = new Error(
        `Attempt ${attempt}/${MAX_RETRIES}: Could not extract JSON from LLM response — ` +
        parseErr.message +
        `\nRaw response (first 300 chars): ${responseText.slice(0, 300)}`
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          'Your previous response did not contain a valid JSON object. ' +
          'Respond ONLY with a JSON object with keys "toolFile", "testFile", and "barrelLine". ' +
          'Do not include any text outside the JSON.'
      });
      continue;
    }

    let validated;
    try {
      validated = validateLlmOutput(parsed);
    } catch (validErr) {
      lastError = new Error(
        `Attempt ${attempt}/${MAX_RETRIES}: LLM JSON was missing required fields — ` +
        validErr.message
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          `The JSON you returned was invalid: ${validErr.message}. ` +
          'Please provide a JSON object with non-empty string fields "toolFile", "testFile", ' +
          'and optionally "barrelLine".'
      });
      continue;
    }

    // Success — build result
    const barrelDiff = validated.barrelLine
      ? { path: barrelPath, lineToAdd: validated.barrelLine }
      : null;

    return {
      toolFile: {
        path:    toolFilePath,
        content: validated.toolFile
      },
      testFile: {
        path:    testFilePath,
        content: validated.testFile
      },
      barrelDiff
    };
  }

  // Exhausted retries
  throw new Error(
    `generateToolFiles: failed to obtain valid LLM output for "${spec.name}" ` +
    `after ${MAX_RETRIES} attempts. Last error: ${lastError?.message}`
  );
}
