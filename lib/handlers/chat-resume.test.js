import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { createAuth } from '../auth.js';
import { makePromptStore } from '../prompt-store.js';
import { makePreferenceStore } from '../preference-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { HitlEngine } from '../hitl-engine.js';

// Mock react-engine
vi.mock('../react-engine.js', () => ({
  reactLoop: vi.fn()
}));

const { handleChatResume } = await import('./chat-resume.js');
const { reactLoop } = await import('../react-engine.js');

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.nosig`;
}

function makeReq(body, token) {
  const bodyStr = JSON.stringify(body);
  return {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
    on(event, handler) {
      if (event === 'data') handler(bodyStr);
      if (event === 'end') handler();
    }
  };
}

function makeRes() {
  const chunks = [];
  let responseBody;
  return {
    writeHead: vi.fn(),
    write: vi.fn((data) => chunks.push(data)),
    end: vi.fn((payload) => { if (payload) responseBody = JSON.parse(payload); }),
    _chunks: chunks,
    get body() { return responseBody; }
  };
}

function makeCtx(db) {
  const config = {
    auth: { mode: 'trust', claimsPath: 'sub' },
    defaultModel: 'claude-sonnet-4-6',
    defaultHitlLevel: 'cautious',
    allowUserModelSelect: false,
    allowUserHitlConfig: false,
    conversation: { window: 25 }
  };
  return {
    auth: createAuth(config.auth),
    promptStore: makePromptStore(config, db),
    preferenceStore: makePreferenceStore(config, db),
    conversationStore: new SqliteConversationStore(db),
    hitlEngine: new HitlEngine({ db }),
    db,
    config,
    env: { ANTHROPIC_API_KEY: 'test-key' }
  };
}

describe('handleChatResume', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    vi.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = makeRes();
    await handleChatResume(makeReq({ resumeToken: 'abc' }, null), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('returns 400 when resumeToken is missing', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    await handleChatResume(makeReq({ confirmed: true }, token), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(res.body.error).toMatch(/resumeToken/);
  });

  it('returns 501 when hitlEngine is absent in ctx', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    const ctx = makeCtx(db);
    ctx.hitlEngine = null;
    await handleChatResume(makeReq({ resumeToken: 'abc', confirmed: true }, token), res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
    expect(res.body.error).toMatch(/HITL engine not available/);
  });

  it('returns 200 Cancelled (not 501) when hitlEngine is null AND confirmed=false', async () => {
    // Guard ordering bug: cancellation must short-circuit before the hitlEngine null check.
    // A confirmed=false request has no need for the HITL engine at all.
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    const ctx = makeCtx(db);
    ctx.hitlEngine = null;
    await handleChatResume(makeReq({ resumeToken: 'some-token', confirmed: false }, token), res, ctx);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.message).toBe('Cancelled');
  });

  it('returns 404 for expired/invalid token when confirmed=true', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    await handleChatResume(makeReq({ resumeToken: 'invalid', confirmed: true }, token), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('valid token + confirmed → SSE resumes', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    // Pause a state
    const resumeToken = await ctx.hitlEngine.pause({
      conversationMessages: [{ role: 'user', content: 'test' }],
      sessionId: 'sess-1'
    });

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Resumed!' };
      yield { type: 'done', usage: {} };
    })());

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken, confirmed: true }, token),
      res, ctx
    );

    // Should have SSE headers
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream'
    }));
    const eventLines = res._chunks.join('');
    expect(eventLines).toContain('event: text');
    expect(eventLines).toContain('event: done');
  });

  it('confirmed: false (boolean) returns 200 Cancelled WITHOUT calling hitlEngine.resume', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    const resumeSpy = vi.fn();
    ctx.hitlEngine = {
      shouldPause: vi.fn(),
      resume: resumeSpy,
      pause: vi.fn()
    };

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken: 'some-token', confirmed: false }, token),
      res, ctx
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.message).toBe('Cancelled');
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('confirmed: "false" (string) returns 200 Cancelled WITHOUT calling hitlEngine.resume', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    const resumeSpy = vi.fn();
    ctx.hitlEngine = {
      shouldPause: vi.fn(),
      resume: resumeSpy,
      pause: vi.fn()
    };

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken: 'some-token', confirmed: 'false' }, token),
      res, ctx
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.message).toBe('Cancelled');
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('confirmed: true calls hitlEngine.resume and proceeds with streaming', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    // Pause a state
    const resumeToken = await ctx.hitlEngine.pause({
      conversationMessages: [{ role: 'user', content: 'test' }],
      sessionId: 'sess-confirm'
    });

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Resumed successfully!' };
      yield { type: 'done', usage: {} };
    })());

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken, confirmed: true }, token),
      res, ctx
    );

    // Should have SSE headers (streaming started)
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream'
    }));
    const eventLines = res._chunks.join('');
    expect(eventLines).toContain('event: text');
    expect(eventLines).toContain('event: done');
  });

  it('valid token + confirmed: false → cancellation (legacy test kept)', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    const resumeSpy = vi.spyOn(ctx.hitlEngine, 'resume');

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken: 'any-token', confirmed: false }, token),
      res, ctx
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.message).toBe('Cancelled');
    // CRITICAL: resume must NOT be called when user cancels
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  describe('audit logging', () => {
    it('inserts a chat_audit row on 401', async () => {
      const res = makeRes();
      await handleChatResume(makeReq({ resumeToken: 'abc' }, null), res, makeCtx(db));

      expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
      const row = db.prepare("SELECT * FROM chat_audit WHERE route = '/agent-api/chat/resume' AND status_code = 401 ORDER BY id DESC LIMIT 1").get();
      expect(row).toBeDefined();
      expect(row.status_code).toBe(401);
      expect(row.user_id).toBe('anon');
    });

    it('inserts a chat_audit row on successful resume', async () => {
      const token = makeJwt({ sub: 'audit-resume-user' });
      const ctx = makeCtx(db);

      // Pause a state to resume from
      const resumeToken = await ctx.hitlEngine.pause({
        conversationMessages: [{ role: 'user', content: 'test' }],
        sessionId: 'sess-audit'
      });

      reactLoop.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Resumed!' };
        yield { type: 'done', usage: {} };
      })());

      const res = makeRes();
      await handleChatResume(
        makeReq({ resumeToken, confirmed: true }, token),
        res, ctx
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream'
      }));
      const row = db.prepare("SELECT * FROM chat_audit WHERE route = '/agent-api/chat/resume' AND status_code = 200 ORDER BY id DESC LIMIT 1").get();
      expect(row).toBeDefined();
      expect(row.status_code).toBe(200);
      expect(row.user_id).toBe('audit-resume-user');
    });
  });
});
