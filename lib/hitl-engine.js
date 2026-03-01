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
   * @param {import('pg').Pool} [opts.pgPool] — Postgres pool instance
   * @param {number} [opts.ttlMs] — pause state TTL (default 5 min)
   */
  constructor(opts = {}) {
    this._db = opts.db ?? null;
    this._redis = opts.redis ?? null;
    this._pgPool = opts.pgPool ?? null;
    this._ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    // In-memory store as fallback when no DB, no Redis, and no Postgres
    this._memStore = new Map();

    // Periodic cleanup of expired in-memory entries (every 60s)
    if (!this._db && !this._redis && !this._pgPool) {
      this._cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of this._memStore) {
          if (now > entry.expiresAt) this._memStore.delete(key);
        }
      }, 60_000);
      this._cleanupTimer.unref();
    }

    // Ensure hitl_pending table exists if using SQLite (and not Redis/Postgres)
    if (this._db && !this._redis && !this._pgPool) {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS hitl_pending (
          resume_token TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      // SQLite path — cleanup expired rows every 5 minutes.
      // DESIGN NOTE: 5-minute interval chosen deliberately. A shorter interval (e.g. 60s)
      // risks write contention under high HITL volume; a longer one (e.g. 30min) lets
      // stale rows accumulate more. 5min is a conservative middle ground.
      // If you see write contention on hitl_pending at scale, reduce to 60s.
      const db = this._db;
      this._sqliteCleanupTimer = setInterval(() => {
        try {
          db.prepare('DELETE FROM hitl_pending WHERE expires_at < ?')
            .run(new Date().toISOString());
        } catch { /* cleanup failure is non-fatal */ }
      }, 5 * 60_000);
      this._sqliteCleanupTimer.unref();
    }

    // Postgres table creation is deferred to first use (_ensurePgTable)
    this._pgTableReady = false;
  }

  /** @private */
  async _ensurePgTable() {
    if (this._pgTableReady) return;
    await this._pgPool.query(`
      CREATE TABLE IF NOT EXISTS hitl_pending (
        resume_token TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this._pgTableReady = true;
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

    if (this._pgPool) {
      await this._ensurePgTable();
      const expiresAt = new Date(Date.now() + this._ttlMs).toISOString();
      await this._pgPool.query(
        `INSERT INTO hitl_pending (resume_token, state_json, expires_at, created_at)
         VALUES ($1, $2, $3, $4)`,
        [resumeToken, stateJson, expiresAt, new Date().toISOString()]
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

    if (this._pgPool) {
      await this._ensurePgTable();
      const { rows } = await this._pgPool.query(
        'SELECT * FROM hitl_pending WHERE resume_token = $1',
        [resumeToken]
      );
      if (rows.length === 0) return null;

      const row = rows[0];
      // Delete regardless (one-time use)
      await this._pgPool.query(
        'DELETE FROM hitl_pending WHERE resume_token = $1',
        [resumeToken]
      );

      // Check expiry
      if (new Date(row.expires_at) < new Date()) return null;

      try {
        return JSON.parse(row.state_json);
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
 * Priority: Redis → Postgres → SQLite → in-memory.
 *
 * @param {object} config — forge config
 * @param {import('better-sqlite3').Database} [db]
 * @param {object} [redis] — pre-created Redis client instance
 * @param {import('pg').Pool} [pgPool] — pre-created Postgres pool instance
 * @returns {HitlEngine}
 */
export function makeHitlEngine(config, db, redis, pgPool) {
  const ttlMs = config?.hitl?.ttlMs ?? config?.ttlMs ?? undefined;
  const ttlOpt = ttlMs !== undefined ? { ttlMs } : {};
  if (redis) {
    return new HitlEngine({ redis, ...ttlOpt });
  }
  if (pgPool) {
    return new HitlEngine({ pgPool, ...ttlOpt });
  }
  return new HitlEngine({ db, ...ttlOpt });
}
