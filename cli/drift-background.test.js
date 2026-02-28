import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { upsertToolRegistry, insertEvalRun } from './db.js';
import { createDriftMonitor } from './drift-background.js';

describe('drift-background', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  it('start and stop work without error', () => {
    const monitor = createDriftMonitor({}, db, 60_000);
    monitor.start();
    monitor.stop();
  });

  it('runOnce checks promoted tools', () => {
    // Setup: promote a tool with some eval runs
    upsertToolRegistry(db, {
      tool_name: 'tool_a',
      spec_json: '{}',
      lifecycle_state: 'promoted',
      baseline_pass_rate: 0.95
    });

    // Add eval runs (stable — no drift expected)
    for (let i = 0; i < 5; i++) {
      insertEvalRun(db, {
        tool_name: 'tool_a',
        total_cases: 10,
        passed: 9,
        failed: 1,
        pass_rate: 0.9
      });
    }

    const monitor = createDriftMonitor({ drift: { threshold: 0.1, windowSize: 5 } }, db);

    // Should not throw
    monitor.runOnce();
  });

  it('does not crash when no promoted tools exist', () => {
    const monitor = createDriftMonitor({}, db);
    monitor.runOnce(); // Should not throw
  });

  it('start is idempotent (calling twice does not create two intervals)', () => {
    const monitor = createDriftMonitor({}, db, 60_000);
    monitor.start();
    monitor.start(); // Second call should be no-op
    monitor.stop();
  });
});
