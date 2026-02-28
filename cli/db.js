/**
 * SQLite helper for forge eval history.
 * Uses better-sqlite3 (synchronous API).
 *
 * Schema:
 *   eval_runs(id, tool_name, run_at, eval_type, total_cases, passed, failed, notes)
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  run_at TEXT NOT NULL,
  eval_type TEXT DEFAULT 'unknown',
  total_cases INTEGER DEFAULT 0,
  passed INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  notes TEXT
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

CREATE TABLE IF NOT EXISTS eval_run_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_run_id INTEGER NOT NULL,
  case_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  tools_called TEXT,
  latency_ms INTEGER,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  run_at TEXT NOT NULL,
  FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id)
);

CREATE TABLE IF NOT EXISTS drift_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  trigger_tools TEXT,
  baseline_rate REAL,
  current_rate REAL,
  delta REAL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS tool_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  generation_model TEXT,
  eval_model TEXT,
  phases_completed INTEGER DEFAULT 0,
  spec_json TEXT,
  generated_files TEXT,
  status TEXT DEFAULT 'in_progress',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS model_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compared_at TEXT NOT NULL,
  tool_name TEXT,
  model_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  spec_a_json TEXT,
  spec_b_json TEXT,
  chosen_model TEXT,
  phase TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  stage      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_session
  ON conversations(session_id, created_at);

CREATE TABLE IF NOT EXISTS mcp_call_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name   TEXT NOT NULL,
  called_at   TEXT NOT NULL,
  input_json  TEXT,
  output_json TEXT,
  status_code INTEGER,
  latency_ms  INTEGER,
  error       TEXT
);
`;

/**
 * Get (or create) a better-sqlite3 Database instance at the given path.
 * @param {string} dbPath - Absolute or relative path to forge.db
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  // Migrate: add skipped column if it doesn't exist yet
  try {
    db.exec('ALTER TABLE eval_runs ADD COLUMN skipped INTEGER DEFAULT 0');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  // Migrate: add model column
  try {
    db.exec('ALTER TABLE eval_runs ADD COLUMN model TEXT');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  // Migrate: add pass_rate column
  try {
    db.exec('ALTER TABLE eval_runs ADD COLUMN pass_rate REAL');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  // Migrate: add sample_type column
  try {
    db.exec('ALTER TABLE eval_runs ADD COLUMN sample_type TEXT');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  // Migrate: add input_tokens to eval_run_cases
  try {
    db.exec('ALTER TABLE eval_run_cases ADD COLUMN input_tokens INTEGER');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  // Migrate: add output_tokens to eval_run_cases
  try {
    db.exec('ALTER TABLE eval_run_cases ADD COLUMN output_tokens INTEGER');
  } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
  return db;
}

/**
 * Return eval summary grouped by tool_name, including last run time and pass rate.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ tool_name: string; last_run: string; total_cases: number; passed: number; failed: number; pass_rate: string }[]}
 */
export function getEvalSummary(db) {
  const rows = db.prepare(`
    SELECT
      tool_name,
      MAX(run_at) AS last_run,
      SUM(total_cases) AS total_cases,
      SUM(passed) AS passed,
      SUM(failed) AS failed
    FROM eval_runs
    GROUP BY tool_name
    ORDER BY last_run DESC
  `).all();

  return rows.map((r) => ({
    ...r,
    pass_rate: r.total_cases > 0
      ? `${Math.round((r.passed / r.total_cases) * 100)}%`
      : 'N/A'
  }));
}

/**
 * Insert one eval run record.
 * @param {import('better-sqlite3').Database} db
 * @param {{ tool_name: string; eval_type?: string; total_cases?: number; passed?: number; failed?: number; skipped?: number; notes?: string; model?: string; pass_rate?: number; sample_type?: string }} row
 * @returns {number} lastInsertRowid
 */
export function insertEvalRun(db, row) {
  const result = db.prepare(`
    INSERT INTO eval_runs (tool_name, run_at, eval_type, total_cases, passed, failed, skipped, notes, model, pass_rate, sample_type)
    VALUES (@tool_name, @run_at, @eval_type, @total_cases, @passed, @failed, @skipped, @notes, @model, @pass_rate, @sample_type)
  `).run({
    tool_name: row.tool_name,
    run_at: row.run_at ?? new Date().toISOString(),
    eval_type: row.eval_type ?? 'unknown',
    total_cases: row.total_cases ?? 0,
    passed: row.passed ?? 0,
    failed: row.failed ?? 0,
    skipped: row.skipped ?? 0,
    notes: row.notes ?? null,
    model: row.model ?? null,
    pass_rate: row.pass_rate ?? null,
    sample_type: row.sample_type ?? null
  });
  return result.lastInsertRowid;
}

/**
 * Insert a new tool generation record. Returns the new row id.
 * @param {import('better-sqlite3').Database} db
 * @param {{ tool_name: string; started_at?: string; generation_model?: string; eval_model?: string; spec_json?: string; generated_files?: string; status?: string; notes?: string }} row
 * @returns {number} lastInsertRowid
 */
export function insertToolGeneration(db, row) {
  const result = db.prepare(`
    INSERT INTO tool_generations
      (tool_name, started_at, generation_model, eval_model, spec_json, generated_files, status, notes)
    VALUES
      (@tool_name, @started_at, @generation_model, @eval_model, @spec_json, @generated_files, @status, @notes)
  `).run({
    tool_name: row.tool_name,
    started_at: row.started_at ?? new Date().toISOString(),
    generation_model: row.generation_model ?? null,
    eval_model: row.eval_model ?? null,
    spec_json: row.spec_json ?? null,
    generated_files: row.generated_files ?? null,
    status: row.status ?? 'in_progress',
    notes: row.notes ?? null
  });
  return result.lastInsertRowid;
}

/**
 * Update fields on an existing tool generation record.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {Partial<{ completed_at: string; phases_completed: number; spec_json: string; generated_files: string; status: string; notes: string; generation_model: string; eval_model: string }>} updates
 */
export function updateToolGeneration(db, id, updates) {
  const allowed = [
    'completed_at', 'phases_completed', 'spec_json', 'generated_files',
    'status', 'notes', 'generation_model', 'eval_model'
  ];
  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) return;
  const setClauses = fields.map((f) => `${f} = @${f}`).join(', ');
  const params = { id };
  for (const f of fields) params[f] = updates[f];
  db.prepare(`UPDATE tool_generations SET ${setClauses} WHERE id = @id`).run(params);
}

/**
 * Get all tool generation records ordered by started_at DESC.
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function getToolGenerations(db) {
  return db.prepare(`
    SELECT * FROM tool_generations ORDER BY started_at DESC
  `).all();
}

/**
 * Insert a model comparison record. Returns the new row id.
 * @param {import('better-sqlite3').Database} db
 * @param {{ compared_at?: string; tool_name?: string; model_a: string; model_b: string; spec_a_json?: string; spec_b_json?: string; chosen_model?: string; phase?: string }} row
 * @returns {number} lastInsertRowid
 */
export function insertModelComparison(db, row) {
  const result = db.prepare(`
    INSERT INTO model_comparisons
      (compared_at, tool_name, model_a, model_b, spec_a_json, spec_b_json, chosen_model, phase)
    VALUES
      (@compared_at, @tool_name, @model_a, @model_b, @spec_a_json, @spec_b_json, @chosen_model, @phase)
  `).run({
    compared_at: row.compared_at ?? new Date().toISOString(),
    tool_name: row.tool_name ?? null,
    model_a: row.model_a,
    model_b: row.model_b,
    spec_a_json: row.spec_a_json ?? null,
    spec_b_json: row.spec_b_json ?? null,
    chosen_model: row.chosen_model ?? null,
    phase: row.phase ?? null
  });
  return result.lastInsertRowid;
}

/**
 * Get model comparisons for a specific tool, or all rows if toolName is null.
 * @param {import('better-sqlite3').Database} db
 * @param {string | null} toolName
 * @returns {object[]}
 */
export function getModelComparisons(db, toolName) {
  if (toolName == null) {
    return db.prepare(`
      SELECT * FROM model_comparisons ORDER BY compared_at DESC
    `).all();
  }
  return db.prepare(`
    SELECT * FROM model_comparisons WHERE tool_name = ? ORDER BY compared_at DESC
  `).all(toolName);
}

// ── tool_registry ──────────────────────────────────────────────────────────

/**
 * Upsert a row in tool_registry.
 * @param {import('better-sqlite3').Database} db
 * @param {{ tool_name: string; spec_json?: string; lifecycle_state?: string; promoted_at?: string; flagged_at?: string; retired_at?: string; version?: string; replaced_by?: string; baseline_pass_rate?: number }} row
 */
export function upsertToolRegistry(db, row) {
  db.prepare(`
    INSERT INTO tool_registry (tool_name, spec_json, lifecycle_state, promoted_at, flagged_at, retired_at, version, replaced_by, baseline_pass_rate)
    VALUES (@tool_name, @spec_json, @lifecycle_state, @promoted_at, @flagged_at, @retired_at, @version, @replaced_by, @baseline_pass_rate)
    ON CONFLICT(tool_name) DO UPDATE SET
      spec_json = excluded.spec_json,
      lifecycle_state = excluded.lifecycle_state,
      promoted_at = excluded.promoted_at,
      flagged_at = excluded.flagged_at,
      retired_at = excluded.retired_at,
      version = excluded.version,
      replaced_by = excluded.replaced_by,
      baseline_pass_rate = excluded.baseline_pass_rate
  `).run({
    tool_name: row.tool_name,
    spec_json: row.spec_json ?? null,
    lifecycle_state: row.lifecycle_state ?? 'candidate',
    promoted_at: row.promoted_at ?? null,
    flagged_at: row.flagged_at ?? null,
    retired_at: row.retired_at ?? null,
    version: row.version ?? '1.0.0',
    replaced_by: row.replaced_by ?? null,
    baseline_pass_rate: row.baseline_pass_rate ?? null
  });
}

/**
 * Get a single tool_registry row by tool name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @returns {object|null}
 */
export function getToolRegistry(db, toolName) {
  return db.prepare(`SELECT * FROM tool_registry WHERE tool_name = ?`).get(toolName) ?? null;
}

/**
 * Get all tool_registry rows.
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function getAllToolRegistry(db) {
  return db.prepare(`SELECT * FROM tool_registry ORDER BY tool_name`).all();
}

/**
 * Partially update lifecycle fields on a tool_registry row.
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {Partial<{ lifecycle_state: string; promoted_at: string; flagged_at: string; retired_at: string; replaced_by: string; baseline_pass_rate: number }>} updates
 */
export function updateToolLifecycle(db, toolName, updates) {
  const allowed = ['lifecycle_state', 'promoted_at', 'flagged_at', 'retired_at', 'replaced_by', 'baseline_pass_rate'];
  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) return;
  const setClauses = fields.map((f) => `${f} = @${f}`).join(', ');
  const params = { tool_name: toolName };
  for (const f of fields) params[f] = updates[f];
  db.prepare(`UPDATE tool_registry SET ${setClauses} WHERE tool_name = @tool_name`).run(params);
}

// ── eval_run_cases ─────────────────────────────────────────────────────────

/**
 * Batch insert eval run case rows in a transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{ eval_run_id: number; case_id?: string; tool_name: string; status: string; reason?: string; tools_called?: string; latency_ms?: number; model?: string }>} rows
 */
export function insertEvalRunCases(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO eval_run_cases (eval_run_id, case_id, tool_name, status, reason, tools_called, latency_ms, model, input_tokens, output_tokens, run_at)
    VALUES (@eval_run_id, @case_id, @tool_name, @status, @reason, @tools_called, @latency_ms, @model, @input_tokens, @output_tokens, @run_at)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
      stmt.run({
        eval_run_id: row.eval_run_id,
        case_id: row.case_id ?? null,
        tool_name: row.tool_name,
        status: row.status,
        reason: row.reason ?? null,
        tools_called: row.tools_called ?? null,
        latency_ms: row.latency_ms ?? null,
        model: row.model ?? null,
        input_tokens: row.input_tokens ?? null,
        output_tokens: row.output_tokens ?? null,
        run_at: now
      });
    }
  })();
}

/**
 * Get eval run cases for a specific tool (or any tool if toolName is null), with LIMIT.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} toolName - null = any tool
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function getEvalRunCasesByTool(db, toolName, limit = 50) {
  if (toolName == null) {
    return db.prepare(`SELECT * FROM eval_run_cases ORDER BY run_at DESC LIMIT ?`).all(limit);
  }
  return db.prepare(`SELECT * FROM eval_run_cases WHERE tool_name = ? ORDER BY run_at DESC LIMIT ?`).all(toolName, limit);
}

// ── drift_alerts ───────────────────────────────────────────────────────────

/**
 * Insert a drift alert record.
 * @param {import('better-sqlite3').Database} db
 * @param {{ tool_name: string; trigger_tools?: string; baseline_rate?: number; current_rate?: number; delta?: number }} row
 * @returns {number} lastInsertRowid
 */
export function insertDriftAlert(db, row) {
  const result = db.prepare(`
    INSERT INTO drift_alerts (tool_name, detected_at, trigger_tools, baseline_rate, current_rate, delta, status)
    VALUES (@tool_name, @detected_at, @trigger_tools, @baseline_rate, @current_rate, @delta, 'open')
  `).run({
    tool_name: row.tool_name,
    detected_at: new Date().toISOString(),
    trigger_tools: row.trigger_tools ?? null,
    baseline_rate: row.baseline_rate ?? null,
    current_rate: row.current_rate ?? null,
    delta: row.delta ?? null
  });
  return result.lastInsertRowid;
}

/**
 * Get drift alerts — all open alerts if toolName is null, or filtered by tool.
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} toolName - null = all open alerts
 * @returns {object[]}
 */
export function getDriftAlerts(db, toolName) {
  if (toolName == null) {
    return db.prepare(`SELECT * FROM drift_alerts WHERE status = 'open' ORDER BY detected_at DESC`).all();
  }
  return db.prepare(`SELECT * FROM drift_alerts WHERE tool_name = ? AND status = 'open' ORDER BY detected_at DESC`).all(toolName);
}

/**
 * Mark a drift alert as resolved.
 * @param {import('better-sqlite3').Database} db
 * @param {number} alertId
 */
export function resolveDriftAlert(db, alertId) {
  db.prepare(`UPDATE drift_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), alertId);
}

/**
 * Mark a drift alert as dismissed (acknowledged, not fixed).
 * @param {import('better-sqlite3').Database} db
 * @param {number} alertId
 */
export function dismissDriftAlert(db, alertId) {
  db.prepare(`UPDATE drift_alerts SET status = 'dismissed', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), alertId);
}

// ── performance trending ───────────────────────────────────────────────────

/**
 * Get per-tool eval run history for trending (pass_rate over time).
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {number} [windowSize=10]
 * @returns {object[]} rows with run_at, pass_rate, passed, total_cases
 */
export function getPerToolRunHistory(db, toolName, windowSize = 10) {
  return db.prepare(`
    SELECT run_at, pass_rate, passed, total_cases, model
    FROM eval_runs
    WHERE tool_name = ? AND total_cases > 0
    ORDER BY run_at DESC
    LIMIT ?
  `).all(toolName, windowSize);
}

/**
 * Get per-model aggregate stats for a tool's eval cases.
 * Used by the model comparison view.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @returns {Array<{
 *   model: string,
 *   case_count: number,
 *   passed: number,
 *   avg_latency_ms: number,
 *   total_input_tokens: number,
 *   total_output_tokens: number
 * }>}
 */
export function getModelComparisonData(db, toolName) {
  return db.prepare(`
    SELECT
      model,
      COUNT(*) AS case_count,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
      ROUND(AVG(latency_ms)) AS avg_latency_ms,
      SUM(COALESCE(input_tokens, 0)) AS total_input_tokens,
      SUM(COALESCE(output_tokens, 0)) AS total_output_tokens
    FROM eval_run_cases
    WHERE tool_name = ? AND model IS NOT NULL AND status != 'skipped'
    GROUP BY model
    ORDER BY (passed * 1.0 / COUNT(*)) DESC
  `).all(toolName);
}

// ── conversations ───────────────────────────────────────────────────────────

export function createSession() {
  return randomUUID();
}

export function insertConversationMessage(db, { session_id, stage, role, content }) {
  const result = db.prepare(`
    INSERT INTO conversations (session_id, stage, role, content, created_at)
    VALUES (@session_id, @stage, @role, @content, @created_at)
  `).run({
    session_id,
    stage,
    role,
    content,
    created_at: new Date().toISOString()
  });
  return result.lastInsertRowid;
}

export function getConversationHistory(db, session_id) {
  return db.prepare(`
    SELECT * FROM conversations
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(session_id);
}

export function getIncompleteSessions(db) {
  return db.prepare(`
    SELECT
      c.session_id,
      c.stage,
      MAX(c.created_at) AS last_updated
    FROM conversations c
    WHERE c.session_id NOT IN (
      SELECT DISTINCT session_id
      FROM conversations
      WHERE role = 'system' AND content = '[COMPLETE]'
    )
    GROUP BY c.session_id
    ORDER BY last_updated DESC
  `).all();
}

// ── mcp_call_log ───────────────────────────────────────────────────────────

export function insertMcpCallLog(db, row) {
  const result = db.prepare(`
    INSERT INTO mcp_call_log (tool_name, called_at, input_json, output_json, status_code, latency_ms, error)
    VALUES (@tool_name, @called_at, @input_json, @output_json, @status_code, @latency_ms, @error)
  `).run({
    tool_name: row.tool_name,
    called_at: new Date().toISOString(),
    input_json: row.input_json ?? null,
    output_json: row.output_json ?? null,
    status_code: row.status_code ?? null,
    latency_ms: row.latency_ms ?? null,
    error: row.error ?? null
  });
  return result.lastInsertRowid;
}

export function getMcpCallLog(db, toolName = null, limit = 50) {
  if (toolName == null) {
    return db.prepare(`SELECT * FROM mcp_call_log ORDER BY id DESC LIMIT ?`).all(limit);
  }
  return db.prepare(`SELECT * FROM mcp_call_log WHERE tool_name = ? ORDER BY id DESC LIMIT ?`).all(toolName, limit);
}
