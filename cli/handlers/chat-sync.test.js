import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { makePromptStore } from '../prompt-store.js';
import { makePreferenceStore } from '../preference-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { createAuth } from '../auth.js';
import { upsertToolRegistry } from '../db.js';

// Mock react-engine to avoid real LLM calls
vi.mock('../react-engine.js', () => ({
  reactLoop: vi.fn()
}));

const { handleChatSync } = await import('./chat-sync.js');
const { reactLoop } = await import('../react-engine.js');

function base64Url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.nosig`;
}

function makeReq(body, token, url) {
  const bodyStr = JSON.stringify(body);
  let dataHandler, endHandler;
  return {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
    url: url || '/agent-api/chat-sync',
    on(event, handler) {
      if (event === 'data') { dataHandler = handler; }
      if (event === 'end') {
        endHandler = handler;
        if (bodyStr) dataHandler(bodyStr);
        endHandler();
      }
    }
  };
}

function makeRes() {
  let body = '';
  return {
    writeHead: vi.fn(),
    end: vi.fn((data) => { body = data; }),
    headersSent: false,
    _body() { return body ? JSON.parse(body) : null; }
  };
}

function makeCtx(db, opts = {}) {
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
    verifierRunner: opts.verifierRunner ?? null,
    hitlEngine: opts.hitlEngine ?? null,
    db,
    config,
    env: { ANTHROPIC_API_KEY: 'test-key' }
  };
}

describe('handleChatSync', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    vi.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = makeRes();
    await handleChatSync(makeReq({ message: 'hi' }, null), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('returns 400 without message', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    await handleChatSync(makeReq({}, token), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('authenticates via ?token= query param', async () => {
    const token = makeJwt({ sub: 'user-qp' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Hi' };
      yield { type: 'done', usage: {} };
    })());

    await handleChatSync(makeReq({ message: 'hi' }, null, `/agent-api/chat-sync?token=${token}`), res, makeCtx(db));

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = res._body();
    expect(body.message).toBe('Hi');
  });

  it('returns JSON with message and conversationId for valid request', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Hello ' };
      yield { type: 'text', content: 'world!' };
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } };
    })());

    await handleChatSync(makeReq({ message: 'hi' }, token), res, makeCtx(db));

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = res._body();
    expect(body.conversationId).toBeTruthy();
    expect(body.message).toBe('Hello world!');
    expect(body.toolCalls).toEqual([]);
    expect(body.warnings).toEqual([]);
    expect(body.flags).toEqual([]);
  });

  it('aggregates toolCalls and tool_result', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'tool_call', id: 'tc-1', tool: 'get_data', args: { id: 42 } };
      yield { type: 'tool_result', id: 'tc-1', result: { value: 'ok' } };
      yield { type: 'text', content: 'Done' };
      yield { type: 'done', usage: {} };
    })());

    await handleChatSync(makeReq({ message: 'fetch' }, token), res, makeCtx(db));

    const body = res._body();
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0]).toEqual({ id: 'tc-1', name: 'get_data', args: { id: 42 }, result: { value: 'ok' } });
    expect(body.message).toBe('Done');
  });

  it('aggregates warnings', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'tool_warning', tool: 'risky_tool', message: 'Watch out', verifier: 'v1' };
      yield { type: 'text', content: 'ok' };
      yield { type: 'done', usage: {} };
    })());

    await handleChatSync(makeReq({ message: 'do it' }, token), res, makeCtx(db));

    const body = res._body();
    expect(body.warnings).toEqual([{ tool: 'risky_tool', message: 'Watch out', verifier: 'v1' }]);
  });

  it('returns 409 on HITL pause', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'hitl', resumeToken: 'rt-abc', tool: 'dangerous_tool', message: 'Needs confirmation' };
    })());

    await handleChatSync(makeReq({ message: 'do dangerous' }, token), res, makeCtx(db));

    expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    const body = res._body();
    expect(body.resumeToken).toBe('rt-abc');
    expect(body.tool).toBe('dangerous_tool');
    expect(body.message).toBe('Needs confirmation');
  });

  it('error events go into flags', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'error', message: 'Something broke' };
      yield { type: 'done', usage: {} };
    })());

    await handleChatSync(makeReq({ message: 'hi' }, token), res, makeCtx(db));

    const body = res._body();
    expect(body.flags).toEqual(['Something broke']);
  });

  it('reactLoop exception goes into flags', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      throw new Error('LLM provider timeout');
    })());

    await handleChatSync(makeReq({ message: 'hi' }, token), res, makeCtx(db));

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const body = res._body();
    expect(body.flags).toEqual(['LLM provider timeout']);
  });

  it('persists messages to conversation store', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    const ctx = makeCtx(db);

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Response' };
      yield { type: 'done', usage: {} };
    })());

    await handleChatSync(makeReq({ message: 'hello' }, token), res, ctx);

    const body = res._body();
    const history = await ctx.conversationStore.getHistory(body.conversationId);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('hello');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Response');
  });
});
