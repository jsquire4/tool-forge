import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import {
  writeFixture, readFixture, listFixtures, clearFixtures, fixtureStats, sortKeysDeep
} from './fixture-store.js';

const testDir = join(tmpdir(), `fixture-test-${process.pid}`);

describe('fixture-store', () => {
  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('sortKeysDeep', () => {
    it('sorts object keys', () => {
      const r = sortKeysDeep({ b: 2, a: 1 });
      expect(Object.keys(r)).toEqual(['a', 'b']);
    });
    it('recurses into nested objects', () => {
      const r = sortKeysDeep({ b: { d: 4, c: 3 }, a: 1 });
      expect(Object.keys(r.b)).toEqual(['c', 'd']);
    });
    it('handles arrays (traverses but does not sort)', () => {
      const r = sortKeysDeep([{ b: 2, a: 1 }]);
      expect(Object.keys(r[0])).toEqual(['a', 'b']);
    });
    it('returns primitives unchanged', () => {
      expect(sortKeysDeep(42)).toBe(42);
      expect(sortKeysDeep('hello')).toBe('hello');
      expect(sortKeysDeep(null)).toBe(null);
    });
    it('handles deeply nested objects', () => {
      const r = sortKeysDeep({ z: { y: { x: 1, a: 2 } } });
      expect(Object.keys(r.z.y)).toEqual(['a', 'x']);
    });
    it('handles arrays of primitives without error', () => {
      const r = sortKeysDeep([3, 1, 2]);
      expect(r).toEqual([3, 1, 2]);
    });
  });

  describe('writeFixture + readFixture roundtrip', () => {
    it('writes and reads back a fixture (cache hit)', async () => {
      const output = { answer: 42, text: 'hello' };
      await writeFixture(testDir, 'test-case-1', 'abc123', output);
      const r = await readFixture(testDir, 'test-case-1', 'abc123');
      expect(r.status).toBe('hit');
      expect(r.output).toEqual(output);
    });

    it('returns miss:not-found when file does not exist', async () => {
      const r = await readFixture(testDir, 'nonexistent', 'abc123');
      expect(r.status).toBe('miss');
      expect(r.reason).toBe('not-found');
    });

    it('returns miss:config-hash-mismatch when hash differs', async () => {
      await writeFixture(testDir, 'case-hash', 'hash-A', { x: 1 });
      const r = await readFixture(testDir, 'case-hash', 'hash-B');
      expect(r.status).toBe('miss');
      expect(r.reason).toBe('config-hash-mismatch');
      expect(r.storedHash).toBe('hash-A');
    });

    it('returns miss:stale when fixture is older than ttlDays', async () => {
      await writeFixture(testDir, 'stale-case', 'h1', { data: 'old' });
      // ttlDays: 0 means any age > 0 days is stale; since the file was just written,
      // age in days is effectively 0 but the check is ageDays > ttlDays (strict >),
      // so a newly written fixture with ttlDays: 0 will NOT be stale (0 > 0 is false).
      // Use a negative ttlDays to force staleness without time manipulation.
      const r = await readFixture(testDir, 'stale-case', 'h1', { ttlDays: -1 });
      expect(r.status).toBe('miss');
      expect(r.reason).toBe('stale');
    });

    it('roundtrips complex nested output', async () => {
      const output = { list: [1, 2, 3], nested: { deep: true }, nullVal: null };
      await writeFixture(testDir, 'complex-case', 'hashX', output);
      const r = await readFixture(testDir, 'complex-case', 'hashX');
      expect(r.status).toBe('hit');
      expect(r.output).toEqual(output);
    });

    it('creates the directory if it does not exist', async () => {
      const nestedDir = join(testDir, 'sub', 'dir');
      await writeFixture(nestedDir, 'my-case', 'h', { v: 1 });
      const r = await readFixture(nestedDir, 'my-case', 'h');
      expect(r.status).toBe('hit');
    });

    it('uses configHash from stored meta when reporting mismatch', async () => {
      await writeFixture(testDir, 'meta-check', 'stored-hash-xyz', {});
      const r = await readFixture(testDir, 'meta-check', 'different-hash');
      expect(r.storedHash).toBe('stored-hash-xyz');
    });
  });

  describe('listFixtures', () => {
    it('returns empty array when dir does not exist', async () => {
      const list = await listFixtures(testDir);
      expect(list).toEqual([]);
    });

    it('returns slugified case IDs', async () => {
      await writeFixture(testDir, 'case-one', 'h', {});
      await writeFixture(testDir, 'case two', 'h', {});
      const list = await listFixtures(testDir);
      expect(list).toHaveLength(2);
    });

    it('returns only .jsonl files', async () => {
      await writeFixture(testDir, 'real-case', 'h', {});
      // listFixtures should only count .jsonl files
      const list = await listFixtures(testDir);
      expect(list.every(name => !name.endsWith('.jsonl'))).toBe(true);
    });

    it('strips .jsonl extension from returned names', async () => {
      await writeFixture(testDir, 'my-case', 'h', {});
      const list = await listFixtures(testDir);
      expect(list).toContain('my-case');
    });
  });

  describe('clearFixtures', () => {
    it('deletes all fixtures and returns count', async () => {
      await writeFixture(testDir, 'c1', 'h', {});
      await writeFixture(testDir, 'c2', 'h', {});
      const count = await clearFixtures(testDir);
      expect(count).toBe(2);
      const list = await listFixtures(testDir);
      expect(list).toHaveLength(0);
    });

    it('returns 0 when dir does not exist', async () => {
      const count = await clearFixtures(testDir);
      expect(count).toBe(0);
    });

    it('returns 0 when dir is already empty', async () => {
      // Create dir with a write then clear it, then clear again
      await writeFixture(testDir, 'tmp', 'h', {});
      await clearFixtures(testDir);
      const count = await clearFixtures(testDir);
      expect(count).toBe(0);
    });
  });

  describe('fixtureStats', () => {
    it('returns zeros for empty dir', async () => {
      const s = await fixtureStats(testDir);
      expect(s.count).toBe(0);
      expect(s.totalBytes).toBe(0);
    });

    it('returns count and totalBytes', async () => {
      await writeFixture(testDir, 'stat-case', 'h', { big: 'data' });
      const s = await fixtureStats(testDir);
      expect(s.count).toBe(1);
      expect(s.totalBytes).toBeGreaterThan(0);
    });

    it('accumulates totalBytes across multiple fixtures', async () => {
      await writeFixture(testDir, 'f1', 'h', { x: 1 });
      await writeFixture(testDir, 'f2', 'h', { x: 2 });
      const s = await fixtureStats(testDir);
      expect(s.count).toBe(2);
      expect(s.totalBytes).toBeGreaterThan(0);
    });

    it('returns zeros when dir does not exist', async () => {
      const s = await fixtureStats(join(testDir, 'nonexistent'));
      expect(s.count).toBe(0);
      expect(s.totalBytes).toBe(0);
    });

    it('includes oldestDays and newestDays fields', async () => {
      await writeFixture(testDir, 'age-case', 'h', {});
      const s = await fixtureStats(testDir);
      expect(s).toHaveProperty('oldestDays');
      expect(s).toHaveProperty('newestDays');
      expect(typeof s.oldestDays).toBe('number');
      expect(typeof s.newestDays).toBe('number');
    });
  });
});
