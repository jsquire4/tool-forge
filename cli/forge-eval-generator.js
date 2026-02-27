/**
 * Forge Eval Generator — generates golden and labeled eval JSON via LLM.
 *
 * Does NOT write files — returns content and computed paths so the caller
 * (forge.js) can preview and confirm before writing.
 *
 * @module forge-eval-generator
 */

import { llmTurn } from './api-client.js';

// ── JSON array extraction ──────────────────────────────────────────────────

/**
 * Extract a JSON array from raw LLM response text.
 * Tries ```json...``` fenced block first, then falls back to first `[` to
 * its matching closing `]`.
 *
 * @param {string} text - Raw LLM response text
 * @returns {unknown[]} Parsed JSON array
 * @throws {Error} If no valid JSON array can be found or parsed
 */
function extractJsonArray(text) {
  // Strategy 1: ```json ... ``` fenced block
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    const parsed = JSON.parse(fenceMatch[1]);
    if (Array.isArray(parsed)) return parsed;
    throw new Error('Fenced JSON block did not contain an array');
  }

  // Strategy 2: first `[` to its matching `]`
  const start = text.indexOf('[');
  if (start === -1) {
    throw new Error('No JSON array found in LLM response');
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

    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new Error('Unbalanced JSON array in LLM response');
}

// ── Case validation & normalisation ───────────────────────────────────────

/**
 * Validate and normalise a raw array of eval cases returned by the LLM.
 * Items missing required fields are filtered out with a warning.
 * Missing ids are assigned sequential defaults.
 *
 * @param {unknown[]} items       - Raw parsed array from LLM
 * @param {string}    toolName    - Used for default id generation
 * @param {'golden'|'labeled'} kind
 * @returns {object[]} Validated EvalCase array
 */
function validateAndNormaliseCases(items, toolName, kind) {
  if (!Array.isArray(items)) {
    throw new Error('LLM response did not parse to an array');
  }

  const prefix = kind === 'golden'
    ? `${toolName}_golden`
    : `${toolName}_labeled`;

  const valid = [];
  let counter = 1;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    // Required: input.message
    if (!item.input || typeof item.input.message !== 'string' || item.input.message.trim() === '') {
      continue;
    }

    // Assign default id if missing or blank
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      item.id = `${prefix}_${String(counter).padStart(3, '0')}`;
    }

    // Assign default description if missing
    if (typeof item.description !== 'string' || item.description.trim() === '') {
      item.description = `${kind} case ${counter}`;
    }

    // Assign default difficulty if missing
    if (typeof item.difficulty !== 'string' || item.difficulty.trim() === '') {
      item.difficulty = 'easy';
    }

    counter++;
    valid.push(item);
  }

  return valid;
}

// ── Prompt builders ────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for golden eval cases.
 *
 * @param {object} spec - Tool specification
 * @returns {string}
 */
function buildGoldenPrompt(spec) {
  const triggers = Array.isArray(spec.triggerPhrases) && spec.triggerPhrases.length
    ? spec.triggerPhrases.join(', ')
    : '(none provided)';

  return `Generate 5-8 golden eval cases for the tool '${spec.name}'.
Description: ${spec.description}
Trigger phrases: ${triggers}

Each case should have a natural user message that would trigger this tool.
Golden cases must have toolsCalled: ["${spec.name}"].

Include a variety of phrasings — direct questions, rephrased requests, casual wording.
Also include one case testing that raw JSON/internals are not leaked in the response.

Return a JSON array of eval cases. Each case must have this shape:
{
  "id": "${spec.name}_golden_001",
  "description": "brief description of the case",
  "difficulty": "easy" | "medium" | "hard",
  "input": { "message": "<user message>" },
  "expect": {
    "toolsCalled": ["${spec.name}"],
    "noToolErrors": true,
    "responseNonEmpty": true
  }
}

Respond ONLY with the JSON array — no prose, no markdown outside the JSON block.`;
}

/**
 * Build the LLM prompt for labeled eval cases.
 *
 * @param {object}                    spec      - Tool specification
 * @param {Array<{name:string, description:string}>} allTools  - All tools in registry
 * @returns {string}
 */
function buildLabeledPrompt(spec, allTools) {
  const toolsListing = allTools.length
    ? allTools.map((t) => `${t.name}: ${t.description}`).join('\n')
    : `${spec.name}: ${spec.description}`;

  return `Generate 4-6 labeled eval cases for '${spec.name}' vs other tools.
All tools:
${toolsListing}

Labeled cases test disambiguation — when the user's intent might match multiple tools or no tool.
Include:
- At least one ambiguous case where multiple tool combinations are acceptable
- At least one edge case (prompt injection attempt, off-topic question, or general knowledge)
- Varying difficulty: straightforward, ambiguous, edge

Each case has expect.toolsAcceptable (array of acceptable tool-name arrays).
Use ["__none__"] for cases where no tool should be called.

Return a JSON array of eval cases. Each case must have this shape:
{
  "id": "${spec.name}_labeled_001",
  "description": "brief description of the case",
  "difficulty": "straightforward" | "ambiguous" | "edge",
  "input": { "message": "<user message>" },
  "expect": {
    "toolsAcceptable": [["tool_a"], ["tool_a", "tool_b"]],
    "noToolErrors": true,
    "responseNonEmpty": true
  }
}

Respond ONLY with the JSON array — no prose, no markdown outside the JSON block.`;
}

// ── LLM call with retry ────────────────────────────────────────────────────

/**
 * Call the LLM and extract a valid JSON array of eval cases.
 * Retries up to MAX_RETRIES times with corrective nudges.
 *
 * @param {object}                opts
 * @param {object}                opts.modelConfig   - { provider, apiKey, model }
 * @param {string}                opts.prompt        - User-turn prompt
 * @param {string}                opts.toolName      - For id assignment
 * @param {'golden'|'labeled'}    opts.kind
 * @param {number}                [opts.maxRetries]
 * @returns {Promise<object[]>}
 */
async function callLlmForCases({ modelConfig, prompt, toolName, kind, maxRetries = 2 }) {
  const messages = [{ role: 'user', content: prompt }];
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let responseText;

    try {
      const turn = await llmTurn({
        provider:  modelConfig.provider,
        apiKey:    modelConfig.apiKey,
        model:     modelConfig.model,
        messages,
        maxTokens: 4096,
        timeoutMs: 90_000
      });
      responseText = turn.text;
    } catch (err) {
      throw new Error(
        `LLM API call failed while generating ${kind} evals for "${toolName}": ${err.message}`
      );
    }

    if (!responseText || responseText.trim() === '') {
      lastError = new Error(
        `LLM returned an empty response on attempt ${attempt}/${maxRetries}`
      );
      messages.push({ role: 'assistant', content: responseText || '' });
      messages.push({
        role: 'user',
        content:
          'Your response was empty. Please respond with ONLY a JSON array of eval cases.'
      });
      continue;
    }

    let parsed;
    try {
      parsed = extractJsonArray(responseText);
    } catch (parseErr) {
      lastError = new Error(
        `Attempt ${attempt}/${maxRetries}: Could not extract JSON array from LLM response — ` +
        parseErr.message +
        `\nRaw response (first 300 chars): ${responseText.slice(0, 300)}`
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          'Your previous response did not contain a valid JSON array. ' +
          'Respond ONLY with a JSON array of eval case objects. ' +
          'Do not include any text outside the JSON.'
      });
      continue;
    }

    let validated;
    try {
      validated = validateAndNormaliseCases(parsed, toolName, kind);
    } catch (validErr) {
      lastError = new Error(
        `Attempt ${attempt}/${maxRetries}: Eval case validation failed — ${validErr.message}`
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          `The array you returned was invalid: ${validErr.message}. ` +
          'Please provide a JSON array where each item has at minimum ' +
          '"id", "description", "input" (with "message"), and "expect".'
      });
      continue;
    }

    if (validated.length === 0) {
      lastError = new Error(
        `Attempt ${attempt}/${maxRetries}: LLM returned an array but no valid eval cases were found`
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          'None of the items in your array had the required shape. ' +
          'Each item needs at minimum an "input" object with a "message" string field.'
      });
      continue;
    }

    return validated;
  }

  throw new Error(
    `generateEvals: failed to obtain valid ${kind} eval cases for "${toolName}" ` +
    `after ${maxRetries} attempts. Last error: ${lastError?.message}`
  );
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate golden and labeled eval JSON via LLM.
 *
 * Does NOT write files. Returns the case arrays and their intended paths so
 * the caller (forge.js) can preview and confirm before writing.
 *
 * @param {object}   opts
 * @param {object}   opts.spec              - Tool specification
 * @param {string}   opts.spec.name         - Snake_case tool name
 * @param {string}   opts.spec.description  - Human-readable description
 * @param {string[]} [opts.spec.triggerPhrases]
 * @param {Array<{name:string, description:string}>} [opts.allTools]
 *   All tools in the registry (used to generate disambiguation labeled cases).
 *   Defaults to a single-entry list containing the spec itself if omitted.
 * @param {object}   opts.projectConfig     - forge.config.json contents
 * @param {string}   opts.projectRoot       - Absolute path to project root
 * @param {object}   opts.modelConfig       - { provider, apiKey, model }
 * @param {string}   opts.modelConfig.provider  - 'anthropic' | 'openai'
 * @param {string}   opts.modelConfig.apiKey
 * @param {string}   opts.modelConfig.model
 *
 * @returns {Promise<{
 *   goldenCases:  object[],
 *   labeledCases: object[],
 *   goldenPath:   string,
 *   labeledPath:  string
 * }>}
 *
 * @throws {Error} If LLM returns invalid content after retries
 */
export async function generateEvals({
  spec,
  allTools = [],
  projectConfig,
  projectRoot,
  modelConfig
}) {
  const evalsDir = projectConfig?.project?.evalsDir || 'docs/examples';

  // Resolve absolute evals directory for path construction
  const absEvalsDir = evalsDir.startsWith('/')
    ? evalsDir
    : `${projectRoot}/${evalsDir}`;

  const goldenPath  = `${absEvalsDir}/${spec.name}.golden.json`;
  const labeledPath = `${absEvalsDir}/${spec.name}.labeled.json`;

  // Ensure allTools includes at least the spec tool itself
  const toolsForLabeled = allTools.length
    ? allTools
    : [{ name: spec.name, description: spec.description }];

  // ── Generate golden cases ──────────────────────────────────────────────
  const goldenPrompt = buildGoldenPrompt(spec);
  const goldenCases  = await callLlmForCases({
    modelConfig,
    prompt:   goldenPrompt,
    toolName: spec.name,
    kind:     'golden'
  });

  // ── Generate labeled cases ─────────────────────────────────────────────
  const labeledPrompt = buildLabeledPrompt(spec, toolsForLabeled);
  const labeledCases  = await callLlmForCases({
    modelConfig,
    prompt:   labeledPrompt,
    toolName: spec.name,
    kind:     'labeled'
  });

  return {
    goldenCases,
    labeledCases,
    goldenPath,
    labeledPath
  };
}
