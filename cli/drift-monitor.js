/**
 * Drift Monitor — synchronous drift detection and suspect computation.
 *
 * Pure synchronous module. All SQL via direct db.prepare() calls.
 * No imports from db.js — avoids circular dep risk, consistent with codebase.
 */

// ── Rolling average ────────────────────────────────────────────────────────

/**
 * Compute the rolling average pass_rate for a tool over the last N runs.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {number} [windowSize=5]
 * @returns {number|null} Average pass_rate, or null if no runs found
 */
export function computeRollingAverage(db, toolName, windowSize = 5) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT pass_rate FROM eval_runs
      WHERE tool_name = ? AND pass_rate IS NOT NULL AND total_cases > 0
      ORDER BY run_at DESC
      LIMIT ?
    `).all(toolName, windowSize);
  } catch (_) {
    return null;
  }

  if (!rows || rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => acc + (r.pass_rate || 0), 0);
  return sum / rows.length;
}

// ── Suspect computation ────────────────────────────────────────────────────

/**
 * Find tools promoted between the last clean run and the flagged_at timestamp.
 * These tools are suspected of causing drift via description/trigger overlap.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @returns {string[]} List of suspected tool names
 */
export function computeSuspects(db, toolName) {
  let registryRow;
  try {
    registryRow = db.prepare(`SELECT flagged_at, baseline_pass_rate FROM tool_registry WHERE tool_name = ?`).get(toolName);
  } catch (_) {
    return [];
  }

  if (!registryRow || !registryRow.flagged_at) return [];

  // Find the last run where pass_rate >= baseline (last clean run)
  let lastCleanRun;
  try {
    lastCleanRun = db.prepare(`
      SELECT run_at FROM eval_runs
      WHERE tool_name = ?
        AND pass_rate IS NOT NULL
        AND pass_rate >= ?
      ORDER BY run_at DESC
      LIMIT 1
    `).get(toolName, registryRow.baseline_pass_rate ?? 0.8);
  } catch (_) {
    return [];
  }

  const cleanAt = lastCleanRun?.run_at;
  const flaggedAt = registryRow.flagged_at;

  // Tools promoted between last clean run and flagged_at
  try {
    const rows = db.prepare(`
      SELECT tool_name FROM tool_registry
      WHERE tool_name != ?
        AND promoted_at IS NOT NULL
        AND promoted_at > ?
        AND promoted_at <= ?
    `).all(toolName, cleanAt || '1970-01-01', flaggedAt);
    return rows.map((r) => r.tool_name);
  } catch (_) {
    return [];
  }
}

// ── Drift check ────────────────────────────────────────────────────────────

/**
 * Check if a tool is drifting. If drift is detected and no open alert exists,
 * inserts a drift_alert and marks the tool as 'flagged' in tool_registry.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {number} [threshold=0.1] - Minimum pass_rate drop to flag as drift
 * @param {number} [windowSize=5]
 * @returns {{ drifting: boolean, delta: number, suspects: string[], currentRate: number|null }}
 */
export function checkDrift(db, toolName, threshold = 0.1, windowSize = 5) {
  // Get baseline from tool_registry
  let baseline = null;
  try {
    const reg = db.prepare(`SELECT baseline_pass_rate, lifecycle_state FROM tool_registry WHERE tool_name = ?`).get(toolName);
    if (reg) baseline = reg.baseline_pass_rate;
  } catch (_) { /* non-fatal */ }

  const currentRate = computeRollingAverage(db, toolName, windowSize);

  if (baseline == null || currentRate == null) {
    return { drifting: false, delta: 0, suspects: [], currentRate };
  }

  const delta = baseline - currentRate;
  const drifting = delta >= threshold;

  if (!drifting) {
    return { drifting: false, delta, suspects: [], currentRate };
  }

  // Check if open alert already exists
  let openAlert = null;
  try {
    openAlert = db.prepare(`SELECT id FROM drift_alerts WHERE tool_name = ? AND status = 'open'`).get(toolName);
  } catch (_) { /* non-fatal */ }

  const suspects = computeSuspects(db, toolName);

  if (!openAlert) {
    // Insert drift alert + flag the tool atomically — partial writes corrupt drift triangulation
    const now = new Date().toISOString();
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO drift_alerts (tool_name, detected_at, trigger_tools, baseline_rate, current_rate, delta, status)
          VALUES (?, ?, ?, ?, ?, ?, 'open')
        `).run(toolName, now, JSON.stringify(suspects), baseline, currentRate, delta);

        db.prepare(`
          UPDATE tool_registry SET lifecycle_state = 'flagged', flagged_at = ?
          WHERE tool_name = ? AND lifecycle_state != 'flagged'
        `).run(now, toolName);
      })();
    } catch (_) { /* non-fatal */ }
  }

  return { drifting: true, delta, suspects, currentRate };
}

// ── Drift resolution ───────────────────────────────────────────────────────

/**
 * Resolve a drift situation: close the alert, retire the old tool, promote the replacement.
 * All changes run in a transaction for atomicity.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} alertId - The drift_alerts.id to resolve
 * @param {string} replacementToolName - The new tool name to promote
 */
export function resolveDrift(db, alertId, replacementToolName) {
  const now = new Date().toISOString();

  db.transaction(() => {
    // Get alert to find the flagged tool
    const alert = db.prepare(`SELECT tool_name FROM drift_alerts WHERE id = ?`).get(alertId);
    if (!alert) return;

    const oldToolName = alert.tool_name;

    // Resolve the alert
    db.prepare(`UPDATE drift_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(now, alertId);

    // Retire the old tool
    db.prepare(`
      UPDATE tool_registry SET lifecycle_state = 'retired', retired_at = ?, replaced_by = ?
      WHERE tool_name = ?
    `).run(now, replacementToolName, oldToolName);

    // Promote the replacement
    db.prepare(`
      UPDATE tool_registry SET lifecycle_state = 'promoted', promoted_at = ?
      WHERE tool_name = ?
    `).run(now, replacementToolName);
  })();
}
