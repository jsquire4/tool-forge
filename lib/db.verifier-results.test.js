import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { insertVerifierResult, getVerifierResultsByTool } from './db.js';

describe('verifier_results', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  it('insert + query round-trip', () => {
    insertVerifierResult(db, {
      session_id: 'sess-1',
      tool_name: 'get_weather',
      verifier_name: 'schema-check',
      outcome: 'pass',
      message: 'All good',
      tool_call_input: '{"city":"NYC"}',
      tool_call_output: '{"temp":72}'
    });

    const results = getVerifierResultsByTool(db, 'get_weather');
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('pass');
    expect(results[0].verifier_name).toBe('schema-check');
    expect(results[0].session_id).toBe('sess-1');
  });

  it('rejects invalid outcome via CHECK constraint', () => {
    expect(() => {
      insertVerifierResult(db, {
        tool_name: 'get_weather',
        verifier_name: 'check',
        outcome: 'invalid'
      });
    }).toThrow();
  });

  it('getVerifierResultsByTool respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertVerifierResult(db, {
        tool_name: 'get_weather',
        verifier_name: 'check',
        outcome: 'pass'
      });
    }
    const results = getVerifierResultsByTool(db, 'get_weather', 3);
    expect(results).toHaveLength(3);
  });

  it('getVerifierResultsByTool filters by tool name', () => {
    insertVerifierResult(db, { tool_name: 'tool_a', verifier_name: 'check', outcome: 'pass' });
    insertVerifierResult(db, { tool_name: 'tool_b', verifier_name: 'check', outcome: 'warn' });

    expect(getVerifierResultsByTool(db, 'tool_a')).toHaveLength(1);
    expect(getVerifierResultsByTool(db, 'tool_b')).toHaveLength(1);
    expect(getVerifierResultsByTool(db, 'tool_c')).toHaveLength(0);
  });
});
