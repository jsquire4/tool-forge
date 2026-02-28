/**
 * TDD tests for conversations table helpers in cli/db.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import {
  createSession,
  insertConversationMessage,
  getConversationHistory,
  getIncompleteSessions,
  getDb
} from './db.js';

describe('conversations DB helpers', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  // ── createSession ──────────────────────────────────────────────────────────

  it('createSession returns a non-empty string', () => {
    const id = createSession(db);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('createSession returns a unique value each call', () => {
    const a = createSession(db);
    const b = createSession(db);
    expect(a).not.toBe(b);
  });

  // ── insertConversationMessage ──────────────────────────────────────────────

  it('insertConversationMessage inserts and returns a positive rowid', () => {
    const sid = createSession(db);
    const rowid = insertConversationMessage(db, {
      session_id: sid,
      stage: 'orient',
      role: 'user',
      content: 'Hello'
    });
    expect(typeof rowid).toBe('number');
    expect(rowid).toBeGreaterThan(0);
  });

  it('insertConversationMessage inserts for all valid roles', () => {
    const sid = createSession(db);
    for (const role of ['user', 'assistant', 'system']) {
      const rowid = insertConversationMessage(db, {
        session_id: sid,
        stage: 'orient',
        role,
        content: `${role} message`
      });
      expect(rowid).toBeGreaterThan(0);
    }
  });

  // ── getConversationHistory ─────────────────────────────────────────────────

  it('getConversationHistory returns empty array for unknown session', () => {
    const rows = getConversationHistory(db, 'nonexistent-session-id');
    expect(rows).toEqual([]);
  });

  it('getConversationHistory returns messages in created_at ASC order', async () => {
    const sid = createSession(db);

    insertConversationMessage(db, { session_id: sid, stage: 'orient', role: 'user', content: 'First' });
    // Ensure distinct timestamps by bumping the created_at value via tiny wait
    await new Promise((r) => setTimeout(r, 5));
    insertConversationMessage(db, { session_id: sid, stage: 'orient', role: 'assistant', content: 'Second' });
    await new Promise((r) => setTimeout(r, 5));
    insertConversationMessage(db, { session_id: sid, stage: 'orient', role: 'user', content: 'Third' });

    const rows = getConversationHistory(db, sid);
    expect(rows).toHaveLength(3);
    expect(rows[0].content).toBe('First');
    expect(rows[1].content).toBe('Second');
    expect(rows[2].content).toBe('Third');
  });

  it('getConversationHistory returns all messages for a session (100+ rows)', () => {
    const sid = createSession(db);
    const count = 105;
    for (let i = 0; i < count; i++) {
      insertConversationMessage(db, {
        session_id: sid,
        stage: 'orient',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`
      });
    }
    const rows = getConversationHistory(db, sid);
    expect(rows).toHaveLength(count);
  });

  it('getConversationHistory only returns messages for the requested session', () => {
    const sid1 = createSession(db);
    const sid2 = createSession(db);

    insertConversationMessage(db, { session_id: sid1, stage: 'orient', role: 'user', content: 'From session 1' });
    insertConversationMessage(db, { session_id: sid2, stage: 'orient', role: 'user', content: 'From session 2' });

    const rows1 = getConversationHistory(db, sid1);
    expect(rows1).toHaveLength(1);
    expect(rows1[0].content).toBe('From session 1');
  });

  // ── getIncompleteSessions ──────────────────────────────────────────────────

  it('getIncompleteSessions returns empty array when no sessions exist', () => {
    const sessions = getIncompleteSessions(db);
    expect(sessions).toEqual([]);
  });

  it('getIncompleteSessions returns session without COMPLETE marker', () => {
    const sid = createSession(db);
    insertConversationMessage(db, {
      session_id: sid, stage: 'orient', role: 'user', content: 'Hello'
    });
    insertConversationMessage(db, {
      session_id: sid, stage: 'orient', role: 'assistant', content: 'World'
    });

    const sessions = getIncompleteSessions(db);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const found = sessions.find((s) => s.session_id === sid);
    expect(found).toBeTruthy();
  });

  it('getIncompleteSessions excludes completed sessions', () => {
    const sid = createSession(db);
    insertConversationMessage(db, {
      session_id: sid, stage: 'orient', role: 'user', content: 'Hello'
    });
    // Mark complete
    insertConversationMessage(db, {
      session_id: sid, stage: 'promote', role: 'system', content: '[COMPLETE]'
    });

    const sessions = getIncompleteSessions(db);
    const found = sessions.find((s) => s.session_id === sid);
    expect(found).toBeUndefined();
  });

  // ── getDb idempotency ──────────────────────────────────────────────────────

  it('getDb does not throw on second call with same :memory: path', () => {
    // getDb on :memory: always creates a fresh DB, but calling the same
    // function twice should not throw any "duplicate column" or schema errors.
    expect(() => {
      getDb(':memory:');
      getDb(':memory:');
    }).not.toThrow();
  });
});
