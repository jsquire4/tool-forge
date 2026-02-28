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
            created_at: params[5],
          };
          rows.push(row);
          return { rows: [] };
        }
        if (sql.includes('SELECT') && sql.includes('WHERE session_id')) {
          const sid = params[0];
          const matching = rows
            .filter(r => r.session_id === sid)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { rows: matching };
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

  it('close() resolves without error', async () => {
    const pool = createMockPool();
    const store = new PostgresConversationStore(pool);
    await expect(store.close()).resolves.toBeUndefined();
  });
});
