import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import {
  upsertVerifier, getVerifier, getAllVerifiers, deleteVerifier,
  upsertVerifierBinding, removeVerifierBinding,
  getVerifiersForTool, getBindingsForVerifier
} from './db.js';

describe('verifier_registry + verifier_tool_bindings', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  describe('upsertVerifier', () => {
    it('creates a new verifier', () => {
      upsertVerifier(db, {
        verifier_name: 'schema-v1',
        display_name: 'Schema V1',
        type: 'schema',
        aciru_category: 'I',
        aciru_order: 'I-0001',
        spec_json: JSON.stringify({ required: ['name'] }),
        description: 'Checks name field'
      });
      const row = getVerifier(db, 'schema-v1');
      expect(row).not.toBeNull();
      expect(row.type).toBe('schema');
      expect(row.aciru_order).toBe('I-0001');
      expect(row.enabled).toBe(1);
    });

    it('updates on conflict and re-enables', () => {
      upsertVerifier(db, {
        verifier_name: 'v1',
        type: 'pattern',
        spec_json: '{"match":"old"}'
      });
      // Manually disable
      db.prepare('UPDATE verifier_registry SET enabled = 0 WHERE verifier_name = ?').run('v1');
      expect(getVerifier(db, 'v1').enabled).toBe(0);

      // Upsert re-enables
      upsertVerifier(db, {
        verifier_name: 'v1',
        type: 'pattern',
        spec_json: '{"match":"new"}',
        description: 'Updated'
      });
      const row = getVerifier(db, 'v1');
      expect(row.enabled).toBe(1);
      expect(row.description).toBe('Updated');
      expect(JSON.parse(row.spec_json).match).toBe('new');
    });
  });

  describe('getVerifier', () => {
    it('returns null for non-existent', () => {
      expect(getVerifier(db, 'nope')).toBeNull();
    });
  });

  describe('getAllVerifiers', () => {
    it('returns ordered by aciru_order', () => {
      upsertVerifier(db, { verifier_name: 'z', type: 'schema', aciru_order: 'R-0001', spec_json: '{}' });
      upsertVerifier(db, { verifier_name: 'a', type: 'schema', aciru_order: 'A-0001', spec_json: '{}' });
      upsertVerifier(db, { verifier_name: 'm', type: 'schema', aciru_order: 'I-0001', spec_json: '{}' });
      const all = getAllVerifiers(db);
      expect(all.map(r => r.verifier_name)).toEqual(['a', 'm', 'z']);
    });
  });

  describe('deleteVerifier', () => {
    it('cascades to bindings', () => {
      upsertVerifier(db, { verifier_name: 'v1', type: 'schema', spec_json: '{}' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_b' });
      expect(getBindingsForVerifier(db, 'v1')).toHaveLength(2);

      deleteVerifier(db, 'v1');
      expect(getVerifier(db, 'v1')).toBeNull();
      expect(getBindingsForVerifier(db, 'v1')).toHaveLength(0);
    });
  });

  describe('upsertVerifierBinding', () => {
    it('creates binding', () => {
      upsertVerifier(db, { verifier_name: 'v1', type: 'schema', spec_json: '{}' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      const bindings = getBindingsForVerifier(db, 'v1');
      expect(bindings).toHaveLength(1);
      expect(bindings[0].tool_name).toBe('tool_a');
    });

    it('ignores duplicate binding', () => {
      upsertVerifier(db, { verifier_name: 'v1', type: 'schema', spec_json: '{}' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      expect(getBindingsForVerifier(db, 'v1')).toHaveLength(1);
    });
  });

  describe('removeVerifierBinding', () => {
    it('removes specific binding', () => {
      upsertVerifier(db, { verifier_name: 'v1', type: 'schema', spec_json: '{}' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_b' });
      removeVerifierBinding(db, 'v1', 'tool_a');
      const bindings = getBindingsForVerifier(db, 'v1');
      expect(bindings).toHaveLength(1);
      expect(bindings[0].tool_name).toBe('tool_b');
    });
  });

  describe('getVerifiersForTool', () => {
    it('returns wildcard + specific bindings', () => {
      upsertVerifier(db, { verifier_name: 'global', type: 'pattern', aciru_order: 'A-0001', spec_json: '{"reject":"error"}' });
      upsertVerifier(db, { verifier_name: 'specific', type: 'schema', aciru_order: 'I-0001', spec_json: '{"required":["id"]}' });
      upsertVerifierBinding(db, { verifier_name: 'global', tool_name: '*' });
      upsertVerifierBinding(db, { verifier_name: 'specific', tool_name: 'tool_a' });

      const result = getVerifiersForTool(db, 'tool_a');
      expect(result).toHaveLength(2);
      expect(result[0].verifier_name).toBe('global');  // A-0001 first
      expect(result[1].verifier_name).toBe('specific'); // I-0001 second
    });

    it('does not return unbound verifiers', () => {
      upsertVerifier(db, { verifier_name: 'unbound', type: 'schema', spec_json: '{}' });
      expect(getVerifiersForTool(db, 'tool_a')).toHaveLength(0);
    });

    it('respects enabled flags on both tables', () => {
      upsertVerifier(db, { verifier_name: 'v1', type: 'schema', spec_json: '{}' });
      upsertVerifierBinding(db, { verifier_name: 'v1', tool_name: 'tool_a' });
      expect(getVerifiersForTool(db, 'tool_a')).toHaveLength(1);

      // Disable verifier globally
      db.prepare('UPDATE verifier_registry SET enabled = 0 WHERE verifier_name = ?').run('v1');
      expect(getVerifiersForTool(db, 'tool_a')).toHaveLength(0);

      // Re-enable verifier, disable binding
      db.prepare('UPDATE verifier_registry SET enabled = 1 WHERE verifier_name = ?').run('v1');
      db.prepare('UPDATE verifier_tool_bindings SET enabled = 0 WHERE verifier_name = ? AND tool_name = ?').run('v1', 'tool_a');
      expect(getVerifiersForTool(db, 'tool_a')).toHaveLength(0);
    });

    it('returns empty for tool with no bindings', () => {
      expect(getVerifiersForTool(db, 'nonexistent')).toHaveLength(0);
    });
  });
});
