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
    it('round-trip works', async () => {
      const engine = new HitlEngine();
      const token = await engine.pause({ foo: 'bar' });
      expect(typeof token).toBe('string');

      const state = await engine.resume(token);
      expect(state).toEqual({ foo: 'bar' });
    });

    it('resume returns null on wrong token', async () => {
      const engine = new HitlEngine();
      await engine.pause({ foo: 'bar' });
      expect(await engine.resume('wrong-token')).toBeNull();
    });

    it('token is one-time use', async () => {
      const engine = new HitlEngine();
      const token = await engine.pause({ data: 1 });
      expect(await engine.resume(token)).toEqual({ data: 1 });
      expect(await engine.resume(token)).toBeNull();
    });

    it('resume returns null after TTL expiry', async () => {
      const engine = new HitlEngine({ ttlMs: 1 }); // 1ms TTL
      const token = await engine.pause({ data: 1 });
      // Wait a tick for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(await engine.resume(token)).toBeNull();
    });
  });

  describe('pause + resume (SQLite)', () => {
    let db;
    beforeEach(() => { db = makeTestDb(); });

    it('round-trip works', async () => {
      const engine = new HitlEngine({ db });
      const token = await engine.pause({ session: 'abc', tools: ['get_weather'] });
      const state = await engine.resume(token);
      expect(state).toEqual({ session: 'abc', tools: ['get_weather'] });
    });

    it('resume returns null for expired token', async () => {
      const engine = new HitlEngine({ db, ttlMs: 1 });
      const token = await engine.pause({ data: 1 });
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(await engine.resume(token)).toBeNull();
    });

    it('resume returns null for wrong token', async () => {
      const engine = new HitlEngine({ db });
      await engine.pause({ data: 1 });
      expect(await engine.resume('wrong-token')).toBeNull();
    });
  });

  describe('pause + resume (Redis)', () => {
    /** Minimal Redis mock — Map-backed with EX support */
    function createRedisMock() {
      const store = new Map();
      const timers = new Map();
      return {
        store,
        async set(key, value, flag, ttl) {
          store.set(key, value);
          if (flag === 'EX' && ttl) {
            const timer = setTimeout(() => store.delete(key), ttl * 1000);
            timers.set(key, timer);
          }
        },
        async get(key) {
          return store.get(key) ?? null;
        },
        async del(key) {
          store.delete(key);
          const timer = timers.get(key);
          if (timer) { clearTimeout(timer); timers.delete(key); }
        }
      };
    }

    it('round-trip works', async () => {
      const redis = createRedisMock();
      const engine = new HitlEngine({ redis });
      const token = await engine.pause({ session: 'xyz', tools: ['search'] });
      expect(typeof token).toBe('string');

      const state = await engine.resume(token);
      expect(state).toEqual({ session: 'xyz', tools: ['search'] });
    });

    it('token is one-time use', async () => {
      const redis = createRedisMock();
      const engine = new HitlEngine({ redis });
      const token = await engine.pause({ data: 42 });
      expect(await engine.resume(token)).toEqual({ data: 42 });
      expect(await engine.resume(token)).toBeNull();
    });

    it('resume returns null on wrong token', async () => {
      const redis = createRedisMock();
      const engine = new HitlEngine({ redis });
      await engine.pause({ data: 1 });
      expect(await engine.resume('wrong-token')).toBeNull();
    });

    it('stores with correct key prefix and TTL args', async () => {
      const redis = createRedisMock();
      const engine = new HitlEngine({ redis, ttlMs: 60000 }); // 60s
      const token = await engine.pause({ data: 1 });

      // Verify key format
      const key = `forge:hitl:${token}`;
      expect(redis.store.has(key)).toBe(true);

      // Verify stored value is JSON
      const stored = redis.store.get(key);
      expect(JSON.parse(stored)).toEqual({ data: 1 });
    });

    it('redis takes priority over sqlite', async () => {
      const redis = createRedisMock();
      const db = makeTestDb();
      // When both are provided, Redis should be used
      const engine = new HitlEngine({ redis, db });
      const token = await engine.pause({ via: 'redis' });

      // Should be in Redis, not SQLite
      expect(redis.store.size).toBe(1);

      const state = await engine.resume(token);
      expect(state).toEqual({ via: 'redis' });
    });
  });

  describe('pause + resume (Postgres)', () => {
    /** Minimal Postgres pool mock — in-memory Map */
    function createPgMock() {
      const rows = new Map();
      let tableCreated = false;
      return {
        _rows: rows,
        async query(sql, params) {
          if (sql.includes('CREATE TABLE')) {
            tableCreated = true;
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO')) {
            rows.set(params[0], {
              resume_token: params[0],
              state_json: params[1],
              expires_at: params[2],
              created_at: params[3],
            });
            return { rows: [] };
          }
          if (sql.includes('SELECT') && sql.includes('resume_token')) {
            const token = params[0];
            const row = rows.get(token);
            return { rows: row ? [row] : [] };
          }
          if (sql.includes('DELETE')) {
            rows.delete(params[0]);
            return { rows: [] };
          }
          return { rows: [] };
        }
      };
    }

    it('round-trip works', async () => {
      const pgPool = createPgMock();
      const engine = new HitlEngine({ pgPool });
      const token = await engine.pause({ session: 'pg-test', tools: ['search'] });
      expect(typeof token).toBe('string');

      const state = await engine.resume(token);
      expect(state).toEqual({ session: 'pg-test', tools: ['search'] });
    });

    it('token is one-time use', async () => {
      const pgPool = createPgMock();
      const engine = new HitlEngine({ pgPool });
      const token = await engine.pause({ data: 99 });
      expect(await engine.resume(token)).toEqual({ data: 99 });
      expect(await engine.resume(token)).toBeNull();
    });

    it('resume returns null for wrong token', async () => {
      const pgPool = createPgMock();
      const engine = new HitlEngine({ pgPool });
      await engine.pause({ data: 1 });
      expect(await engine.resume('wrong-token')).toBeNull();
    });

    it('resume returns null after TTL expiry', async () => {
      const pgPool = createPgMock();
      const engine = new HitlEngine({ pgPool, ttlMs: 1 });
      const token = await engine.pause({ data: 1 });
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }
      expect(await engine.resume(token)).toBeNull();
    });

    it('postgres takes priority over sqlite when both provided', async () => {
      const pgPool = createPgMock();
      const db = makeTestDb();
      const engine = new HitlEngine({ pgPool, db });
      const token = await engine.pause({ via: 'postgres' });

      // Should be in Postgres mock, not SQLite
      expect(pgPool._rows.size).toBe(1);
      const state = await engine.resume(token);
      expect(state).toEqual({ via: 'postgres' });
    });
  });

  it('makeHitlEngine factory creates engine with db', async () => {
    const db = makeTestDb();
    const engine = makeHitlEngine({}, db);
    expect(engine).toBeInstanceOf(HitlEngine);
    const token = await engine.pause({ test: true });
    expect(await engine.resume(token)).toEqual({ test: true });
  });

  it('makeHitlEngine factory uses pgPool when provided (no redis)', async () => {
    const pgMock = {
      _rows: new Map(),
      async query(sql, params) {
        if (sql.includes('CREATE TABLE')) return { rows: [] };
        if (sql.includes('INSERT')) { this._rows.set(params[0], { resume_token: params[0], state_json: params[1], expires_at: params[2], created_at: params[3] }); return { rows: [] }; }
        if (sql.includes('SELECT')) { const r = this._rows.get(params[0]); return { rows: r ? [r] : [] }; }
        if (sql.includes('DELETE')) { this._rows.delete(params[0]); return { rows: [] }; }
        return { rows: [] };
      }
    };
    const db = makeTestDb();
    const engine = makeHitlEngine({}, db, null, pgMock);
    expect(engine).toBeInstanceOf(HitlEngine);
    const token = await engine.pause({ test: true });
    expect(pgMock._rows.size).toBe(1);
    expect(await engine.resume(token)).toEqual({ test: true });
  });

  it('makeHitlEngine factory prefers redis when provided', async () => {
    const db = makeTestDb();
    const redisMock = {
      store: new Map(),
      async set(k, v, flag, ttl) { this.store.set(k, v); },
      async get(k) { return this.store.get(k) ?? null; },
      async del(k) { this.store.delete(k); }
    };
    const engine = makeHitlEngine({}, db, redisMock);
    expect(engine).toBeInstanceOf(HitlEngine);
    const token = await engine.pause({ test: true });
    expect(redisMock.store.size).toBe(1);
    expect(await engine.resume(token)).toEqual({ test: true });
  });
});
