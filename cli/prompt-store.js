/**
 * PromptStore — versioned system prompt management.
 *
 * TUI writes prompt versions, sidecar reads the active one per request.
 * Hot-swap: activate a new version and the next chat request picks it up.
 */

import {
  getActivePrompt,
  insertPromptVersion,
  activatePromptVersion,
  getAllPromptVersions
} from './db.js';

export class PromptStore {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this._db = db;
  }

  /** Get the active prompt content, or '' if none active. */
  getActivePrompt() {
    const row = getActivePrompt(this._db);
    return row ? row.content : '';
  }

  /** Get all versions ordered by most recent first. */
  getAllVersions() {
    return getAllPromptVersions(this._db);
  }

  /**
   * Create a new prompt version (inactive by default).
   * @returns {number} id
   */
  createVersion(version, content, notes = null) {
    return insertPromptVersion(this._db, { version, content, notes });
  }

  /** Activate a prompt version (deactivates all others). */
  activate(id) {
    activatePromptVersion(this._db, id);
  }

  /** Get a specific version by id, or null. */
  getVersion(id) {
    return this._db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id) ?? null;
  }
}

/**
 * Factory — matches the ConversationStore pattern.
 * @param {object} config — forge.config.json (unused for now, reserved for future adapters)
 * @param {import('better-sqlite3').Database} db
 * @returns {PromptStore}
 */
export function makePromptStore(config, db) {
  return new PromptStore(db);
}
