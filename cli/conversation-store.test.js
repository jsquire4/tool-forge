/**
 * Tests for ConversationStore — SQLite adapter and factory.
 *
 * Redis adapter is tested only structurally (no live Redis required):
 * we verify the class exists and exposes the right interface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import {
  SqliteConversationStore,
  RedisConversationStore,
  PostgresConversationStore,
  makeConversationStore
} from './conversation-store.js';

// ── SqliteConversationStore ────────────────────────────────────────────────

describe('SqliteConversationStore', () => {
  let store;

  beforeEach(() => {
    const db = makeTestDb();
    store = new SqliteConversationStore(db);
  });

  it('createSession returns a unique non-empty string', () => {
    const a = store.createSession();
    const b = store.createSession();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('persistMessage + getHistory round-trips a message', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'orient', 'user', 'Hello');
    const history = await store.getHistory(sid);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Hello');
    expect(history[0].role).toBe('user');
    expect(history[0].stage).toBe('orient');
    expect(history[0].session_id).toBe(sid);
  });

  it('getHistory returns messages in chronological order', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'orient', 'user', 'First');
    await new Promise((r) => setTimeout(r, 30));
    await store.persistMessage(sid, 'orient', 'assistant', 'Second');
    await new Promise((r) => setTimeout(r, 30));
    await store.persistMessage(sid, 'orient', 'user', 'Third');

    const history = await store.getHistory(sid);
    expect(history.map((r) => r.content)).toEqual(['First', 'Second', 'Third']);
  });

  it('getHistory returns empty array for unknown session', async () => {
    const history = await store.getHistory('no-such-session');
    expect(history).toEqual([]);
  });

  it('getHistory isolates sessions from each other', async () => {
    const s1 = store.createSession();
    const s2 = store.createSession();
    await store.persistMessage(s1, 'orient', 'user', 'Session 1 message');
    await store.persistMessage(s2, 'orient', 'user', 'Session 2 message');

    const h1 = await store.getHistory(s1);
    expect(h1).toHaveLength(1);
    expect(h1[0].content).toBe('Session 1 message');
  });

  it('getIncompleteSessions returns sessions without [COMPLETE] marker', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'orient', 'user', 'Hello');
    await store.persistMessage(sid, 'orient', 'assistant', 'World');

    const sessions = await store.getIncompleteSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].session_id).toBe(sid);
  });

  it('getIncompleteSessions excludes completed sessions', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'orient', 'user', 'Hello');
    await store.persistMessage(sid, 'promote', 'system', '[COMPLETE]');

    const sessions = await store.getIncompleteSessions();
    const found = sessions.find((s) => s.session_id === sid);
    expect(found).toBeUndefined();
  });

  it('getIncompleteSessions returns empty array when no sessions exist', async () => {
    const sessions = await store.getIncompleteSessions();
    expect(sessions).toEqual([]);
  });

  it('close() resolves without error', async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('persistMessage stores userId in the row', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'chat', 'user', 'hello', null, 'user123');
    const history = await store.getHistory(sid);
    expect(history).toHaveLength(1);
    expect(history[0].user_id).toBe('user123');
  });

  it('listSessions returns only sessions for the given userId', async () => {
    const s1 = store.createSession();
    const s2 = store.createSession();
    await store.persistMessage(s1, 'chat', 'user', 'hello', null, 'user-a');
    await store.persistMessage(s2, 'chat', 'user', 'world', null, 'user-b');

    const listA = await store.listSessions('user-a');
    expect(listA).toHaveLength(1);
    expect(listA[0].sessionId).toBe(s1);
    expect(listA[0].userId).toBe('user-a');

    const listB = await store.listSessions('user-b');
    expect(listB).toHaveLength(1);
    expect(listB[0].sessionId).toBe(s2);
    expect(listB[0].userId).toBe('user-b');
  });

  it('deleteSession with wrong userId returns false, correct userId returns true', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'chat', 'user', 'hi', null, 'owner-1');

    const wrongResult = await store.deleteSession(sid, 'wrong-user');
    expect(wrongResult).toBe(false);

    // Session still accessible
    const history = await store.getHistory(sid);
    expect(history).toHaveLength(1);

    const correctResult = await store.deleteSession(sid, 'owner-1');
    expect(correctResult).toBe(true);

    // Session is gone
    const historyAfter = await store.getHistory(sid);
    expect(historyAfter).toHaveLength(0);
  });

  it('getSessionUserId returns undefined for unknown session', async () => {
    const result = await store.getSessionUserId('nonexistent-session');
    expect(result).toBeUndefined();
  });

  it('getSessionUserId returns the userId of the first message', async () => {
    const sid = store.createSession();
    await store.persistMessage(sid, 'chat', 'user', 'hello', null, 'my-user');
    const uid = await store.getSessionUserId(sid);
    expect(uid).toBe('my-user');
  });
});

// ── makeConversationStore factory ──────────────────────────────────────────

describe('makeConversationStore', () => {
  it('returns SqliteConversationStore when store is unset', () => {
    const db = makeTestDb();
    const store = makeConversationStore({}, db);
    expect(store).toBeInstanceOf(SqliteConversationStore);
  });

  it('returns SqliteConversationStore when store is "sqlite"', () => {
    const db = makeTestDb();
    const store = makeConversationStore({ conversation: { store: 'sqlite' } }, db);
    expect(store).toBeInstanceOf(SqliteConversationStore);
  });

  it('returns RedisConversationStore when store is "redis"', () => {
    const store = makeConversationStore({ conversation: { store: 'redis' } });
    expect(store).toBeInstanceOf(RedisConversationStore);
  });

  it('returns PostgresConversationStore when store is "postgres" and pgPool provided', () => {
    const mockPool = { query: async () => ({ rows: [] }) };
    const store = makeConversationStore({ conversation: { store: 'postgres' } }, null, mockPool);
    expect(store).toBeInstanceOf(PostgresConversationStore);
  });

  it('throws when postgres store requested but no pgPool provided', () => {
    expect(() => makeConversationStore({ conversation: { store: 'postgres' } })).toThrow(/pgPool/);
  });

  it('throws when sqlite store requested but no db provided', () => {
    expect(() => makeConversationStore({})).toThrow(/db instance/);
  });

  it('passes redis config through to RedisConversationStore', () => {
    const store = makeConversationStore({
      conversation: {
        store: 'redis',
        redis: { url: 'redis://myhost:6380', ttlSeconds: 86400 }
      }
    });
    expect(store).toBeInstanceOf(RedisConversationStore);
    expect(store._url).toBe('redis://myhost:6380');
    expect(store._ttl).toBe(86400);
  });
});

// ── RedisConversationStore — structural interface check ────────────────────

describe('RedisConversationStore interface', () => {
  it('exposes the expected methods', () => {
    const store = new RedisConversationStore({ url: 'redis://localhost:6379' });
    expect(typeof store.createSession).toBe('function');
    expect(typeof store.persistMessage).toBe('function');
    expect(typeof store.getHistory).toBe('function');
    expect(typeof store.getIncompleteSessions).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  it('createSession returns a unique non-empty string (no Redis needed)', () => {
    const store = new RedisConversationStore({});
    const a = store.createSession();
    const b = store.createSession();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it('persistMessage rejects when redis is unavailable (package missing or unreachable)', async () => {
    const store = new RedisConversationStore({ url: 'redis://127.0.0.1:1' });
    await expect(store.persistMessage('sid', 'orient', 'user', 'hi')).rejects.toThrow();
  });

  it('persistMessage uses multi() pipeline — exec() called once, not separate rPush/expire/sAdd', async () => {
    // Build a mock redis client that records which methods were called
    const calls = [];
    const execResult = [];
    const mockPipeline = {
      rPush: (...args) => { calls.push(['pipeline.rPush', ...args]); return mockPipeline; },
      expire: (...args) => { calls.push(['pipeline.expire', ...args]); return mockPipeline; },
      sAdd: (...args) => { calls.push(['pipeline.sAdd', ...args]); return mockPipeline; },
      sRem: (...args) => { calls.push(['pipeline.sRem', ...args]); return mockPipeline; },
      exec: async () => { calls.push(['pipeline.exec']); return execResult; }
    };
    const mockClient = {
      multi: () => { calls.push(['multi']); return mockPipeline; },
      // These should NOT be called directly
      rPush: async () => { calls.push(['direct.rPush']); },
      expire: async () => { calls.push(['direct.expire']); },
      sAdd: async () => { calls.push(['direct.sAdd']); },
      sRem: async () => { calls.push(['direct.sRem']); }
    };

    const store = new RedisConversationStore({ url: 'redis://localhost:6379' });
    // Bypass the real _connect by injecting the mock client
    store._client = mockClient;

    await store.persistMessage('test-session', 'chat', 'user', 'hello', null, 'u1');

    // multi() must have been called
    expect(calls.some(c => c[0] === 'multi')).toBe(true);
    // exec() must have been called exactly once
    expect(calls.filter(c => c[0] === 'pipeline.exec')).toHaveLength(1);
    // No direct (non-pipelined) Redis calls should have been made
    expect(calls.some(c => c[0] === 'direct.rPush')).toBe(false);
    expect(calls.some(c => c[0] === 'direct.expire')).toBe(false);
    expect(calls.some(c => c[0] === 'direct.sAdd')).toBe(false);
    expect(calls.some(c => c[0] === 'direct.sRem')).toBe(false);
  });
});

// ── PostgresConversationStore — interface + mock round-trip ─────────────

describe('PostgresConversationStore', () => {
  /** Create a mock pg.Pool backed by an in-memory array */
  function createMockPool() {
    const rows = [];
    let tableCreated = false;
    return {
      rows, // exposed for inspection
      async query(sql, params) {
        if (sql.includes('CREATE TABLE')) {
          tableCreated = true;
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO')) {
          const row = {
            session_id: params[0],
            stage: params[1],
            role: params[2],
            content: params[3],
            agent_id: params[4],
            user_id: params[5],
            created_at: params[6],
          };
          rows.push(row);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DELETE FROM')) {
          const sid = params[0];
          const uid = params[1];
          const before = rows.length;
          const toDelete = rows.filter(r => r.session_id === sid && r.user_id === uid);
          if (toDelete.length === 0) { return { rows: [], rowCount: 0 }; }
          // Remove matching rows in place
          const indices = [];
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].session_id === sid && rows[i].user_id === uid) indices.push(i);
          }
          for (let i = indices.length - 1; i >= 0; i--) rows.splice(indices[i], 1);
          return { rows: [], rowCount: before - rows.length };
        }
        if (sql.includes('SELECT') && sql.includes('WHERE session_id')) {
          const sid = params[0];
          const matching = rows
            .filter(r => r.session_id === sid)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { rows: matching };
        }
        if (sql.includes('WHERE user_id')) {
          // listSessions or getSessionUserId
          const uid = params[0];
          if (sql.includes('LIMIT 1')) {
            // getSessionUserId
            const match = rows.find(r => r.session_id === params[0]);
            // Note: params[0] is session_id for LIMIT 1 form
            return { rows: match ? [{ user_id: match.user_id }] : [] };
          }
          // listSessions — group by session_id
          const matching = rows.filter(r => r.user_id === uid);
          const groups = {};
          for (const r of matching) {
            if (!groups[r.session_id]) {
              groups[r.session_id] = { session_id: r.session_id, agent_id: r.agent_id, user_id: r.user_id,
                last_updated: r.created_at, started_at: r.created_at };
            } else {
              if (r.created_at > groups[r.session_id].last_updated) groups[r.session_id].last_updated = r.created_at;
              if (r.created_at < groups[r.session_id].started_at) groups[r.session_id].started_at = r.created_at;
            }
          }
          return { rows: Object.values(groups).sort((a, b) => b.last_updated.localeCompare(a.last_updated)) };
        }
        if (sql.includes('NOT IN')) {
          // getIncompleteSessions — simplified mock
          const completedSids = new Set(
            rows.filter(r => r.role === 'system' && r.content === '[COMPLETE]').map(r => r.session_id)
          );
          const groups = {};
          for (const r of rows) {
            if (completedSids.has(r.session_id)) continue;
            if (!groups[r.session_id] || r.created_at > groups[r.session_id].last_updated) {
              groups[r.session_id] = { session_id: r.session_id, stage: r.stage, last_updated: r.created_at };
            }
          }
          return { rows: Object.values(groups) };
        }
        return { rows: [] };
      }
    };
  }

  it('exposes the expected interface methods', () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    expect(typeof store.createSession).toBe('function');
    expect(typeof store.persistMessage).toBe('function');
    expect(typeof store.getHistory).toBe('function');
    expect(typeof store.getIncompleteSessions).toBe('function');
    expect(typeof store.listSessions).toBe('function');
    expect(typeof store.deleteSession).toBe('function');
    expect(typeof store.getSessionUserId).toBe('function');
    expect(typeof store.close).toBe('function');
  });

  it('round-trip: persistMessage + getHistory', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    const sid = store.createSession();

    await store.persistMessage(sid, 'orient', 'user', 'Hello');
    await store.persistMessage(sid, 'orient', 'assistant', 'World');

    const history = await store.getHistory(sid);
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('Hello');
    expect(history[1].content).toBe('World');
  });

  it('getHistory returns empty for unknown session', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    // Ensure table created first
    await store.persistMessage('other', 'orient', 'user', 'test');
    const history = await store.getHistory('no-such-session');
    expect(history).toEqual([]);
  });

  it('getIncompleteSessions excludes completed sessions', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    const sid = store.createSession();
    await store.persistMessage(sid, 'orient', 'user', 'Hi');
    await store.persistMessage(sid, 'done', 'system', '[COMPLETE]');

    const sessions = await store.getIncompleteSessions();
    expect(sessions.find(s => s.session_id === sid)).toBeUndefined();
  });

  it('listSessions returns only sessions for the given userId', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    const s1 = store.createSession();
    const s2 = store.createSession();

    await store.persistMessage(s1, 'chat', 'user', 'hello', null, 'user-pg-1');
    await store.persistMessage(s2, 'chat', 'user', 'world', null, 'user-pg-2');

    const list1 = await store.listSessions('user-pg-1');
    expect(list1).toHaveLength(1);
    expect(list1[0].sessionId).toBe(s1);

    const list2 = await store.listSessions('user-pg-2');
    expect(list2).toHaveLength(1);
    expect(list2[0].sessionId).toBe(s2);
  });

  it('deleteSession with wrong userId returns false, correct userId returns true', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    const sid = store.createSession();
    await store.persistMessage(sid, 'chat', 'user', 'hello', null, 'user-pg-owner');

    const wrongResult = await store.deleteSession(sid, 'wrong-user');
    expect(wrongResult).toBe(false);

    // Session still has rows — verify via pool.rows
    expect(pool.rows.some(r => r.session_id === sid)).toBe(true);

    const correctResult = await store.deleteSession(sid, 'user-pg-owner');
    expect(correctResult).toBe(true);
    expect(pool.rows.some(r => r.session_id === sid)).toBe(false);
  });

  it('close() resolves without error', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    await expect(store.close()).resolves.toBeUndefined();
  });
});
