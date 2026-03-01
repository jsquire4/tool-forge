import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { VerifierRunner } from './verifier-runner.js';
import {
  getVerifierResultsByTool, upsertVerifier,
  upsertVerifierBinding
} from './db.js';

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

  // ── loadFromDb tests ─────────────────────────────────────────────────────

  describe('loadFromDb', () => {
    it('populates verifier map from DB rows', async () => {
      upsertVerifier(db, {
        verifier_name: 'db-schema',
        type: 'schema',
        aciru_order: 'I-0001',
        spec_json: JSON.stringify({ required: ['id'] })
      });
      upsertVerifierBinding(db, { verifier_name: 'db-schema', tool_name: 'tool_x' });

      await runner.loadFromDb(db);

      const result = await runner.verify('tool_x', {}, { body: { id: 1 } });
      expect(result.outcome).toBe('pass');

      const fail = await runner.verify('tool_x', {}, { body: { name: 'no-id' } });
      expect(fail.outcome).toBe('block');
    });

    it('wildcard verifiers merge with tool-specific', async () => {
      upsertVerifier(db, {
        verifier_name: 'global-check',
        type: 'pattern',
        aciru_order: 'A-0001',
        spec_json: JSON.stringify({ reject: 'FATAL', outcome: 'block' })
      });
      upsertVerifierBinding(db, { verifier_name: 'global-check', tool_name: '*' });

      upsertVerifier(db, {
        verifier_name: 'specific-check',
        type: 'schema',
        aciru_order: 'I-0001',
        spec_json: JSON.stringify({ required: ['status'] })
      });
      upsertVerifierBinding(db, { verifier_name: 'specific-check', tool_name: 'my_tool' });

      await runner.loadFromDb(db);

      // Both verifiers run on my_tool
      const result = await runner.verify('my_tool', {}, { body: { status: 'ok' } });
      expect(result.outcome).toBe('pass'); // both pass

      // Wildcard alone runs on other_tool
      const result2 = await runner.verify('other_tool', {}, { body: { text: 'fine' } });
      expect(result2.outcome).toBe('pass');
    });

    it('custom verifier with missing file returns warn', async () => {
      upsertVerifier(db, {
        verifier_name: 'missing-custom',
        type: 'custom',
        aciru_order: 'R-0001',
        spec_json: JSON.stringify({ filePath: '/nonexistent/verifier.js', exportName: 'verify' })
      });
      upsertVerifierBinding(db, { verifier_name: 'missing-custom', tool_name: 'tool_z' });

      await runner.loadFromDb(db);

      const result = await runner.verify('tool_z', {}, { body: {} });
      expect(result.outcome).toBe('warn');
      expect(result.message).toContain('missing-custom');
    });
  });

  // ── ACIRU ordering tests ─────────────────────────────────────────────────

  describe('ACIRU ordering', () => {
    it('A-0001 runs before I-0001 runs before R-0001', async () => {
      const callOrder = [];

      runner.registerVerifiers('tool_order', [
        {
          name: 'r-verifier', type: 'custom', order: 'R-0001',
          spec: { fn: () => { callOrder.push('R'); return { outcome: 'pass', message: null }; } }
        },
        {
          name: 'a-verifier', type: 'custom', order: 'A-0001',
          spec: { fn: () => { callOrder.push('A'); return { outcome: 'pass', message: null }; } }
        },
        {
          name: 'i-verifier', type: 'custom', order: 'I-0001',
          spec: { fn: () => { callOrder.push('I'); return { outcome: 'pass', message: null }; } }
        }
      ]);

      await runner.verify('tool_order', {}, { body: {} });
      expect(callOrder).toEqual(['A', 'I', 'R']);
    });

    it('block short-circuits — later verifiers NOT called', async () => {
      const laterSpy = vi.fn(() => ({ outcome: 'pass', message: null }));

      runner.registerVerifiers('tool_sc', [
        {
          name: 'blocker', type: 'custom', order: 'A-0001',
          spec: { fn: () => ({ outcome: 'block', message: 'Blocked!' }) }
        },
        {
          name: 'later', type: 'custom', order: 'I-0001',
          spec: { fn: laterSpy }
        }
      ]);

      const result = await runner.verify('tool_sc', {}, { body: {} });
      expect(result.outcome).toBe('block');
      expect(result.verifierName).toBe('blocker');
      expect(laterSpy).not.toHaveBeenCalled();
    });

    it('warn does NOT short-circuit', async () => {
      const laterSpy = vi.fn(() => ({ outcome: 'pass', message: null }));

      runner.registerVerifiers('tool_warn', [
        {
          name: 'warner', type: 'custom', order: 'A-0001',
          spec: { fn: () => ({ outcome: 'warn', message: 'Watch out' }) }
        },
        {
          name: 'later', type: 'custom', order: 'I-0001',
          spec: { fn: laterSpy }
        }
      ]);

      const result = await runner.verify('tool_warn', {}, { body: {} });
      expect(result.outcome).toBe('warn');
      expect(laterSpy).toHaveBeenCalled();
    });
  });
});
