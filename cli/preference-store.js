/**
 * PreferenceStore — per-user model + HITL preferences with permission hierarchy.
 *
 * resolveEffective() merges user preferences with app-owner config gates:
 *   - allowUserModelSelect: if false, user model preference is ignored
 *   - allowUserHitlConfig:  if false, user hitl preference is ignored
 */

import { getUserPreferences, upsertUserPreferences } from './db.js';
import { detectProvider, resolveApiKey } from './api-client.js';

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

