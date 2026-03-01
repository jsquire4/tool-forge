export type HitlLevel = 'autonomous' | 'cautious' | 'standard' | 'paranoid';

export interface UserPreferences {
  model: string | null;
  hitlLevel: string | null;
}

export interface EffectiveSettings {
  model: string;
  hitlLevel: string;
  provider: string;
  apiKey: string | null;
}

/**
 * Per-user model + HITL preferences with app-owner permission gates.
 *
 * `resolveEffective()` merges user preferences with config gates:
 * - `allowUserModelSelect: false` → user model preference is ignored
 * - `allowUserHitlConfig: false` → user HITL preference is ignored
 */
export class PreferenceStore {
  constructor(db: object);

  /**
   * Get stored preferences for a user, or `null` if none exist.
   */
  getUserPreferences(userId: string): UserPreferences | null;

  /**
   * Upsert user preferences.
   * Throws if `hitlLevel` is not a valid value.
   */
  setUserPreferences(userId: string, prefs: { model?: string; hitlLevel?: string }): void;

  /**
   * Resolve the effective model, HITL level, provider, and API key for a user.
   * Merges user preferences with app-owner config gates.
   */
  resolveEffective(userId: string, config: object, env?: Record<string, string>): EffectiveSettings;
}

/**
 * Factory — creates a PreferenceStore backed by SQLite.
 * For Postgres, use `buildSidecarContext`, which selects the adapter automatically.
 */
export function makePreferenceStore(config: object, db: object): PreferenceStore;
