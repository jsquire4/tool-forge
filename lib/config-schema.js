/**
 * Config schema — defaults and validation for forge.config.json.
 *
 * Used by the sidecar runtime to fill missing config values
 * and reject invalid configurations before startup.
 */

export const CONFIG_DEFAULTS = {
  auth: { mode: 'trust', signingKey: null, claimsPath: 'sub' },
  defaultModel: 'claude-sonnet-4-6',
  defaultHitlLevel: 'cautious',
  allowUserModelSelect: false,
  allowUserHitlConfig: false,
  adminKey: null,
  database: { type: 'sqlite', url: null },
  conversation: { store: 'sqlite', window: 25, redis: {} },
  sidecar: { enabled: false, port: 8001 },
  agents: [],
  rateLimit: {
    enabled: false,
    windowMs: 60_000,    // 1 minute
    maxRequests: 60      // per user per window
    // no 'store' key — auto-uses Redis if config.conversation.redis is configured
  },
  verification: {
    sandbox: true,           // false to disable sandboxing (dev mode)
    workerPoolSize: null,    // null = min(4, cpus().length), or explicit integer
    customTimeout: 2000,     // ms per custom verifier call
    maxQueueDepth: 200       // pending calls before queue-full rejection
  }
};

const VALID_AUTH_MODES = ['verify', 'trust'];
const VALID_HITL_LEVELS = ['autonomous', 'cautious', 'standard', 'paranoid'];
const VALID_STORE_TYPES = ['sqlite', 'redis', 'postgres'];
const VALID_DB_TYPES = ['sqlite', 'postgres'];

/**
 * Deep merge raw config onto defaults. Only merges plain objects — arrays
 * and primitives from raw override the default value entirely.
 *
 * @param {object} raw — user-provided config (from forge.config.json)
 * @returns {object} merged config with all defaults filled in
 */
export function mergeDefaults(raw = {}) {
  if (raw == null) raw = {};
  return deepMerge(CONFIG_DEFAULTS, raw);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const val = overrides[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)
        && typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Validate a raw config object. Returns { valid, errors }.
 *
 * @param {object} raw — config to validate (before or after merging defaults)
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(raw = {}) {
  const errors = [];

  // auth.mode
  if (raw.auth?.mode !== undefined && !VALID_AUTH_MODES.includes(raw.auth.mode)) {
    errors.push(`auth.mode must be one of: ${VALID_AUTH_MODES.join(', ')} (got "${raw.auth.mode}")`);
  }

  // auth.mode = 'verify' requires signingKey
  if (raw.auth?.mode === 'verify' && !raw.auth?.signingKey) {
    errors.push('auth.signingKey is required when auth.mode is "verify"');
  }

  // Startup validation: sidecar enabled + verify mode + no signingKey
  if (raw.sidecar?.enabled && raw.auth?.mode === 'verify' && !raw.auth?.signingKey) {
    errors.push('auth.signingKey is required when auth.mode is "verify" and sidecar is enabled. Set FORGE_JWT_KEY in .env');
  }

  // defaultHitlLevel
  if (raw.defaultHitlLevel !== undefined && !VALID_HITL_LEVELS.includes(raw.defaultHitlLevel)) {
    errors.push(`defaultHitlLevel must be one of: ${VALID_HITL_LEVELS.join(', ')} (got "${raw.defaultHitlLevel}")`);
  }

  // conversation.store
  if (raw.conversation?.store !== undefined && !VALID_STORE_TYPES.includes(raw.conversation.store)) {
    errors.push(`conversation.store must be one of: ${VALID_STORE_TYPES.join(', ')} (got "${raw.conversation.store}")`);
  }

  // sidecar.port
  if (raw.sidecar?.port !== undefined) {
    const port = raw.sidecar.port;
    if (typeof port !== 'number' || port < 1 || port > 65535 || !Number.isInteger(port)) {
      errors.push(`sidecar.port must be an integer between 1 and 65535 (got ${port})`);
    }
  }

  // database.type
  if (raw.database?.type !== undefined && !VALID_DB_TYPES.includes(raw.database.type)) {
    errors.push(`database.type must be one of: ${VALID_DB_TYPES.join(', ')} (got "${raw.database.type}")`);
  }

  // conversation.window
  if (raw.conversation?.window !== undefined) {
    const w = raw.conversation.window;
    if (typeof w !== 'number' || w < 1 || !Number.isInteger(w)) {
      errors.push(`conversation.window must be a positive integer (got ${w})`);
    }
  }

  // agents[]
  if (raw.agents !== undefined) {
    if (!Array.isArray(raw.agents)) {
      errors.push('agents must be an array');
    } else {
      const AGENT_ID_RE = /^[a-z0-9_-]+$/;
      for (let i = 0; i < raw.agents.length; i++) {
        const a = raw.agents[i];
        if (!a.id || typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) {
          errors.push(`agents[${i}].id must be a slug matching /^[a-z0-9_-]+$/ (got "${a.id}")`);
        }
        if (!a.displayName || typeof a.displayName !== 'string') {
          errors.push(`agents[${i}].displayName is required and must be a string (got ${JSON.stringify(a.displayName)})`);
        }
        if (a.defaultHitlLevel !== undefined && !VALID_HITL_LEVELS.includes(a.defaultHitlLevel)) {
          errors.push(`agents[${i}].defaultHitlLevel must be one of: ${VALID_HITL_LEVELS.join(', ')} (got "${a.defaultHitlLevel}")`);
        }
        if (a.toolAllowlist !== undefined && !Array.isArray(a.toolAllowlist) && a.toolAllowlist !== '*') {
          errors.push(`agents[${i}].toolAllowlist must be '*' or an array of tool names`);
        }
        if (a.maxTurns !== undefined && (typeof a.maxTurns !== 'number' || a.maxTurns < 1 || !Number.isInteger(a.maxTurns))) {
          errors.push(`agents[${i}].maxTurns must be a positive integer (got ${a.maxTurns})`);
        }
        if (a.maxTokens !== undefined && (typeof a.maxTokens !== 'number' || a.maxTokens < 1 || !Number.isInteger(a.maxTokens))) {
          errors.push(`agents[${i}].maxTokens must be a positive integer (got ${a.maxTokens})`);
        }
      }
    }
  }

  // rateLimit (only validated when enabled)
  if (raw.rateLimit?.enabled === true) {
    const windowMs = raw.rateLimit.windowMs;
    if (windowMs !== undefined && (typeof windowMs !== 'number' || windowMs < 1 || !Number.isInteger(windowMs))) {
      errors.push(`rateLimit.windowMs must be a positive integer (got ${windowMs})`);
    }
    const maxRequests = raw.rateLimit.maxRequests;
    if (maxRequests !== undefined && (typeof maxRequests !== 'number' || maxRequests < 1 || !Number.isInteger(maxRequests))) {
      errors.push(`rateLimit.maxRequests must be a positive integer (got ${maxRequests})`);
    }
  }

  // verification
  if (raw.verification !== undefined) {
    const workerPoolSize = raw.verification.workerPoolSize;
    if (workerPoolSize !== null && workerPoolSize !== undefined) {
      if (typeof workerPoolSize !== 'number' || workerPoolSize < 1 || !Number.isInteger(workerPoolSize)) {
        errors.push(`verification.workerPoolSize must be a positive integer or null (got ${workerPoolSize})`);
      }
    }
    const customTimeout = raw.verification.customTimeout;
    if (customTimeout !== undefined && (typeof customTimeout !== 'number' || customTimeout < 1 || !Number.isInteger(customTimeout))) {
      errors.push(`verification.customTimeout must be a positive integer (got ${customTimeout})`);
    }
    const maxQueueDepth = raw.verification.maxQueueDepth;
    if (maxQueueDepth !== undefined && (typeof maxQueueDepth !== 'number' || maxQueueDepth < 1 || !Number.isInteger(maxQueueDepth))) {
      errors.push(`verification.maxQueueDepth must be a positive integer (got ${maxQueueDepth})`);
    }
  }

  return { valid: errors.length === 0, errors };
}
