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
