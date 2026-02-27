/**
 * forge-engine.js — Pure async state machine for the 10-phase tool forge dialogue.
 *
 * No blessed dependencies. No UI. Pure logic.
 * Uses cli/api-client.js for LLM calls.
 */

import { llmTurn } from './api-client.js';

// ── Phase registry ─────────────────────────────────────────────────────────

export const PHASES = [
  'explore',
  'skeptic',
  'description',
  'fields',
  'deps',
  'confirm',
  'generate',
  'test',
  'evals',
  'verifiers',
  'done'
];

/**
 * Return the zero-based index of a phase name.
 *
 * @param {string} phase
 * @returns {number} -1 if not found
 */
export function getPhaseIndex(phase) {
  return PHASES.indexOf(phase);
}

// ── Initial state factory ──────────────────────────────────────────────────

/**
 * Return a fresh initial state with the explore phase active.
 *
 * @returns {object}
 */
export function createInitialState() {
  return {
    phase: 'explore',
    spec: {
      name: null,
      description: null,
      schema: null,
      category: null,
      consequenceLevel: null,
      requiresConfirmation: null,
      timeout: null,
      tags: [],
      dependsOn: [],
      triggerPhrases: []
    },
    messages: [],
    retryCount: 0,
    lastValidationError: null,
    generationId: null
  };
}

// ── Phase system prompts ───────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  explore:
    "You are a tool forge assistant helping design a new LLM agent tool. Ask the user what they want to build. Be curious and open. Try to understand the use case, the trigger phrase ('user says X'), and what the tool should do. Keep your response under 100 words.",

  skeptic:
    "You are reviewing whether a new tool is necessary. Here are the existing tools: {existingTools}. Challenge the user: does this overlap with any existing tool? Could it be a parameter variation instead? Only proceed if the tool is genuinely distinct. Ask pointed questions.",

  description:
    "You are locking the description contract for a tool. The format MUST be: '<What the tool does>. Use when <trigger phrase>. <Disambiguation from similar tools if any>.' Extract: name (snake_case), description (this format), triggerPhrases (3+ variations a user might say to trigger this). Respond with JSON: { name, description, triggerPhrases }. Then ask the user to confirm.",

  fields:
    "Extract the tool's schema fields, category, consequence level, and confirmation requirement. Respond with JSON: { schema: { <fieldName>: { type, description, optional? } }, category: 'read'|'write'|'delete'|'side_effect', consequenceLevel: 'low'|'medium'|'high', requiresConfirmation: boolean }. Then show a summary.",

  deps:
    "Optionally collect tags and dependencies. Ask if this tool depends on any other tools. Respond with JSON: { tags: [], dependsOn: [] }. This phase can be skipped.",

  confirm:
    "Show the full spec and ask the user to type 'yes' to proceed to code generation, or describe any changes.",

  generate:
    "Auto-advance — no user input needed. Emit the write_file action.",

  test:
    "Auto-advance — no user input needed. Emit the run_tests action.",

  evals:
    "Auto-advance — no user input needed. Emit the write_evals action.",

  verifiers:
    "Auto-advance — no user input needed. Emit the write_verifiers action.",

  done:
    "The tool forge dialogue is complete."
};

// ── Phase validators ───────────────────────────────────────────────────────

/**
 * Validate JSON extracted from the description phase.
 *
 * @param {object} json
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateDescription(json) {
  if (!json || typeof json !== 'object') {
    return { valid: false, error: 'Response must be a JSON object.' };
  }

  const { name, description, triggerPhrases } = json;

  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) {
    return {
      valid: false,
      error: 'name must be a non-empty snake_case string (e.g. "my_tool_name").'
    };
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    return { valid: false, error: 'description must be a non-empty string.' };
  }

  if (!description.toLowerCase().includes('use when')) {
    return {
      valid: false,
      error:
        'description must follow the format: "<What it does>. Use when <trigger>. <Disambiguation>."'
    };
  }

  if (!Array.isArray(triggerPhrases) || triggerPhrases.length < 2) {
    return {
      valid: false,
      error: 'triggerPhrases must be an array with at least 2 entries.'
    };
  }

  return { valid: true, error: null };
}

/**
 * Validate JSON extracted from the fields phase.
 *
 * @param {object} json
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateFields(json) {
  if (!json || typeof json !== 'object') {
    return { valid: false, error: 'Response must be a JSON object.' };
  }

  const { schema, category, consequenceLevel, requiresConfirmation } = json;

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { valid: false, error: 'schema must be a non-null object mapping field names to definitions.' };
  }

  const validCategories = ['read', 'write', 'delete', 'side_effect'];
  if (!validCategories.includes(category)) {
    return {
      valid: false,
      error: `category must be one of: ${validCategories.join(', ')}.`
    };
  }

  const validLevels = ['low', 'medium', 'high'];
  if (!validLevels.includes(consequenceLevel)) {
    return {
      valid: false,
      error: `consequenceLevel must be one of: ${validLevels.join(', ')}.`
    };
  }

  if (typeof requiresConfirmation !== 'boolean') {
    return { valid: false, error: 'requiresConfirmation must be a boolean.' };
  }

  return { valid: true, error: null };
}

/**
 * Validate JSON extracted from the deps phase.
 *
 * @param {object} json
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateDeps(json) {
  if (!json || typeof json !== 'object') {
    return { valid: false, error: 'Response must be a JSON object.' };
  }

  const { tags, dependsOn } = json;

  if (!Array.isArray(tags)) {
    return { valid: false, error: 'tags must be an array.' };
  }

  if (!Array.isArray(dependsOn)) {
    return { valid: false, error: 'dependsOn must be an array.' };
  }

  return { valid: true, error: null };
}

// ── JSON extraction ────────────────────────────────────────────────────────

/**
 * Extract the first JSON object from an LLM response string.
 * Tries ```json ... ``` fenced block first; falls back to first { to last }.
 *
 * @param {string} text
 * @returns {object|null} Parsed object, or null if extraction failed.
 */
function extractJson(text) {
  // Strategy 1: fenced ```json ... ``` block
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch (_) {
      // fall through to strategy 2
    }
  }

  // Strategy 2: first { to last }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      // extraction failed
    }
  }

  return null;
}

// ── LLM call helper ────────────────────────────────────────────────────────

/**
 * Perform a single LLM turn, appending user input (if any) and returning the
 * assistant text plus the updated messages array.
 *
 * @param {object[]} messages         - Current conversation history (immutable)
 * @param {string|null} userInput     - New user message, or null to skip
 * @param {string} systemPrompt       - Phase system prompt
 * @param {object} modelConfig        - { provider, apiKey, model }
 * @returns {Promise<{ assistantText: string, newMessages: object[] }>}
 */
async function callLlm(messages, userInput, systemPrompt, modelConfig) {
  const newMessages = [...messages];

  if (userInput !== null && userInput !== undefined) {
    newMessages.push({ role: 'user', content: userInput });
  }

  const result = await llmTurn({
    provider: modelConfig.provider,
    apiKey:   modelConfig.apiKey,
    model:    modelConfig.model,
    system:   systemPrompt,
    messages: newMessages
  });

  const assistantText = result.text || '';
  newMessages.push({ role: 'assistant', content: assistantText });

  return { assistantText, newMessages };
}

// ── Phase handlers ─────────────────────────────────────────────────────────

async function handleExplore({ state, userInput, modelConfig }) {
  const systemPrompt = SYSTEM_PROMPTS.explore;
  const { assistantText, newMessages } = await callLlm(
    state.messages,
    userInput,
    systemPrompt,
    modelConfig
  );

  // Advance after the AI has asked its opening question AND the user has replied.
  // Heuristic: if there is already at least one user message in history before
  // this call, the user has replied to the initial question — advance to skeptic.
  const prevUserMessages = state.messages.filter((m) => m.role === 'user');
  const advance = prevUserMessages.length >= 1 && userInput !== null;

  const nextPhase = advance ? 'skeptic' : 'explore';

  return {
    nextState: {
      ...state,
      phase: nextPhase,
      messages: newMessages
    },
    assistantText,
    specUpdate: null,
    actions: [],
    phaseChanged: advance
  };
}

async function handleSkeptic({ state, userInput, modelConfig, existingTools }) {
  const toolList = Array.isArray(existingTools) ? existingTools.join(', ') : '';
  const systemPrompt = SYSTEM_PROMPTS.skeptic.replace('{existingTools}', toolList || '(none)');

  const { assistantText, newMessages } = await callLlm(
    state.messages,
    userInput,
    systemPrompt,
    modelConfig
  );

  // Advance after the user has replied to the skeptic challenge.
  // "At least one prior assistant turn in skeptic" + a new user reply = advance.
  const prevAssistantInPhase = state.messages.filter((m) => m.role === 'assistant');
  const advance = prevAssistantInPhase.length >= 1 && userInput !== null;

  const nextPhase = advance ? 'description' : 'skeptic';

  return {
    nextState: {
      ...state,
      phase: nextPhase,
      messages: newMessages
    },
    assistantText,
    specUpdate: null,
    actions: [],
    phaseChanged: advance
  };
}

async function handleJsonPhase({
  state,
  userInput,
  modelConfig,
  systemPrompt,
  validator,
  applySpec,
  nextPhase
}) {
  const { assistantText, newMessages } = await callLlm(
    state.messages,
    userInput,
    systemPrompt,
    modelConfig
  );

  const extracted = extractJson(assistantText);

  if (!extracted) {
    // No JSON found — ask again if retries remain.
    if (state.retryCount < 3) {
      const retryMsg = 'I could not find a JSON block in your response. Please include a JSON object with the required fields, wrapped in ```json ... ``` fences.';
      const retryMessages = [
        ...newMessages,
        { role: 'user', content: retryMsg }
      ];
      return {
        nextState: {
          ...state,
          phase: state.phase,
          messages: retryMessages,
          retryCount: state.retryCount + 1,
          lastValidationError: retryMsg
        },
        assistantText,
        specUpdate: null,
        actions: [],
        phaseChanged: false
      };
    }

    // Too many retries — surface to user, reset retry counter.
    return {
      nextState: {
        ...state,
        phase: state.phase,
        messages: newMessages,
        retryCount: 0,
        lastValidationError: 'Could not extract JSON after 3 attempts. Please try rephrasing.'
      },
      assistantText: assistantText + '\n\n(Could not extract JSON after 3 attempts. Please try rephrasing your requirements.)',
      specUpdate: null,
      actions: [],
      phaseChanged: false
    };
  }

  const { valid, error } = validator(extracted);

  if (!valid) {
    if (state.retryCount < 3) {
      const retryMsg = `The JSON was found but failed validation: ${error} Please correct and try again.`;
      const retryMessages = [
        ...newMessages,
        { role: 'user', content: retryMsg }
      ];
      return {
        nextState: {
          ...state,
          phase: state.phase,
          messages: retryMessages,
          retryCount: state.retryCount + 1,
          lastValidationError: retryMsg
        },
        assistantText,
        specUpdate: null,
        actions: [],
        phaseChanged: false
      };
    }

    return {
      nextState: {
        ...state,
        phase: state.phase,
        messages: newMessages,
        retryCount: 0,
        lastValidationError: error
      },
      assistantText: assistantText + `\n\n(Validation failed after 3 attempts: ${error})`,
      specUpdate: null,
      actions: [],
      phaseChanged: false
    };
  }

  // Valid — apply spec update and advance.
  const specUpdate = applySpec(extracted);
  return {
    nextState: {
      ...state,
      phase: nextPhase,
      spec: { ...state.spec, ...specUpdate },
      messages: newMessages,
      retryCount: 0,
      lastValidationError: null
    },
    assistantText,
    specUpdate,
    actions: [],
    phaseChanged: true
  };
}

async function handleDescription({ state, userInput, modelConfig }) {
  return handleJsonPhase({
    state,
    userInput,
    modelConfig,
    systemPrompt: SYSTEM_PROMPTS.description,
    validator: validateDescription,
    applySpec: (json) => ({
      name: json.name,
      description: json.description,
      triggerPhrases: json.triggerPhrases
    }),
    nextPhase: 'fields'
  });
}

async function handleFields({ state, userInput, modelConfig }) {
  return handleJsonPhase({
    state,
    userInput,
    modelConfig,
    systemPrompt: SYSTEM_PROMPTS.fields,
    validator: validateFields,
    applySpec: (json) => ({
      schema: json.schema,
      category: json.category,
      consequenceLevel: json.consequenceLevel,
      requiresConfirmation: json.requiresConfirmation
    }),
    nextPhase: 'deps'
  });
}

async function handleDeps({ state, userInput, modelConfig }) {
  return handleJsonPhase({
    state,
    userInput,
    modelConfig,
    systemPrompt: SYSTEM_PROMPTS.deps,
    validator: validateDeps,
    applySpec: (json) => ({
      tags: json.tags,
      dependsOn: json.dependsOn
    }),
    nextPhase: 'confirm'
  });
}

async function handleConfirm({ state, userInput, modelConfig }) {
  // Build a readable spec summary for the system prompt.
  const specSummary = JSON.stringify(state.spec, null, 2);
  const systemPrompt =
    SYSTEM_PROMPTS.confirm +
    '\n\nCurrent spec:\n```json\n' + specSummary + '\n```';

  const { assistantText, newMessages } = await callLlm(
    state.messages,
    userInput,
    systemPrompt,
    modelConfig
  );

  const confirmed = typeof userInput === 'string' && /^yes$/i.test(userInput.trim());

  return {
    nextState: {
      ...state,
      phase: confirmed ? 'generate' : 'confirm',
      messages: newMessages
    },
    assistantText,
    specUpdate: null,
    actions: [],
    phaseChanged: confirmed
  };
}

async function handleAutoAdvance({ state, systemPrompt, modelConfig, actions, nextPhase }) {
  const confirmMsg = 'Proceeding automatically.';
  const { assistantText, newMessages } = await callLlm(
    state.messages,
    confirmMsg,
    systemPrompt,
    modelConfig
  );

  return {
    nextState: {
      ...state,
      phase: nextPhase,
      messages: newMessages
    },
    assistantText,
    specUpdate: null,
    actions,
    phaseChanged: true
  };
}

async function handleGenerate({ state, modelConfig, projectRoot }) {
  // Derive expected file paths from the spec name.
  const toolName = state.spec.name || 'unnamed_tool';
  const toolPath = projectRoot
    ? `${projectRoot}/tools/${toolName}.js`
    : `tools/${toolName}.js`;
  const testPath = projectRoot
    ? `${projectRoot}/tools/${toolName}.test.js`
    : `tools/${toolName}.test.js`;

  const actions = [
    {
      type: 'write_file',
      payload: { toolPath, testPath, barrelDiff: null }
    }
  ];

  return handleAutoAdvance({
    state,
    systemPrompt: SYSTEM_PROMPTS.generate,
    modelConfig,
    actions,
    nextPhase: 'test'
  });
}

async function handleTest({ state, modelConfig }) {
  const toolName = state.spec.name || 'unnamed_tool';
  const actions = [
    {
      type: 'run_tests',
      payload: { command: `npm test -- ${toolName}` }
    }
  ];

  return handleAutoAdvance({
    state,
    systemPrompt: SYSTEM_PROMPTS.test,
    modelConfig,
    actions,
    nextPhase: 'evals'
  });
}

async function handleEvals({ state, modelConfig }) {
  return handleAutoAdvance({
    state,
    systemPrompt: SYSTEM_PROMPTS.evals,
    modelConfig,
    actions: [{ type: 'write_evals' }],
    nextPhase: 'verifiers'
  });
}

async function handleVerifiers({ state, modelConfig }) {
  return handleAutoAdvance({
    state,
    systemPrompt: SYSTEM_PROMPTS.verifiers,
    modelConfig,
    actions: [{ type: 'write_verifiers' }],
    nextPhase: 'done'
  });
}

function handleDone({ state }) {
  return {
    nextState: { ...state, phase: 'done' },
    assistantText: 'The tool forge dialogue is complete. Your tool has been generated.',
    specUpdate: null,
    actions: [],
    phaseChanged: false
  };
}

// ── Core export ────────────────────────────────────────────────────────────

/**
 * Advance the forge state machine by one step.
 *
 * @param {object} opts
 * @param {object}        opts.state          - Current forge state (from createInitialState or prior forgeStep)
 * @param {string|null}   opts.userInput      - User message, or null for auto-advance phases
 * @param {object}        opts.modelConfig    - { provider, apiKey, model }
 * @param {string[]}      [opts.existingTools] - Names of tools already in the registry
 * @param {object}        [opts.projectConfig] - Project-level config (passed through, not consumed here)
 * @param {string}        [opts.projectRoot]  - Absolute path to project root (used for file path construction)
 * @returns {Promise<{
 *   nextState: object,
 *   assistantText: string,
 *   specUpdate: object|null,
 *   actions: Array<object>,
 *   phaseChanged: boolean
 * }>}
 */
export async function forgeStep({
  state,
  userInput,
  modelConfig,
  existingTools = [],
  projectConfig,
  projectRoot
}) {
  const phase = state.phase;

  switch (phase) {
    case 'explore':
      return handleExplore({ state, userInput, modelConfig });

    case 'skeptic':
      return handleSkeptic({ state, userInput, modelConfig, existingTools });

    case 'description':
      return handleDescription({ state, userInput, modelConfig });

    case 'fields':
      return handleFields({ state, userInput, modelConfig });

    case 'deps':
      return handleDeps({ state, userInput, modelConfig });

    case 'confirm':
      return handleConfirm({ state, userInput, modelConfig });

    case 'generate':
      return handleGenerate({ state, modelConfig, projectRoot });

    case 'test':
      return handleTest({ state, modelConfig });

    case 'evals':
      return handleEvals({ state, modelConfig });

    case 'verifiers':
      return handleVerifiers({ state, modelConfig });

    case 'done':
      return handleDone({ state });

    default:
      throw new Error(`forgeStep: unknown phase "${phase}".`);
  }
}
