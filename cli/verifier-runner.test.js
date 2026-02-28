import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { VerifierRunner } from './verifier-runner.js';
import { getVerifierResultsByTool } from './db.js';

describe('VerifierRunner', () => {
  let db, runner;
  beforeEach(() => {
    db = makeTestDb();
    runner = new VerifierRunner(db);
  });

  it('no verifiers registered → pass', async () => {
    const result = await runner.verify('unregistered_tool', {}, { body: { ok: true } });
    expect(result.outcome).toBe('pass');
  });

  describe('schema verifier', () => {
    it('valid result passes', async () => {
      runner.registerVerifiers('tool_a', [{
        name: 'schema-check',
        type: 'schema',
        spec: { required: ['name'], properties: { name: { type: 'string' } } }
      }]);

      const result = await runner.verify('tool_a', {}, { body: { name: 'Alice' } });
      expect(result.outcome).toBe('pass');
    });

    it('missing required field blocks', async () => {
      runner.registerVerifiers('tool_a', [{
        name: 'schema-check',
        type: 'schema',
        spec: { required: ['name'] }
      }]);

      const result = await runner.verify('tool_a', {}, { body: { age: 30 } });
      expect(result.outcome).toBe('block');
      expect(result.message).toContain('name');
    });

    it('wrong type blocks', async () => {
      runner.registerVerifiers('tool_a', [{
        name: 'type-check',
        type: 'schema',
        spec: { properties: { count: { type: 'number' } } }
      }]);

      const result = await runner.verify('tool_a', {}, { body: { count: 'not-a-number' } });
      expect(result.outcome).toBe('block');
    });
  });

  describe('pattern verifier', () => {
    it('match passes when pattern found', async () => {
      runner.registerVerifiers('tool_b', [{
        name: 'pattern-check',
        type: 'pattern',
        spec: { match: 'success' }
      }]);

      const result = await runner.verify('tool_b', {}, { body: { status: 'success' } });
      expect(result.outcome).toBe('pass');
    });

    it('reject pattern warns', async () => {
      runner.registerVerifiers('tool_b', [{
        name: 'pattern-reject',
        type: 'pattern',
        spec: { reject: 'error', outcome: 'warn' }
      }]);

      const result = await runner.verify('tool_b', {}, { body: { message: 'An error occurred' } });
      expect(result.outcome).toBe('warn');
    });
  });

  it('multiple verifiers: worst outcome wins', async () => {
    runner.registerVerifiers('tool_c', [
      { name: 'pass-check', type: 'schema', spec: { required: [] } },
      { name: 'block-check', type: 'schema', spec: { required: ['missing_field'] } }
    ]);

    const result = await runner.verify('tool_c', {}, { body: { other: 'data' } });
    expect(result.outcome).toBe('block');
    expect(result.verifierName).toBe('block-check');
  });

  it('result logged to verifier_results table', () => {
    runner.logResult('sess-1', 'tool_a', { outcome: 'pass', message: null, verifierName: 'check' });

    const results = getVerifierResultsByTool(db, 'tool_a');
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe('pass');
    expect(results[0].session_id).toBe('sess-1');
  });

  it('custom verifier calls provided function', async () => {
    runner.registerVerifiers('tool_d', [{
      name: 'custom-check',
      type: 'custom',
      spec: {
        fn: async (toolName, args, result) => {
          if (result.body.danger) return { outcome: 'block', message: 'Danger detected' };
          return { outcome: 'pass', message: null };
        }
      }
    }]);

    const pass = await runner.verify('tool_d', {}, { body: { safe: true } });
    expect(pass.outcome).toBe('pass');

    const block = await runner.verify('tool_d', {}, { body: { danger: true } });
    expect(block.outcome).toBe('block');
  });
});
