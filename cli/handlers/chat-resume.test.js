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

  it('returns 410 for expired/invalid token', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    await handleChatResume(makeReq({ resumeToken: 'invalid' }, token), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(410, expect.any(Object));
  });

  it('valid token + confirmed → SSE resumes', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);

    // Pause a state
    const resumeToken = ctx.hitlEngine.pause({
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

  it('valid token + rejected → cancellation', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const ctx = makeCtx(db);
    const resumeToken = ctx.hitlEngine.pause({ data: 'test' });

    const res = makeRes();
    await handleChatResume(
      makeReq({ resumeToken, confirmed: false }, token),
      res, ctx
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.body.message).toBe('Cancelled');
  });
});
