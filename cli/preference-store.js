/**
 * PreferenceStore — per-user model + HITL preferences with permission hierarchy.
 *
 * resolveEffective() merges user preferences with app-owner config gates:
 *   - allowUserModelSelect: if false, user model preference is ignored
 *   - allowUserHitlConfig:  if false, user hitl preference is ignored
 */

import { getUserPreferences, upsertUserPreferences } from './db.js';

const VALID_HITL_LEVELS = ['autonomous', 'cautious', 'standard', 'paranoid'];

export class PreferenceStore {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this._db = db;
  }

  /**
   * Get stored preferences for a user.
   * @param {string} userId
   * @returns {{ model: string|null, hitlLevel: string|null } | null}
   */
  getUserPreferences(userId) {
    const row = getUserPreferences(this._db, userId);
    if (!row) return null;
    return { model: row.model, hitlLevel: row.hitl_level };
  }

  /**
   * Set user preferences (upsert).
   * @param {string} userId
   * @param {{ model?: string, hitlLevel?: string }} prefs
   */
  setUserPreferences(userId, prefs) {
    if (prefs.hitlLevel && !VALID_HITL_LEVELS.includes(prefs.hitlLevel)) {
      throw new Error(`Invalid hitlLevel: ${prefs.hitlLevel}. Must be one of: ${VALID_HITL_LEVELS.join(', ')}`);
    }
    upsertUserPreferences(this._db, userId, prefs);
  }

  /**
   * Resolve effective settings for a user — merges user prefs with config gates.
   *
   * @param {string} userId
   * @param {object} config — merged forge config (from mergeDefaults)
   * @param {object} env — process.env or equivalent
   * @returns {{ model: string, hitlLevel: string, provider: string, apiKey: string|null }}
   */
  resolveEffective(userId, config, env = {}) {
    const userPrefs = this.getUserPreferences(userId);

    const model = (config.allowUserModelSelect && userPrefs?.model)
      ? userPrefs.model
      : (config.defaultModel ?? 'claude-sonnet-4-6');

    const hitlLevel = (config.allowUserHitlConfig && userPrefs?.hitlLevel)
      ? userPrefs.hitlLevel
      : (config.defaultHitlLevel ?? 'cautious');

    const provider = detectProvider(model);
    const apiKey = resolveApiKey(provider, env);

    return { model, hitlLevel, provider, apiKey };
  }
}

/**
 * Factory — matches the ConversationStore pattern.
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 * @returns {PreferenceStore}
 */
export function makePreferenceStore(config, db) {
  return new PreferenceStore(db);
}

// ── Internal helpers (duplicated from api-client.js for independence) ─────

function detectProvider(model) {
  if (!model) return 'anthropic';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  return 'anthropic';
}

function resolveApiKey(provider, env) {
  switch (provider) {
    case 'anthropic': return env.ANTHROPIC_API_KEY ?? null;
    case 'openai':    return env.OPENAI_API_KEY ?? null;
    case 'google':    return env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? null;
    case 'deepseek':  return env.DEEPSEEK_API_KEY ?? null;
    default:          return env.ANTHROPIC_API_KEY ?? null;
  }
}
