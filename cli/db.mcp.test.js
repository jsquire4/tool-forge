import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { insertMcpCallLog, getMcpCallLog, getDb } from './db.js';

describe('mcp_call_log DB helpers', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('insertMcpCallLog inserts and returns id', () => {
    const id = insertMcpCallLog(db, {
      tool_name: 'get_portfolio_summary',
      input_json: JSON.stringify({ userId: '123' }),
      output_json: JSON.stringify({ total: 1000 }),
      status_code: 200,
      latency_ms: 42,
      error: null
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('getMcpCallLog(db, toolName) returns rows ordered DESC', () => {
    insertMcpCallLog(db, { tool_name: 'get_portfolio_summary', input_json: '{}', status_code: 200, latency_ms: 10 });
    insertMcpCallLog(db, { tool_name: 'get_portfolio_summary', input_json: '{}', status_code: 404, latency_ms: 5 });
    insertMcpCallLog(db, { tool_name: 'get_holdings', input_json: '{}', status_code: 200, latency_ms: 7 });

    const rows = getMcpCallLog(db, 'get_portfolio_summary');
    expect(rows.length).toBe(2);
    // Should be ordered DESC by id (most recent first)
    expect(rows[0].status_code).toBe(404);
    expect(rows[1].status_code).toBe(200);
    // All should be for the specified tool
    for (const row of rows) {
      expect(row.tool_name).toBe('get_portfolio_summary');
    }
  });

  it('getMcpCallLog(db, null) returns all rows', () => {
    insertMcpCallLog(db, { tool_name: 'tool_a', input_json: '{}', status_code: 200, latency_ms: 10 });
    insertMcpCallLog(db, { tool_name: 'tool_b', input_json: '{}', status_code: 200, latency_ms: 5 });
    insertMcpCallLog(db, { tool_name: 'tool_c', input_json: '{}', status_code: 500, latency_ms: 1 });

    const rows = getMcpCallLog(db, null);
    expect(rows.length).toBe(3);
  });

  it('empty result returns []', () => {
    const rows = getMcpCallLog(db, 'nonexistent_tool');
    expect(rows).toEqual([]);
  });

  it('getMcpCallLog respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      insertMcpCallLog(db, { tool_name: 'my_tool', input_json: '{}', status_code: 200, latency_ms: i });
    }
    const rows = getMcpCallLog(db, 'my_tool', 3);
    expect(rows.length).toBe(3);
  });

  it('getDb is idempotent (no error on second call with same :memory: is different instance, but same path works)', () => {
    // Create a second DB instance with same path pattern — shouldn't throw
    expect(() => {
      const db2 = getDb(':memory:');
      db2.close();
    }).not.toThrow();
  });

  it('insertMcpCallLog sets called_at automatically', () => {
    const before = new Date().toISOString();
    insertMcpCallLog(db, { tool_name: 'my_tool', status_code: 200, latency_ms: 1 });
    const after = new Date().toISOString();

    const rows = getMcpCallLog(db, 'my_tool');
    expect(rows.length).toBe(1);
    expect(rows[0].called_at >= before).toBe(true);
    expect(rows[0].called_at <= after).toBe(true);
  });

  it('insertMcpCallLog handles null optional fields', () => {
    const id = insertMcpCallLog(db, {
      tool_name: 'minimal_tool',
      status_code: 0,
      latency_ms: 0,
      error: 'Connection refused'
    });
    expect(id).toBeGreaterThan(0);
    const rows = getMcpCallLog(db, 'minimal_tool');
    expect(rows[0].input_json).toBeNull();
    expect(rows[0].output_json).toBeNull();
    expect(rows[0].error).toBe('Connection refused');
  });
});
