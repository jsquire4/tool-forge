/**
 * ConversationStore — pluggable persistence for forge-agent conversation history.
 *
 * Two adapters:
 *   SqliteConversationStore  — default, wraps the existing conversations table in db.js
 *   RedisConversationStore   — optional, requires the `redis` npm package to be installed
 *
 * Factory:
 *   makeConversationStore(config, db?)
 *     config.conversation.store === 'redis'  → RedisConversationStore
 *     anything else (or absent)              → SqliteConversationStore
 *
 * Both adapters expose the same async interface so forge-agent.js never
 * needs to know which backend is in use.
 *
 * Redis key schema:
 *   forge:conv:<sessionId>:msgs   — List of JSON-serialised message rows
 *   forge:sessions:active         — Set of sessionIds without a [COMPLETE] marker
 */

import { randomUUID } from 'crypto';

// ── Shared interface (JSDoc, not enforced at runtime) ──────────────────────
//
// interface ConversationStore {
//   createSession(): string
//   persistMessage(sessionId, stage, role, content): Promise<void>
//   getHistory(sessionId): Promise<MessageRow[]>
//   getIncompleteSessions(): Promise<SessionSummary[]>
//   close(): Promise<void>
// }

// ── SQLite adapter ─────────────────────────────────────────────────────────

export class SqliteConversationStore {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this._db = db;

    // Prepare statements once to avoid repeated compilation
    this._stmtInsert = db.prepare(`
      INSERT INTO conversations (session_id, stage, role, content, agent_id, user_id, created_at)
      VALUES (@session_id, @stage, @role, @content, @agent_id, @user_id, @created_at)
    `);
    this._stmtHistory = db.prepare(`
      SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at ASC
    `);
    this._stmtIncomplete = db.prepare(`
      SELECT
        c.session_id,
        c.stage,
        MAX(c.created_at) AS last_updated
      FROM conversations c
      WHERE c.session_id NOT IN (
        SELECT DISTINCT session_id FROM conversations
        WHERE role = 'system' AND content = '[COMPLETE]'
      )
      GROUP BY c.session_id
      ORDER BY last_updated DESC
    `);
  }

  createSession() {
    return randomUUID();
  }

  async persistMessage(sessionId, stage, role, content, agentId = null, userId = null) {
    this._stmtInsert.run({
      session_id: sessionId,
      stage,
      role,
      content,
      agent_id: agentId ?? null,
      user_id: userId ?? null,
      created_at: new Date().toISOString()
    });
  }

  async getHistory(sessionId) {
    return this._stmtHistory.all(sessionId);
  }

  async getIncompleteSessions() {
    return this._stmtIncomplete.all();
  }

  async listSessions(userId) {
    const rows = this._db.prepare(
      `SELECT session_id, agent_id, user_id,
              MAX(created_at) AS last_updated,
              MIN(created_at) AS started_at
       FROM conversations
       WHERE user_id = ?
       GROUP BY session_id
       ORDER BY last_updated DESC`
    ).all(userId ?? null);
    return rows.map(r => ({
      sessionId: r.session_id,
      agentId: r.agent_id ?? null,
      userId: r.user_id ?? null,
      startedAt: r.started_at,
      lastUpdated: r.last_updated
    }));
  }

  async deleteSession(sessionId, userId) {
    const result = this._db.prepare(
      'DELETE FROM conversations WHERE session_id = ? AND user_id = ?'
    ).run(sessionId, userId ?? null);
    return result.changes > 0;
  }

  async getSessionUserId(sessionId) {
    const row = this._db.prepare(
      'SELECT user_id FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(sessionId);
    if (!row) return undefined;
    return row.user_id ?? null;
  }

  async close() {
    // SQLite connection managed externally — nothing to tear down here
  }
}

// ── Redis adapter ──────────────────────────────────────────────────────────

const ACTIVE_SET_KEY = 'forge:sessions:active';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export class RedisConversationStore {
  /**
   * @param {object} redisConfig  — shape: { url, ttlSeconds? }
   *   url         e.g. 'redis://localhost:6379' or 'rediss://...' for TLS
   *   ttlSeconds  message list TTL (default 30 days); refreshed on each write
   */
  constructor(redisConfig = {}) {
    this._url = redisConfig.url || 'redis://localhost:6379';
    this._ttl = redisConfig.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this._client = null;
  }

  async _connect() {
    if (this._client) return this._client;

    let createClient;
    try {
      ({ createClient } = await import('redis'));
    } catch {
      throw new Error(
        'Redis store requires the "redis" package: run `npm install redis`'
      );
    }

    this._client = createClient({ url: this._url });
    this._client.on('error', (err) => {
      // Non-fatal — log but don't crash the forge-agent session
      console.error('[conversation-store] Redis error:', err.message);
    });
    await this._client.connect();
    return this._client;
  }

  createSession() {
    return randomUUID();
  }

  async persistMessage(sessionId, stage, role, content, agentId = null, userId = null) {
    const client = await this._connect();
    const msgKey = `forge:conv:${sessionId}:msgs`;

    const row = JSON.stringify({
      session_id: sessionId,
      stage,
      role,
      content,
      agent_id: agentId ?? null,
      user_id: userId ?? null,
      created_at: new Date().toISOString()
    });

    // Atomic pipeline — rPush + expire + active-set update in one round-trip
    const pl = client.multi();
    pl.rPush(msgKey, row);
    pl.expire(msgKey, this._ttl);
    if (role === 'system' && content === '[COMPLETE]') {
      pl.sRem(ACTIVE_SET_KEY, sessionId);
    } else {
      pl.sAdd(ACTIVE_SET_KEY, sessionId);
    }
    await pl.exec();
  }

  async getHistory(sessionId) {
    const client = await this._connect();
    const raw = await client.lRange(`forge:conv:${sessionId}:msgs`, 0, -1);
    return raw.map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
  }

  async getIncompleteSessions() {
    const client = await this._connect();
    const sessionIds = await client.sMembers(ACTIVE_SET_KEY);
    if (sessionIds.length === 0) return [];

    // For each active session, fetch the last message to get stage + timestamp
    const summaries = await Promise.all(
      sessionIds.map(async (sessionId) => {
        const last = await client.lIndex(`forge:conv:${sessionId}:msgs`, -1);
        if (!last) return null;
        try {
          const row = JSON.parse(last);
          return { session_id: sessionId, stage: row.stage, last_updated: row.created_at };
        } catch {
          return null;
        }
      })
    );

    return summaries
      .filter(Boolean)
      .sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  }

  async listSessions(userId) {
    const client = await this._connect();
    const sessionIds = await client.sMembers(ACTIVE_SET_KEY);

    const sessionData = await Promise.all(sessionIds.map(async (sessionId) => {
      const [firstMsgRaw, lastMsgRaw] = await Promise.all([
        client.lIndex(`forge:conv:${sessionId}:msgs`, 0),
        client.lIndex(`forge:conv:${sessionId}:msgs`, -1)
      ]);
      return { sessionId, firstMsgRaw, lastMsgRaw };
    }));

    const result = [];
    for (const { sessionId, firstMsgRaw, lastMsgRaw } of sessionData) {
      if (!firstMsgRaw) {
        // stale entry — clean it up from the active set
        await client.sRem(ACTIVE_SET_KEY, sessionId);
        continue;
      }
      try {
        const msg = JSON.parse(firstMsgRaw);
        if (msg.user_id !== userId) continue;
        const last = lastMsgRaw ? JSON.parse(lastMsgRaw) : msg;
        result.push({
          sessionId,
          agentId: msg.agent_id ?? null,
          userId: msg.user_id ?? null,
          startedAt: msg.created_at,
          lastUpdated: last.created_at
        });
      } catch { /* skip malformed */ }
    }
    return result.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  }

  async deleteSession(sessionId, userId) {
    const client = await this._connect();
    // Verify ownership via first message
    const firstMsg = await client.lIndex(`forge:conv:${sessionId}:msgs`, 0);
    if (!firstMsg) return false;
    try {
      const msg = JSON.parse(firstMsg);
      if (msg.user_id !== userId) return false;
    } catch { return false; }
    const pl = client.multi();
    pl.del(`forge:conv:${sessionId}:msgs`);
    pl.sRem(ACTIVE_SET_KEY, sessionId);
    await pl.exec();
    return true;
  }

  async getSessionUserId(sessionId) {
    const client = await this._connect();
    const firstMsg = await client.lIndex(`forge:conv:${sessionId}:msgs`, 0);
    if (!firstMsg) return undefined;
    try {
      const msg = JSON.parse(firstMsg);
      return msg.user_id ?? null;
    } catch { return undefined; }
  }

  async close() {
    if (this._client) {
      await this._client.quit();
      this._client = null;
    }
  }
}

// ── Postgres adapter ──────────────────────────────────────────────────────

export class PostgresConversationStore {
  /**
   * @param {import('pg').Pool} pgPool — shared Pool instance (not owned by this store)
   */
  constructor(pgPool) {
    this._pool = pgPool;
    this._tableReady = false;
  }

  async _ensureTable() {
    if (this._tableReady) return;
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        stage TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent_id TEXT,
        user_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this._tableReady = true;
  }

  createSession() {
    return randomUUID();
  }

  async persistMessage(sessionId, stage, role, content, agentId = null, userId = null) {
    await this._ensureTable();
    await this._pool.query(
      `INSERT INTO conversations (session_id, stage, role, content, agent_id, user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, stage, role, content, agentId ?? null, userId ?? null, new Date().toISOString()]
    );
  }

  async getHistory(sessionId) {
    await this._ensureTable();
    const { rows } = await this._pool.query(
      'SELECT * FROM conversations WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );
    return rows;
  }

  async getIncompleteSessions() {
    await this._ensureTable();
    const { rows } = await this._pool.query(`
      SELECT
        c.session_id,
        c.stage,
        MAX(c.created_at) AS last_updated
      FROM conversations c
      WHERE c.session_id NOT IN (
        SELECT DISTINCT session_id FROM conversations
        WHERE role = 'system' AND content = '[COMPLETE]'
      )
      GROUP BY c.session_id, c.stage
      ORDER BY last_updated DESC
    `);
    return rows;
  }

  async listSessions(userId) {
    await this._ensureTable();
    const result = await this._pool.query(
      `SELECT session_id, agent_id, user_id,
              MAX(created_at) AS last_updated,
              MIN(created_at) AS started_at
       FROM conversations
       WHERE user_id = $1
       GROUP BY session_id, agent_id, user_id
       ORDER BY last_updated DESC`,
      [userId ?? null]
    );
    return result.rows.map(r => ({
      sessionId: r.session_id,
      agentId: r.agent_id ?? null,
      userId: r.user_id ?? null,
      startedAt: r.started_at,
      lastUpdated: r.last_updated
    }));
  }

  async deleteSession(sessionId, userId) {
    await this._ensureTable();
    const result = await this._pool.query(
      'DELETE FROM conversations WHERE session_id = $1 AND user_id = $2',
      [sessionId, userId ?? null]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getSessionUserId(sessionId) {
    await this._ensureTable();
    const result = await this._pool.query(
      'SELECT user_id FROM conversations WHERE session_id = $1 LIMIT 1',
      [sessionId]
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].user_id ?? null;
  }

  async close() {
    // Pool is shared — not owned by this store, so don't close it here
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build the appropriate ConversationStore from forge config.
 *
 * @param {object} config  — forge.config.json contents
 * @param {import('better-sqlite3').Database|null} db  — required for SQLite store
 * @param {import('pg').Pool|null} pgPool — required for Postgres store
 * @returns {SqliteConversationStore|RedisConversationStore|PostgresConversationStore}
 */
export function makeConversationStore(config, db = null, pgPool = null) {
  const storeType = config?.conversation?.store ?? 'sqlite';

  if (storeType === 'redis') {
    const redisConfig = config?.conversation?.redis ?? {};
    return new RedisConversationStore(redisConfig);
  }

  if (storeType === 'postgres') {
    if (!pgPool) {
      throw new Error('makeConversationStore: Postgres store requires a pgPool instance');
    }
    return new PostgresConversationStore(pgPool);
  }

  if (!db) {
    throw new Error(
      'makeConversationStore: SQLite store requires a db instance'
    );
  }
  return new SqliteConversationStore(db);
}
