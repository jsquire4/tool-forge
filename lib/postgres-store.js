/**
 * PostgresStore — Postgres-backed storage adapter for horizontal scaling.
 *
 * Mirrors the SQLite query function signatures from db.js but uses the `pg` Pool.
 * Optional — only loaded when conversation.store === 'postgres' in config.
 * Requires: npm install pg
 */

export const SCHEMA = `
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

-- eval_runs
CREATE TABLE IF NOT EXISTS eval_runs (
  id SERIAL PRIMARY KEY,
  tool_name TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT now()::text,
  eval_type TEXT DEFAULT 'unknown',
  total_cases INTEGER DEFAULT 0,
  passed INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  notes TEXT,
  model TEXT,
  pass_rate REAL,
  sample_type TEXT
);

CREATE TABLE IF NOT EXISTS eval_run_cases (
  id SERIAL PRIMARY KEY,
  eval_run_id INTEGER NOT NULL REFERENCES eval_runs(id),
  case_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  tools_called TEXT,
  latency_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  run_at TEXT NOT NULL
);

-- chat_audit
CREATE TABLE IF NOT EXISTS chat_audit (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  model TEXT,
  message_text TEXT,
  tool_count INTEGER DEFAULT 0,
  hitl_triggered INTEGER DEFAULT 0,
  warnings_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_audit_user ON chat_audit(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_audit_session ON chat_audit(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_audit_status ON chat_audit(status_code, created_at);

-- verifier_registry / bindings
CREATE TABLE IF NOT EXISTS verifier_registry (
  id SERIAL PRIMARY KEY,
  verifier_name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  type TEXT NOT NULL CHECK(type IN ('schema','pattern','custom')),
  aciru_category TEXT NOT NULL DEFAULT 'U',
  aciru_order TEXT NOT NULL DEFAULT 'U-9999',
  spec_json TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  role TEXT DEFAULT 'any',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifier_tool_bindings (
  id SERIAL PRIMARY KEY,
  verifier_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(verifier_name, tool_name),
  FOREIGN KEY (verifier_name) REFERENCES verifier_registry(verifier_name)
);
CREATE INDEX IF NOT EXISTS idx_vtb_tool_name
  ON verifier_tool_bindings(tool_name, verifier_name);
`;

export class PostgresStore {
  /**
   * @param {{ connectionString: string }} pgConfig
   */
  constructor(pgConfig) {
    this._pgConfig = pgConfig;
    this._pool = null;
  }

  async connect(existingPool = null) {
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error('PostgresStore requires the "pg" package: run `npm install pg`');
    }
    const Pool = pg.default?.Pool ?? pg.Pool;
    this._pool = existingPool ?? new Pool({ connectionString: this._pgConfig.connectionString });
    await this._pool.query(SCHEMA);
    return this;
  }

  async close() {
    if (this._pool) {
      await this._pool.end();
      this._pool = null;
    }
  }

  // ── Tool registry ─────────────────────────────────────────────────────

  async getPromotedTools() {
    const { rows } = await this._pool.query(
      "SELECT * FROM tool_registry WHERE lifecycle_state = 'promoted' ORDER BY tool_name"
    );
    return rows;
  }

  async upsertToolRegistry(row) {
    await this._pool.query(
      `INSERT INTO tool_registry
         (tool_name, spec_json, lifecycle_state, version, replaced_by, baseline_pass_rate,
          promoted_at, flagged_at, retired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tool_name) DO UPDATE SET
         spec_json=EXCLUDED.spec_json,
         lifecycle_state=EXCLUDED.lifecycle_state,
         version=EXCLUDED.version,
         replaced_by=EXCLUDED.replaced_by,
         baseline_pass_rate=EXCLUDED.baseline_pass_rate,
         promoted_at=EXCLUDED.promoted_at,
         flagged_at=EXCLUDED.flagged_at,
         retired_at=EXCLUDED.retired_at`,
      [row.tool_name,
       typeof row.spec_json === 'string' ? row.spec_json : JSON.stringify(row.spec_json ?? {}),
       row.lifecycle_state ?? 'candidate', row.version ?? '1.0.0',
       row.replaced_by ?? null, row.baseline_pass_rate ?? null,
       row.promoted_at ?? null, row.flagged_at ?? null, row.retired_at ?? null]
    );
  }

  async getToolRegistry(toolName) {
    const { rows } = await this._pool.query(
      `SELECT * FROM tool_registry WHERE tool_name = $1`, [toolName]);
    return rows[0] ?? null;
  }

  async getAllToolRegistry() {
    const { rows } = await this._pool.query(`SELECT * FROM tool_registry`);
    return rows;
  }

  async updateToolLifecycle(toolName, updates) {
    const ALLOWED_LIFECYCLE_COLS = new Set([
      'lifecycle_state', 'promoted_at', 'flagged_at', 'retired_at', 'replaced_by', 'baseline_pass_rate'
    ]);
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) {
      if (!ALLOWED_LIFECYCLE_COLS.has(k)) continue;
      sets.push(`${k} = $${i++}`);
      vals.push(v);
    }
    if (!sets.length) return;
    vals.push(toolName);
    await this._pool.query(
      `UPDATE tool_registry SET ${sets.join(', ')} WHERE tool_name = $${i}`, vals);
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

// ── PostgresEvalStore ──────────────────────────────────────────────────────

export class PostgresEvalStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) { this._pool = pool; }

  async insertEvalRun(row) {
    const now = new Date().toISOString();
    const { rows } = await this._pool.query(
      `INSERT INTO eval_runs
         (tool_name, run_at, eval_type, total_cases, passed, failed, skipped,
          notes, model, pass_rate, sample_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [row.tool_name, now, row.eval_type ?? 'unknown', row.total_cases ?? 0,
       row.passed ?? 0, row.failed ?? 0, row.skipped ?? 0,
       row.notes ?? null, row.model ?? null, row.pass_rate ?? null,
       row.sample_type ?? null]
    );
    return rows[0]?.id ?? null;
  }

  async insertEvalRunCases(rows) {
    if (!rows?.length) return;
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows) {
        await client.query(
          `INSERT INTO eval_run_cases
             (eval_run_id, case_id, tool_name, status, reason,
              tools_called, latency_ms, model, input_tokens, output_tokens, run_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [r.eval_run_id, r.case_id ?? null, r.tool_name, r.status,
           r.reason ?? null, r.tools_called ?? null, r.latency_ms ?? null,
           r.model ?? null, r.input_tokens ?? null, r.output_tokens ?? null,
           r.run_at ?? new Date().toISOString()]
        );
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async getEvalSummary() {
    const { rows } = await this._pool.query(
      `SELECT tool_name,
              MAX(run_at) AS last_run,
              SUM(total_cases) AS total_cases,
              SUM(passed) AS passed,
              SUM(failed) AS failed,
              ROUND(CAST(SUM(passed) AS NUMERIC) /
                    NULLIF(SUM(passed)+SUM(failed),0) * 100, 1)::text AS pass_rate
       FROM eval_runs GROUP BY tool_name ORDER BY tool_name`
    );
    return rows;
  }

  async getPerToolRunHistory(toolName, windowSize = 10) {
    const { rows } = await this._pool.query(
      `SELECT run_at, pass_rate, passed, total_cases, model
       FROM eval_runs
       WHERE tool_name = $1
       ORDER BY run_at DESC LIMIT $2`,
      [toolName, windowSize]
    );
    return rows;
  }

  async listRuns(limit = 50, offset = 0) {
    const { rows } = await this._pool.query(
      `SELECT * FROM eval_runs ORDER BY run_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }
}

// ── PostgresChatAuditStore ─────────────────────────────────────────────────

export class PostgresChatAuditStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) { this._pool = pool; }

  async insertChatAudit(row) {
    const now = new Date().toISOString();
    const { rows } = await this._pool.query(
      `INSERT INTO chat_audit
         (session_id, user_id, agent_id, route, status_code, duration_ms,
          model, message_text, tool_count, hitl_triggered, warnings_count,
          error_message, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [row.session_id ?? '', row.user_id ?? 'anon', row.agent_id ?? null,
       row.route, row.status_code, row.duration_ms,
       row.model ?? null, row.message_text ?? null,
       row.tool_count ?? 0, row.hitl_triggered ?? 0, row.warnings_count ?? 0,
       row.error_message ?? null, now]
    );
    return rows[0]?.id ?? null;
  }

  async getStats() {
    const { rows } = await this._pool.query(`
      SELECT
        COUNT(*) AS total_sessions,
        COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
        COALESCE(
          COUNT(*) FILTER (WHERE status_code >= 400)::float / NULLIF(COUNT(*), 0),
          0
        ) AS error_rate,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS messages_today
      FROM chat_audit
    `);
    const row = rows[0];
    return {
      totalSessions: parseInt(row.total_sessions, 10),
      avgDurationMs: Math.round(parseFloat(row.avg_duration_ms)),
      errorRate: parseFloat(row.error_rate),
      messagesToday: parseInt(row.messages_today, 10)
    };
  }

  async getSessions(limit = 20, offset = 0) {
    const { rows } = await this._pool.query(
      `SELECT * FROM chat_audit ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows;
  }
}

// ── PostgresVerifierStore ──────────────────────────────────────────────────

export class PostgresVerifierStore {
  /** @param {import('pg').Pool} pool */
  constructor(pool) { this._pool = pool; }

  async upsertVerifier(row) {
    const now = new Date().toISOString();
    // $10 = now; used for both created_at and updated_at on INSERT
    await this._pool.query(
      `INSERT INTO verifier_registry
         (verifier_name, display_name, type, aciru_category, aciru_order,
          spec_json, description, enabled, role, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT (verifier_name) DO UPDATE SET
         display_name=EXCLUDED.display_name, type=EXCLUDED.type,
         aciru_category=EXCLUDED.aciru_category, aciru_order=EXCLUDED.aciru_order,
         spec_json=EXCLUDED.spec_json, description=EXCLUDED.description,
         enabled=EXCLUDED.enabled, role=EXCLUDED.role, updated_at=EXCLUDED.updated_at`,
      [row.verifier_name, row.display_name ?? null, row.type,
       row.aciru_category ?? 'U', row.aciru_order ?? 'U-9999',
       typeof row.spec_json === 'string' ? row.spec_json : JSON.stringify(row.spec_json),
       row.description ?? null, row.enabled ?? 1, row.role ?? 'any', now]
    );
  }

  async getVerifier(name) {
    const { rows } = await this._pool.query(
      `SELECT * FROM verifier_registry WHERE verifier_name = $1`, [name]);
    return rows[0] ?? null;
  }

  async getAllVerifiers() {
    const { rows } = await this._pool.query(
      `SELECT * FROM verifier_registry WHERE enabled = 1 ORDER BY aciru_order ASC`);
    return rows;
  }

  async deleteVerifier(name) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM verifier_tool_bindings WHERE verifier_name = $1`, [name]);
      await client.query(`DELETE FROM verifier_registry WHERE verifier_name = $1`, [name]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async upsertVerifierBinding(binding) {
    const now = new Date().toISOString();
    await this._pool.query(
      `INSERT INTO verifier_tool_bindings (verifier_name, tool_name, enabled, created_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (verifier_name, tool_name) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [binding.verifier_name, binding.tool_name, binding.enabled ?? 1, now]
    );
  }

  async removeVerifierBinding(verifierName, toolName) {
    await this._pool.query(
      `DELETE FROM verifier_tool_bindings WHERE verifier_name=$1 AND tool_name=$2`,
      [verifierName, toolName]
    );
  }

  async getVerifiersForTool(toolName) {
    const { rows } = await this._pool.query(
      `SELECT vr.* FROM verifier_registry vr
       JOIN verifier_tool_bindings vtb USING (verifier_name)
       WHERE vtb.tool_name = $1 AND vtb.enabled = 1 AND vr.enabled = 1
       ORDER BY vr.aciru_order ASC`,
      [toolName]
    );
    return rows;
  }

  async getBindingsForVerifier(verifierName) {
    const { rows } = await this._pool.query(
      `SELECT * FROM verifier_tool_bindings WHERE verifier_name = $1`, [verifierName]);
    return rows;
  }

  async insertVerifierResult(row) {
    const { rows } = await this._pool.query(
      `INSERT INTO verifier_results
         (session_id, tool_name, verifier_name, outcome, message, tool_call_input, tool_call_output, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [row.session_id ?? null, row.tool_name, row.verifier_name, row.outcome,
       row.message ?? null, row.tool_call_input ?? null, row.tool_call_output ?? null,
       new Date().toISOString()]
    );
    return rows[0]?.id ?? null;
  }

  async getResults(toolName = null, limit = 100) {
    if (toolName) {
      const { rows } = await this._pool.query(
        `SELECT * FROM verifier_results WHERE tool_name = $1 ORDER BY created_at DESC LIMIT $2`,
        [toolName, limit]
      );
      return rows;
    }
    const { rows } = await this._pool.query(
      `SELECT * FROM verifier_results ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  }
}
