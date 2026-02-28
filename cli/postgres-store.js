/**
 * PostgresStore — Postgres-backed storage adapter for horizontal scaling.
 *
 * Mirrors the SQLite query function signatures from db.js but uses the `pg` Pool.
 * Optional — only loaded when conversation.store === 'postgres' in config.
 * Requires: npm install pg
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompt_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  model TEXT,
  hitl_level TEXT CHECK(hitl_level IN ('autonomous','cautious','standard','paranoid')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_registry (
  tool_name TEXT PRIMARY KEY,
  spec_json TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'candidate',
  promoted_at TEXT,
  flagged_at TEXT,
  retired_at TEXT,
  version TEXT DEFAULT '1.0.0',
  replaced_by TEXT,
  baseline_pass_rate REAL
);

CREATE TABLE IF NOT EXISTS verifier_results (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  verifier_name TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('pass','warn','block')),
  message TEXT,
  tool_call_input TEXT,
  tool_call_output TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verifier_results_tool
  ON verifier_results(tool_name, created_at);
`;

export class PostgresStore {
  /**
   * @param {{ connectionString: string }} pgConfig
   */
  constructor(pgConfig) {
    this._pgConfig = pgConfig;
    this._pool = null;
  }

  async connect() {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('PostgresStore requires the "pg" package: run `npm install pg`');
    }
    const Pool = pg.default?.Pool ?? pg.Pool;
    this._pool = new Pool({ connectionString: this._pgConfig.connectionString });
    await this._pool.query(SCHEMA);
    return this;
  }

  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }

  // ── Prompt versions ───────────────────────────────────────────────────

  async getActivePrompt() {
    const { rows } = await this._pool.query(
      'SELECT * FROM prompt_versions WHERE is_active = 1 LIMIT 1'
    );
    return rows[0] ?? null;
  }

  async insertPromptVersion(row) {
    const { rows } = await this._pool.query(
      `INSERT INTO prompt_versions (version, content, is_active, created_at, notes)
       VALUES ($1, $2, 0, $3, $4) RETURNING id`,
      [row.version, row.content, new Date().toISOString(), row.notes ?? null]
    );
    return rows[0].id;
  }

  async activatePromptVersion(id) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE prompt_versions SET is_active = 0, activated_at = NULL WHERE is_active = 1');
      await client.query('UPDATE prompt_versions SET is_active = 1, activated_at = $1 WHERE id = $2',
        [new Date().toISOString(), id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── User preferences ──────────────────────────────────────────────────

  async getUserPreferences(userId) {
    const { rows } = await this._pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1', [userId]
    );
    return rows[0] ?? null;
  }

  async upsertUserPreferences(userId, prefs) {
    await this._pool.query(
      `INSERT INTO user_preferences (user_id, model, hitl_level, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         model = $2, hitl_level = $3, updated_at = $4`,
      [userId, prefs.model ?? null, prefs.hitlLevel ?? null, new Date().toISOString()]
    );
  }

  // ── Tool registry (read-only from sidecar) ────────────────────────────

  async getPromotedTools() {
    const { rows } = await this._pool.query(
      "SELECT * FROM tool_registry WHERE lifecycle_state = 'promoted' ORDER BY tool_name"
    );
    return rows;
  }

  // ── Verifier results ──────────────────────────────────────────────────

  async insertVerifierResult(row) {
    const { rows } = await this._pool.query(
      `INSERT INTO verifier_results
         (session_id, tool_name, verifier_name, outcome, message, tool_call_input, tool_call_output, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        row.session_id ?? null, row.tool_name, row.verifier_name, row.outcome,
        row.message ?? null, row.tool_call_input ?? null, row.tool_call_output ?? null,
        new Date().toISOString()
      ]
    );
    return rows[0].id;
  }
}
