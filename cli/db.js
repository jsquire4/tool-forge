/**
 * SQLite helper for forge eval history.
 * Uses better-sqlite3 (synchronous API).
 *
 * Schema:
 *   eval_runs(id, tool_name, run_at, eval_type, total_cases, passed, failed, notes)
 */

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
  notes TEXT
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
`;

/**
 * Get (or create) a better-sqlite3 Database instance at the given path.
 * @param {string} dbPath - Absolute or relative path to forge.db
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(SCHEMA);
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
 * @param {{ tool_name: string; eval_type?: string; total_cases?: number; passed?: number; failed?: number; notes?: string }} row
 * @returns {import('better-sqlite3').RunResult}
 */
export function insertEvalRun(db, row) {
  return db.prepare(`
    INSERT INTO eval_runs (tool_name, run_at, eval_type, total_cases, passed, failed, notes)
    VALUES (@tool_name, @run_at, @eval_type, @total_cases, @passed, @failed, @notes)
  `).run({
    tool_name: row.tool_name,
    run_at: row.run_at ?? new Date().toISOString(),
    eval_type: row.eval_type ?? 'unknown',
    total_cases: row.total_cases ?? 0,
    passed: row.passed ?? 0,
    failed: row.failed ?? 0,
    notes: row.notes ?? null
  });
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
