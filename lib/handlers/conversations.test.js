import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { handleConversations } from './conversations.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(method, url) {
  return {
    method,
    url,
    headers: {}
  };
}

function makeRes() {
  let body;
  const extraHeaders = {};
  return {
    setHeader: (name, value) => { extraHeaders[name.toLowerCase()] = value; },
    writeHead: (code, _headers) => { body = { statusCode: code }; },
    end: (data) => {
      try { body.data = JSON.parse(data); } catch { body.data = data; }
    },
    get statusCode() { return body?.statusCode; },
    get body() { return body?.data; },
    getHeader: (name) => extraHeaders[name.toLowerCase()],
    _getResponse() { return body; }
  };
}

const UNAUTHENTICATED = Symbol('unauthenticated');

/**
 * Returns a fake auth object.
 *   makeAuth(UNAUTHENTICATED) — auth fails (authenticated: false)
 *   makeAuth(null)            — authenticated but no identity claim (trust mode)
 *   makeAuth('user-abc')      — fully authenticated with that userId
 */
function makeAuth(userId = 'user-abc') {
  return {
    authenticate: () => userId === UNAUTHENTICATED
      ? { authenticated: false, error: 'Unauthorized' }
      : { authenticated: true, userId }
  };
}

function makeCtx(db, userId = 'user-abc') {
  return {
    auth: makeAuth(userId),
    conversationStore: new SqliteConversationStore(db)
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('handleConversations', () => {
  let db, ctx;

  beforeEach(() => {
    db = makeTestDb();
    ctx = makeCtx(db);
  });

  // 1. 401 when not authenticated
  it('returns 401 when auth is not authenticated', async () => {
    const res = makeRes();
    const unauthCtx = {
      auth: makeAuth(UNAUTHENTICATED),
      conversationStore: new SqliteConversationStore(db)
    };
    await handleConversations(makeReq('GET', '/agent-api/conversations'), res, unauthCtx);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  // 2. 401 when userId is null (trust mode — authenticated but no sub claim)
  it('returns 401 when userId is null (no identity claim)', async () => {
    const res = makeRes();
    const noIdentityCtx = {
      auth: makeAuth(null), // null → authenticated but no sub claim
      conversationStore: new SqliteConversationStore(db)
    };
    await handleConversations(makeReq('GET', '/agent-api/conversations'), res, noIdentityCtx);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('user identity');
  });

  // 3. GET /agent-api/conversations — lists only sessions for this user
  it('GET /agent-api/conversations — lists only sessions for user-abc', async () => {
    const store = ctx.conversationStore;
    // Seed two sessions for user-abc
    await store.persistMessage('sess-abc-1', 'run', 'user', 'hello', null, 'user-abc');
    await store.persistMessage('sess-abc-2', 'run', 'user', 'world', null, 'user-abc');
    // Seed one session for user-xyz — should NOT appear
    await store.persistMessage('sess-xyz-1', 'run', 'user', 'other', null, 'user-xyz');

    const res = makeRes();
    await handleConversations(makeReq('GET', '/agent-api/conversations'), res, ctx);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('sessions');
    const sessionIds = res.body.sessions.map(s => s.sessionId);
    expect(sessionIds).toContain('sess-abc-1');
    expect(sessionIds).toContain('sess-abc-2');
    expect(sessionIds).not.toContain('sess-xyz-1');
    expect(res.body.sessions).toHaveLength(2);
  });

  // 4. GET /agent-api/conversations/:sessionId — 404 when session doesn't exist
  it('GET /agent-api/conversations/:sessionId — 404 when session does not exist', async () => {
    const res = makeRes();
    await handleConversations(makeReq('GET', '/agent-api/conversations/no-such-session'), res, ctx);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // 5. GET /agent-api/conversations/:sessionId — 403 when session owned by different user
  it('GET /agent-api/conversations/:sessionId — 403 when session owned by different user', async () => {
    // Seed a session for user-xyz
    await ctx.conversationStore.persistMessage('sess-xyz-1', 'run', 'user', 'hello', null, 'user-xyz');

    const res = makeRes();
    // user-abc tries to read user-xyz's session
    await handleConversations(makeReq('GET', '/agent-api/conversations/sess-xyz-1'), res, ctx);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  // 6. GET /agent-api/conversations/:sessionId — 200 with history when owned by this user
  it('GET /agent-api/conversations/:sessionId — 200 with history when owned by caller', async () => {
    await ctx.conversationStore.persistMessage('sess-abc-1', 'run', 'user', 'hello', null, 'user-abc');
    await ctx.conversationStore.persistMessage('sess-abc-1', 'run', 'assistant', 'hi there', null, 'user-abc');

    const res = makeRes();
    await handleConversations(makeReq('GET', '/agent-api/conversations/sess-abc-1'), res, ctx);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('sessionId', 'sess-abc-1');
    expect(res.body).toHaveProperty('messages');
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[1].role).toBe('assistant');
  });

  // 7. DELETE /agent-api/conversations/:sessionId — 404 when session doesn't exist
  it('DELETE /agent-api/conversations/:sessionId — 404 when session does not exist', async () => {
    const res = makeRes();
    await handleConversations(makeReq('DELETE', '/agent-api/conversations/no-such-session'), res, ctx);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // 8. DELETE /agent-api/conversations/:sessionId — 403 when owned by different user
  it('DELETE /agent-api/conversations/:sessionId — 403 when session owned by different user', async () => {
    await ctx.conversationStore.persistMessage('sess-xyz-1', 'run', 'user', 'hello', null, 'user-xyz');

    const res = makeRes();
    // user-abc tries to delete user-xyz's session
    await handleConversations(makeReq('DELETE', '/agent-api/conversations/sess-xyz-1'), res, ctx);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);
  });

  // 9. DELETE /agent-api/conversations/:sessionId — 200 deleted:true when owned by this user
  it('DELETE /agent-api/conversations/:sessionId — 200 with deleted:true when owner deletes', async () => {
    await ctx.conversationStore.persistMessage('sess-abc-1', 'run', 'user', 'hello', null, 'user-abc');

    const res = makeRes();
    await handleConversations(makeReq('DELETE', '/agent-api/conversations/sess-abc-1'), res, ctx);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    // Verify session is truly gone — getSessionUserId returns undefined
    const ownerAfter = await ctx.conversationStore.getSessionUserId('sess-abc-1');
    expect(ownerAfter).toBeUndefined();
  });

  // 10. 405 for unsupported method
  it('returns 405 for unsupported method (POST)', async () => {
    const res = makeRes();
    await handleConversations(makeReq('POST', '/agent-api/conversations'), res, ctx);
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toMatch(/method not allowed/i);
  });
});
