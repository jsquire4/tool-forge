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
  conversation: { store: 'sqlite', window: 25, redis: {} },
  sidecar: { enabled: false, port: 8001 }
};

const VALID_AUTH_MODES = ['verify', 'trust'];
const VALID_HITL_LEVELS = ['autonomous', 'cautious', 'standard', 'paranoid'];
const VALID_STORE_TYPES = ['sqlite', 'redis', 'postgres'];

/**
 * Deep merge raw config onto defaults. Only merges plain objects — arrays
 * and primitives from raw override the default value entirely.
 *
 * @param {object} raw — user-provided config (from forge.config.json)
 * @returns {object} merged config with all defaults filled in
 */
export function mergeDefaults(raw = {}) {
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

  // conversation.window
  if (raw.conversation?.window !== undefined) {
    const w = raw.conversation.window;
    if (typeof w !== 'number' || w < 1 || !Number.isInteger(w)) {
      errors.push(`conversation.window must be a positive integer (got ${w})`);
    }
  }

  return { valid: errors.length === 0, errors };
}
