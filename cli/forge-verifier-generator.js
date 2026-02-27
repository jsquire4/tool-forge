/**
 * Forge Verifier Generator — generates verifier stub files via LLM.
 *
 * Does NOT write files — returns content strings and computed paths so the
 * caller (forge.js) can preview and confirm before writing.
 *
 * @module forge-verifier-generator
 */

import { llmTurn } from './api-client.js';
import { inferOutputGroups, getVerifiersForGroups } from './output-groups.js';

// ── Camel-case helper ──────────────────────────────────────────────────────

/**
 * Convert a snake_case identifier to camelCase.
 * e.g. "source_attribution" → "sourceAttribution"
 *
 * @param {string} name
 * @returns {string}
 */
function _camelCase(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// ── Verifier order helper ──────────────────────────────────────────────────

/**
 * Map a verifier name to a default sort-order prefix.
 * Known wildcard verifiers get 'A' prefix; domain-specific get 'B'.
 *
 * @param {string} verifierName
 * @param {number} index - Position in the list (for uniqueness)
 * @returns {string} e.g. 'A-0001'
 */
function defaultOrder(verifierName, index) {
  const wildcardVerifiers = new Set(['source_attribution']);
  const prefix = wildcardVerifiers.has(verifierName) ? 'A' : 'B';
  return `${prefix}-${String(index + 1).padStart(4, '0')}`;
}

// ── Prompt builder ─────────────────────────────────────────────────────────

/**
 * Build the LLM prompt for a single verifier stub.
 *
 * @param {object} spec          - Tool specification
 * @param {string} verifierName  - e.g. 'source_attribution'
 * @param {string} orderStr      - e.g. 'A-0001'
 * @returns {string}
 */
function buildVerifierPrompt(spec, verifierName, orderStr) {
  const camelVerifier = _camelCase(verifierName);
  const camelTool     = _camelCase(spec.name);

  return `Generate a JavaScript ESM verifier stub file for the verifier named '${verifierName}'.
This verifier applies to the tool: '${spec.name}'
Tool description: ${spec.description}

The verifier must follow this exact shape:

/**
 * ${verifierName} verifier — stub for ${spec.name}.
 * <One-sentence description of what this verifier checks.>
 */

export const ${camelVerifier}Verifier = {
  name: '${verifierName}',
  order: '${orderStr}',
  description: '<one-sentence description>',

  verify(response, _toolCalls) {
    // EXTENSION POINT: implement verification logic here
    // Return { pass: boolean, warnings: string[], flags: string[] }
    return { pass: true, warnings: [], flags: [] };
  }
};

Rules:
- The file must be a JavaScript ESM module using named export (no default export).
- The exported const name must be: ${camelVerifier}Verifier
- The verify() method receives (response, toolCalls) and must return { pass, warnings, flags }.
- Include a realistic // EXTENSION POINT comment inside verify() showing what the verifier
  would actually check for this tool's output shape (based on the tool description).
- Do NOT implement real logic — the body after the comment should return the stub { pass: true, warnings: [], flags: [] }.
- Add a short JSDoc comment at the top of the file.
- No imports needed unless a standard library (e.g. path, fs) is genuinely required.

Respond with ONLY the file content as plain text — no markdown fences, no prose.`;
}

// ── LLM call with retry ────────────────────────────────────────────────────

/**
 * Call the LLM to generate a single verifier stub.
 * Retries up to MAX_RETRIES times with corrective nudges.
 *
 * @param {object} opts
 * @param {object} opts.modelConfig   - { provider, apiKey, model }
 * @param {string} opts.prompt
 * @param {string} opts.toolName      - For error messages
 * @param {string} opts.verifierName  - For error messages
 * @param {number} [opts.maxRetries]
 * @returns {Promise<string>} Raw file content
 */
async function callLlmForVerifier({ modelConfig, prompt, toolName, verifierName, maxRetries = 2 }) {
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
        maxTokens: 2048,
        timeoutMs: 60_000
      });
      responseText = turn.text;
    } catch (err) {
      throw new Error(
        `LLM API call failed while generating verifier "${verifierName}" for tool "${toolName}": ${err.message}`
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
          'Your response was empty. Please respond with the full JavaScript ESM verifier file content.'
      });
      continue;
    }

    // Minimal validation: the response must contain the export keyword and the verifier name
    if (!responseText.includes('export') || !responseText.includes(verifierName)) {
      lastError = new Error(
        `Attempt ${attempt}/${maxRetries}: LLM response does not look like a valid verifier file ` +
        `(missing 'export' or '${verifierName}')`
      );
      messages.push({ role: 'assistant', content: responseText });
      messages.push({
        role: 'user',
        content:
          `Your response did not look like a valid ESM verifier file — it must contain an ` +
          `'export const ${_camelCase(verifierName)}Verifier' declaration. ` +
          'Please provide the complete file content with no markdown or prose.'
      });
      continue;
    }

    // Strip markdown fences if the model wrapped the output anyway
    const stripped = responseText
      .replace(/^```(?:javascript|js)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    return stripped;
  }

  throw new Error(
    `generateVerifiers: failed to obtain valid verifier content for "${verifierName}" ` +
    `(tool "${toolName}") after ${maxRetries} attempts. Last error: ${lastError?.message}`
  );
}

// ── Barrel line builder ────────────────────────────────────────────────────

/**
 * Build a single ESM named re-export line for the verifier barrel file.
 *
 * @param {string} verifierName  - e.g. 'source_attribution'
 * @param {string} toolName      - e.g. 'get_weather'
 * @param {string} verifiersDir  - Absolute path to verifiers directory
 * @returns {string} e.g. "export { sourceAttributionVerifier } from './get_weather.source_attribution.verifier.js';"
 */
function buildBarrelLine(verifierName, toolName, verifiersDir) {
  const camelVerifier  = _camelCase(verifierName);
  const fileName       = `${toolName}.${verifierName}.verifier.js`;
  // Barrel line uses a relative path (relative to the barrel file in the same dir)
  return `export { ${camelVerifier}Verifier } from './${fileName}';`;
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Generate verifier stub files via LLM.
 *
 * Uses output-groups.js to infer which verifiers apply to the tool, then
 * prompts the LLM to generate a stub file for each verifier.
 *
 * Does NOT write to disk. Returns file content and computed paths so the
 * caller (forge.js) can preview and confirm before writing.
 *
 * @param {object}   opts
 * @param {object}   opts.spec              - Tool specification
 * @param {string}   opts.spec.name         - Snake_case tool name
 * @param {string}   opts.spec.description  - Human-readable description
 * @param {string[]} [opts.spec.tags]       - Used by inferOutputGroups
 * @param {object}   opts.projectConfig     - forge.config.json contents
 * @param {string}   opts.projectRoot       - Absolute path to project root
 * @param {object}   opts.modelConfig       - { provider, apiKey, model }
 * @param {string}   opts.modelConfig.provider  - 'anthropic' | 'openai'
 * @param {string}   opts.modelConfig.apiKey
 * @param {string}   opts.modelConfig.model
 *
 * @returns {Promise<{
 *   verifierFiles: Array<{
 *     path:       string,
 *     content:    string,
 *     barrelLine: string | null
 *   }>
 * }>}
 *
 * @throws {Error} If LLM returns invalid content after retries for any verifier
 */
export async function generateVerifiers({
  spec,
  projectConfig,
  projectRoot,
  modelConfig
}) {
  const verifiersDir = projectConfig?.verification?.verifiersDir || 'example/verifiers';

  // Resolve absolute verifiers directory for path construction
  const absVerifiersDir = verifiersDir.startsWith('/')
    ? verifiersDir
    : `${projectRoot}/${verifiersDir}`;

  // ── Infer applicable verifiers from output-groups ──────────────────────
  const outputGroups   = inferOutputGroups({ name: spec.name, tags: spec.tags, description: spec.description });
  const verifierNames  = getVerifiersForGroups(outputGroups);

  if (verifierNames.length === 0) {
    // No matching verifiers — return empty result rather than failing
    return { verifierFiles: [] };
  }

  // ── Generate a stub file for each verifier ─────────────────────────────
  const verifierFiles = [];

  for (let i = 0; i < verifierNames.length; i++) {
    const verifierName = verifierNames[i];
    const orderStr     = defaultOrder(verifierName, i);
    const filePath     = `${absVerifiersDir}/${spec.name}.${verifierName}.verifier.js`;
    const barrelLine   = buildBarrelLine(verifierName, spec.name, absVerifiersDir);

    const prompt  = buildVerifierPrompt(spec, verifierName, orderStr);
    const content = await callLlmForVerifier({
      modelConfig,
      prompt,
      toolName:     spec.name,
      verifierName
    });

    verifierFiles.push({
      path: filePath,
      content,
      barrelLine
    });
  }

  return { verifierFiles };
}
