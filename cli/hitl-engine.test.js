import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { HitlEngine, makeHitlEngine } from './hitl-engine.js';

describe('HitlEngine', () => {
  describe('shouldPause', () => {
    const engine = new HitlEngine();

    it('autonomous: never pauses', () => {
      expect(engine.shouldPause('autonomous', { requiresConfirmation: true, method: 'DELETE' })).toBe(false);
    });

    it('cautious: pauses on requiresConfirmation', () => {
      expect(engine.shouldPause('cautious', { requiresConfirmation: true })).toBe(true);
      expect(engine.shouldPause('cautious', { requiresConfirmation: false })).toBe(false);
      expect(engine.shouldPause('cautious', {})).toBe(false);
    });

    it('standard: pauses on mutating HTTP methods', () => {
      expect(engine.shouldPause('standard', { method: 'POST' })).toBe(true);
      expect(engine.shouldPause('standard', { method: 'PUT' })).toBe(true);
      expect(engine.shouldPause('standard', { method: 'PATCH' })).toBe(true);
      expect(engine.shouldPause('standard', { method: 'DELETE' })).toBe(true);
      expect(engine.shouldPause('standard', { method: 'GET' })).toBe(false);
      expect(engine.shouldPause('standard', {})).toBe(false); // default GET
    });

    it('paranoid: always pauses', () => {
      expect(engine.shouldPause('paranoid', {})).toBe(true);
      expect(engine.shouldPause('paranoid', { method: 'GET' })).toBe(true);
    });
  });

  describe('pause + resume (in-memory)', () => {
    it('round-trip works', () => {
      const engine = new HitlEngine();
      const token = engine.pause({ foo: 'bar' });
      expect(typeof token).toBe('string');

      const state = engine.resume(token);
      expect(state).toEqual({ foo: 'bar' });
    });

    it('resume returns null on wrong token', () => {
      const engine = new HitlEngine();
      engine.pause({ foo: 'bar' });
      expect(engine.resume('wrong-token')).toBeNull();
    });

    it('token is one-time use', () => {
      const engine = new HitlEngine();
      const token = engine.pause({ data: 1 });
      expect(engine.resume(token)).toEqual({ data: 1 });
      expect(engine.resume(token)).toBeNull();
    });

    it('resume returns null after TTL expiry', () => {
      const engine = new HitlEngine({ ttlMs: 1 }); // 1ms TTL
      const token = engine.pause({ data: 1 });
      // Wait a tick for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(engine.resume(token)).toBeNull();
    });
  });

  describe('pause + resume (SQLite)', () => {
    let db;
    beforeEach(() => { db = makeTestDb(); });

    it('round-trip works', () => {
      const engine = new HitlEngine({ db });
      const token = engine.pause({ session: 'abc', tools: ['get_weather'] });
      const state = engine.resume(token);
      expect(state).toEqual({ session: 'abc', tools: ['get_weather'] });
    });

    it('resume returns null for expired token', () => {
      const engine = new HitlEngine({ db, ttlMs: 1 });
      const token = engine.pause({ data: 1 });
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(engine.resume(token)).toBeNull();
    });

    it('resume returns null for wrong token', () => {
      const engine = new HitlEngine({ db });
      engine.pause({ data: 1 });
      expect(engine.resume('wrong-token')).toBeNull();
    });
  });

  it('makeHitlEngine factory creates engine', () => {
    const db = makeTestDb();
    const engine = makeHitlEngine({}, db);
    expect(engine).toBeInstanceOf(HitlEngine);
    // Verify it works
    const token = engine.pause({ test: true });
    expect(engine.resume(token)).toEqual({ test: true });
  });
});
