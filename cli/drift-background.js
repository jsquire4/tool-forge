/**
 * Background Drift Monitor — periodically checks all promoted tools for drift.
 *
 * Reuses checkDrift() and computeSuspects() from cli/drift-monitor.js.
 * Started in forge-service.js when --mode=sidecar.
 */

import { getAllToolRegistry, insertDriftAlert } from './db.js';
import { checkDrift, computeSuspects } from './drift-monitor.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a background drift monitor.
 *
 * @param {object} config — forge config (drift.threshold, drift.windowSize)
 * @param {import('better-sqlite3').Database} db
 * @param {number} [intervalMs] — check interval (default 5 min)
 * @returns {{ start(): void, stop(): void, runOnce(): void }}
 */
export function createDriftMonitor(config, db, intervalMs = DEFAULT_INTERVAL_MS) {
  let timer = null;
  const threshold = config.drift?.threshold ?? 0.1;
  const windowSize = config.drift?.windowSize ?? 5;

  function runOnce() {
    try {
      const tools = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
      for (const tool of tools) {
        const drift = checkDrift(db, tool.tool_name, threshold, windowSize);
        if (drift.drifted) {
          const suspects = computeSuspects(db, tool.tool_name);
          insertDriftAlert(db, {
            tool_name: tool.tool_name,
            trigger_tools: suspects.map(s => s.tool_name).join(','),
            baseline_rate: drift.baseline,
            current_rate: drift.current,
            delta: drift.delta
          });
        }
      }
    } catch (err) {
      process.stderr.write(`[drift-monitor] Error during check: ${err.message}\n`);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(runOnce, intervalMs);
      timer.unref(); // Don't block process exit
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce
  };
}
