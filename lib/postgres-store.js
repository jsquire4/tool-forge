/**
 * PostgresStore — Postgres-backed storage adapter for horizontal scaling.
 *
 * Mirrors the SQLite query function signatures from db.js but uses the `pg` Pool.
 * Optional — only loaded when conversation.store === 'postgres' in config.
 * Requires: npm install pg
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id                TEXT PRIMARY KEY,
  display_name            TEXT NOT NULL,
  description             TEXT,
  system_prompt           TEXT,
  default_model           TEXT,
  default_hitl_level      TEXT CHECK(default_hitl_level IN ('autonomous','cautious','standard','paranoid')),
  allow_user_model_select INTEGER NOT NULL DEFAULT 0,
  allow_user_hitl_config  INTEGER NOT NULL DEFAULT 0,
  tool_allowlist          TEXT NOT NULL DEFAULT '*',
  max_turns               INTEGER,
  max_tokens              INTEGER,
  is_default              INTEGER NOT NULL DEFAULT 0,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  seeded_from_config      INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

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
    return rows[0]?.id ?? null;
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
    return rows[0]?.id ?? null;
  }
}

// ── PostgresPromptStore ────────────────────────────────────────────────────

/**
 * Postgres-backed PromptStore — same interface as PromptStore in prompt-store.js.
 * Uses an existing pg.Pool instance (created by buildSidecarContext).
 */
export class PostgresPromptStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this._pool = pool;
  }

  async getActivePrompt() {
    const { rows } = await this._pool.query(
      'SELECT * FROM prompt_versions WHERE is_active = 1 LIMIT 1'
    );
    const row = rows[0] ?? null;
    return row ? row.content : '';
  }

  async getAllVersions() {
    const { rows } = await this._pool.query(
      'SELECT * FROM prompt_versions ORDER BY id DESC'
    );
    return rows;
  }

  async createVersion(version, content, notes = null) {
    const { rows } = await this._pool.query(
      `INSERT INTO prompt_versions (version, content, is_active, created_at, notes)
       VALUES ($1, $2, 0, $3, $4) RETURNING id`,
      [version, content, new Date().toISOString(), notes]
    );
    return rows[0]?.id ?? null;
  }

  async activate(id) {
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

  async getVersion(id) {
    const { rows } = await this._pool.query(
      'SELECT * FROM prompt_versions WHERE id = $1', [id]
    );
    return rows[0] ?? null;
  }
}

// ── PostgresPreferenceStore ────────────────────────────────────────────────

const VALID_HITL_LEVELS_PG = ['autonomous', 'cautious', 'standard', 'paranoid'];

/**
 * Postgres-backed PreferenceStore — same interface as PreferenceStore in preference-store.js.
 */
export class PostgresPreferenceStore {
  /**
   * @param {import('pg').Pool} pool
   * @param {object} config — forge config (for detectProvider / resolveApiKey)
   * @param {object} [env] — environment variables
   */
  constructor(pool, config = {}, env = {}) {
    this._pool = pool;
    this._config = config;
    this._env = env;
  }

  async getUserPreferences(userId) {
    const { rows } = await this._pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1', [userId]
    );
    const row = rows[0] ?? null;
    if (!row) return null;
    return { model: row.model, hitlLevel: row.hitl_level };
  }

  async setUserPreferences(userId, prefs) {
    if (prefs.hitlLevel && !VALID_HITL_LEVELS_PG.includes(prefs.hitlLevel)) {
      throw new Error(`Invalid hitlLevel: ${prefs.hitlLevel}. Must be one of: ${VALID_HITL_LEVELS_PG.join(', ')}`);
    }
    await this._pool.query(
      `INSERT INTO user_preferences (user_id, model, hitl_level, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         model = $2, hitl_level = $3, updated_at = $4`,
      [userId, prefs.model ?? null, prefs.hitlLevel ?? null, new Date().toISOString()]
    );
  }

  async resolveEffective(userId, config, env = {}) {
    const { detectProvider, resolveApiKey } = await import('./api-client.js');
    const userPrefs = await this.getUserPreferences(userId);
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

// ── PostgresAgentRegistry ──────────────────────────────────────────────────

/**
 * Postgres-backed AgentRegistry — same interface as AgentRegistry in agent-registry.js.
 */
export class PostgresAgentRegistry {
  /**
   * @param {object} config — merged forge config
   * @param {import('pg').Pool} pool
   */
  constructor(config, pool) {
    this._config = config;
    this._pool = pool;
  }

  async resolveAgent(agentId) {
    if (!agentId) {
      const { rows } = await this._pool.query(
        'SELECT * FROM agent_registry WHERE is_default = 1 AND enabled = 1 LIMIT 1'
      );
      return rows[0] ?? null;
    }
    const { rows } = await this._pool.query(
      'SELECT * FROM agent_registry WHERE agent_id = $1', [agentId]
    );
    const agent = rows[0] ?? null;
    if (!agent || !agent.enabled) return null;
    return agent;
  }

  filterTools(loaded, agent) {
    if (!agent) return loaded;
    const allowlist = agent.tool_allowlist;
    if (!allowlist || allowlist === '*') return loaded;
    let allowed;
    try { allowed = JSON.parse(allowlist); } catch { return { toolRows: [], tools: [] }; }
    if (!Array.isArray(allowed)) return { toolRows: [], tools: [] };
    const allowSet = new Set(allowed);
    return {
      toolRows: loaded.toolRows.filter(r => allowSet.has(r.tool_name)),
      tools: loaded.tools.filter(t => allowSet.has(t.name))
    };
  }

  buildAgentConfig(baseConfig, agent) {
    if (!agent) return baseConfig;
    const scoped = { ...baseConfig };
    if (agent.default_model) scoped.defaultModel = agent.default_model;
    if (agent.default_hitl_level) scoped.defaultHitlLevel = agent.default_hitl_level;
    if (agent.allow_user_model_select) scoped.allowUserModelSelect = true;
    if (agent.allow_user_hitl_config) scoped.allowUserHitlConfig = true;
    if (agent.max_turns != null) scoped.maxTurns = agent.max_turns;
    if (agent.max_tokens != null) scoped.maxTokens = agent.max_tokens;
    return scoped;
  }

  async resolveSystemPrompt(agent, promptStore, config) {
    if (agent?.system_prompt) return agent.system_prompt;
    const active = typeof promptStore.getActivePrompt === 'function'
      ? await promptStore.getActivePrompt()
      : null;
    if (active) return active;
    return config.systemPrompt || 'You are a helpful assistant.';
  }

  async getAgent(agentId) {
    const { rows } = await this._pool.query(
      'SELECT * FROM agent_registry WHERE agent_id = $1', [agentId]
    );
    return rows[0] ?? null;
  }

  async getAllAgents() {
    const { rows } = await this._pool.query(
      'SELECT * FROM agent_registry ORDER BY display_name'
    );
    return rows;
  }

  async upsertAgent(row) {
    const now = new Date().toISOString();
    await this._pool.query(
      `INSERT INTO agent_registry
         (agent_id, display_name, description, system_prompt, default_model,
          default_hitl_level, allow_user_model_select, allow_user_hitl_config,
          tool_allowlist, max_turns, max_tokens, is_default, enabled, seeded_from_config,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(agent_id) DO UPDATE SET
         display_name = $2, description = $3, system_prompt = $4, default_model = $5,
         default_hitl_level = $6, allow_user_model_select = $7, allow_user_hitl_config = $8,
         tool_allowlist = $9, max_turns = $10, max_tokens = $11, is_default = $12,
         enabled = $13, seeded_from_config = $14, updated_at = $16`,
      [
        row.agent_id, row.display_name, row.description ?? null, row.system_prompt ?? null,
        row.default_model ?? null, row.default_hitl_level ?? null,
        row.allow_user_model_select ?? 0, row.allow_user_hitl_config ?? 0,
        row.tool_allowlist ?? '*', row.max_turns ?? null, row.max_tokens ?? null,
        row.is_default ?? 0, row.enabled ?? 1, row.seeded_from_config ?? 0, now, now
      ]
    );
  }

  async setDefault(agentId) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT 1 FROM agent_registry WHERE agent_id = $1 AND enabled = 1', [agentId]
      );
      if (rows.length === 0) { await client.query('ROLLBACK'); return; }
      await client.query('UPDATE agent_registry SET is_default = 0 WHERE is_default = 1');
      await client.query(
        'UPDATE agent_registry SET is_default = 1, updated_at = $1 WHERE agent_id = $2',
        [new Date().toISOString(), agentId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteAgent(agentId) {
    await this._pool.query('DELETE FROM agent_registry WHERE agent_id = $1', [agentId]);
  }

  async seedFromConfig() {
    const agents = this._config.agents;
    if (!Array.isArray(agents) || agents.length === 0) return;

    let defaultAgentId = null;
    for (const a of agents) {
      if (!a.id || !a.displayName) continue;
      const existing = await this.getAgent(a.id);
      if (existing && !existing.seeded_from_config) continue;
      await this.upsertAgent({
        agent_id: a.id,
        display_name: a.displayName,
        description: a.description ?? null,
        system_prompt: a.systemPrompt ?? null,
        default_model: a.defaultModel ?? null,
        default_hitl_level: a.defaultHitlLevel ?? null,
        allow_user_model_select: a.allowUserModelSelect ? 1 : 0,
        allow_user_hitl_config: a.allowUserHitlConfig ? 1 : 0,
        tool_allowlist: Array.isArray(a.toolAllowlist) ? JSON.stringify(a.toolAllowlist) : '*',
        max_turns: a.maxTurns ?? null,
        max_tokens: a.maxTokens ?? null,
        is_default: 0,
        enabled: 1,
        seeded_from_config: 1
      });
      if (a.isDefault) defaultAgentId = a.id;
    }

    if (defaultAgentId) {
      await this.setDefault(defaultAgentId);
    } else {
      const defaultAgent = await this.resolveAgent(null);
      if (!defaultAgent) {
        const first = agents.find(a => a.id && a.displayName);
        if (first) await this.setDefault(first.id);
      }
    }
  }
}
