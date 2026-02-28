/**
 * HITL Engine — pause/resume for confirmable tool calls.
 *
 * Sensitivity levels:
 *   autonomous — never pause
 *   cautious   — pause if tool spec has requiresConfirmation flag
 *   standard   — pause for POST/PUT/PATCH/DELETE methods
 *   paranoid   — always pause
 *
 * Storage backends:
 *   memory  — in-process Map (default, single-instance only)
 *   sqlite  — hitl_pending table (single-instance, survives restart)
 *   redis   — forge:hitl:{token} keys with TTL (multi-instance, recommended for production)
 *
 * Paused state has a TTL — expired states cannot be resumed.
 */

import { randomUUID } from 'crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_KEY_PREFIX = 'forge:hitl:';

export class HitlEngine {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} [opts.db] — SQLite backend
   * @param {object} [opts.redis] — Redis client instance (ioredis or node-redis compatible)
   * @param {number} [opts.ttlMs] — pause state TTL (default 5 min)
   */
  constructor(opts = {}) {
    this._db = opts.db ?? null;
    this._redis = opts.redis ?? null;
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    // In-memory store as fallback when no DB and no Redis
    this._memStore = new Map();

    // Periodic cleanup of expired in-memory entries (every 60s)
    if (!this._db && !this._redis) {
      this._cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this._memStore) {
          if (now > entry.expiresAt) this._memStore.delete(key);
        }
      }, 60_000);
      this._cleanupTimer.unref();
    }

    // Ensure hitl_pending table exists if using SQLite
    if (this._db && !this._redis) {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS hitl_pending (
          resume_token TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    }
  }

  /**
   * Determine whether a tool call should pause for confirmation.
   *
   * @param {string} hitlLevel — user's HITL sensitivity level
   * @param {object} toolSpec — { name, method?, requiresConfirmation? }
   * @returns {boolean}
   */
  shouldPause(hitlLevel, toolSpec = {}) {
    switch (hitlLevel) {
      case 'autonomous':
        return false;
      case 'cautious':
        return !!toolSpec.requiresConfirmation;
      case 'standard': {
        const method = (toolSpec.method || 'GET').toUpperCase();
        return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      }
      case 'paranoid':
        return true;
      default:
        return false;
    }
  }

  /**
   * Store paused state and return a resume token.
   *
   * @param {object} state — arbitrary state to store (conversation, pending tool calls, etc.)
   * @returns {Promise<string>} resumeToken
   */
  async pause(state) {
    const resumeToken = randomUUID();
    const stateJson = JSON.stringify(state);

    if (this._redis) {
      const ttlSeconds = Math.ceil(this._ttlMs / 1000);
      await this._redis.set(
        REDIS_KEY_PREFIX + resumeToken,
        stateJson,
        'EX',
        ttlSeconds
      );
      return resumeToken;
    }

    if (this._db) {
      const expiresAt = new Date(Date.now() + this._ttlMs).toISOString();
      this._db.prepare(`
        INSERT INTO hitl_pending (resume_token, state_json, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(resumeToken, stateJson, expiresAt, new Date().toISOString());
      return resumeToken;
    }

    // In-memory fallback
    this._memStore.set(resumeToken, { state, expiresAt: Date.now() + this._ttlMs });
    return resumeToken;
  }

  /**
   * Resume a paused state. Returns the state if valid, null if expired or not found.
   * Deletes the state on successful resume (one-time use).
   *
   * @param {string} resumeToken
   * @returns {Promise<object|null>}
   */
  async resume(resumeToken) {
    if (this._redis) {
      const key = REDIS_KEY_PREFIX + resumeToken;
      // Atomic get-and-delete: use a pipeline or multi/exec
      // For simplicity, GET then DEL — race window is acceptable for HITL
      const stateJson = await this._redis.get(key);
      if (!stateJson) return null;
      await this._redis.del(key);
      try {
        return JSON.parse(stateJson);
      } catch {
        return null;
      }
    }

    if (this._db) {
      const row = this._db.prepare(
        'SELECT * FROM hitl_pending WHERE resume_token = ?'
      ).get(resumeToken);

      if (!row) return null;

      // Delete regardless (one-time use)
      this._db.prepare('DELETE FROM hitl_pending WHERE resume_token = ?').run(resumeToken);

      // Check expiry
      if (new Date(row.expires_at) < new Date()) return null;

      try {
        return JSON.parse(row.state_json);
      } catch {
        return null;
      }
    }

    // In-memory fallback
    const entry = this._memStore.get(resumeToken);
    if (!entry) return null;
    this._memStore.delete(resumeToken);
    if (Date.now() > entry.expiresAt) return null;
    return entry.state;
  }
}

/**
 * Factory — selects storage backend from config.
 *
 * @param {object} config — forge config. Checks config.hitlStore or config.conversation.store
 * @param {import('better-sqlite3').Database} [db]
 * @param {object} [redis] — pre-created Redis client instance
 * @returns {HitlEngine}
 */
export function makeHitlEngine(config, db, redis) {
  if (redis) {
    return new HitlEngine({ redis });
  }
  return new HitlEngine({ db });
}
