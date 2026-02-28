import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { makePromptStore } from '../prompt-store.js';
import { makePreferenceStore } from '../preference-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { createAuth } from '../auth.js';
import { VerifierRunner } from '../verifier-runner.js';
import { upsertVerifier, upsertVerifierBinding, upsertToolRegistry } from '../db.js';
import { createHmac } from 'crypto';

// Mock react-engine to avoid real LLM calls
vi.mock('../react-engine.js', () => ({
  reactLoop: vi.fn()
}));

const { handleChat } = await import('./chat.js');
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

function makeReq(body, token) {
  const bodyStr = JSON.stringify(body);
  let dataHandler, endHandler;
  return {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
    on(event, handler) {
      if (event === 'data') { dataHandler = handler; }
      if (event === 'end') {
        endHandler = handler;
        // Simulate data arrival
        if (bodyStr) dataHandler(bodyStr);
        endHandler();
      }
    }
  };
}

function makeRes() {
  const chunks = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn((data) => chunks.push(data)),
    end: vi.fn(),
    _chunks: chunks,
    headersSent: false
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

describe('handleChat', () => {
  let db;
  beforeEach(() => {
    db = makeTestDb();
    vi.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const res = makeRes();
    await handleChat(makeReq({ message: 'hi' }, null), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it('returns 400 without message', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    await handleChat(makeReq({}, token), res, makeCtx(db));
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('streams SSE events for valid request', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    // Mock reactLoop as async generator
    reactLoop.mockImplementation(function* () {
      return (async function* () {
        yield { type: 'text', content: 'Hello!' };
        yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } };
      })();
    });
    // Actually need to return an async iterable
    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Hello!' };
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 20 } };
    })());

    await handleChat(makeReq({ message: 'hi' }, token), res, makeCtx(db));

    // Should have SSE headers
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream'
    }));

    // Should have session event + text + done
    const eventLines = res._chunks.join('');
    expect(eventLines).toContain('event: session');
    expect(eventLines).toContain('event: text');
    expect(eventLines).toContain('event: done');
  });

  it('creates a new session when sessionId not provided', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Hi' };
      yield { type: 'done', usage: {} };
    })());

    await handleChat(makeReq({ message: 'hi' }, token), res, makeCtx(db));

    // Session event should contain a sessionId
    const sessionChunk = res._chunks.find(c => c.includes('event: session'));
    expect(sessionChunk).toBeTruthy();
    const data = JSON.parse(sessionChunk.split('data: ')[1].trim());
    expect(data.sessionId).toBeTruthy();
  });

  it('persists messages to conversation store', async () => {
    const token = makeJwt({ sub: 'user-1' });
    const res = makeRes();
    const ctx = makeCtx(db);

    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Response' };
      yield { type: 'done', usage: {} };
    })());

    await handleChat(makeReq({ message: 'hello' }, token), res, ctx);

    // Check conversation was persisted
    const sessionChunk = res._chunks.find(c => c.includes('event: session'));
    const sessionData = JSON.parse(sessionChunk.split('data: ')[1].trim());

    const history = await ctx.conversationStore.getHistory(sessionData.sessionId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].content).toBe('hello');
    expect(history[0].role).toBe('user');
  });

  describe('verifier hooks', () => {
    it('registered verifier producing warn → SSE stream contains tool_warning event', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();

      // Register a tool + verifier that warns
      upsertToolRegistry(db, { tool_name: 'test_tool', lifecycle_state: 'promoted', spec_json: '{"name":"test_tool","description":"test","schema":{}}' });
      upsertVerifier(db, { verifier_name: 'warn-check', type: 'pattern', aciru_order: 'I-0001', spec_json: JSON.stringify({ reject: 'bad', outcome: 'warn' }) });
      upsertVerifierBinding(db, { verifier_name: 'warn-check', tool_name: 'test_tool' });

      const verifierRunner = new VerifierRunner(db);
      const ctx = makeCtx(db, { verifierRunner });

      // Mock reactLoop to emit a tool_warning
      reactLoop.mockReturnValue((async function* () {
        yield { type: 'tool_call', tool: 'test_tool', args: {}, id: 'tc-1' };
        yield { type: 'tool_result', tool: 'test_tool', result: { text: 'bad result' }, id: 'tc-1' };
        yield { type: 'tool_warning', tool: 'test_tool', message: 'Result matches reject pattern: bad', verifier: 'warn-check' };
        yield { type: 'done', usage: {} };
      })());

      await handleChat(makeReq({ message: 'hi' }, token), res, ctx);

      const eventLines = res._chunks.join('');
      expect(eventLines).toContain('event: tool_warning');
    });

    it('registered verifier producing block → SSE stream contains hitl event', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();

      upsertToolRegistry(db, { tool_name: 'block_tool', lifecycle_state: 'promoted', spec_json: '{"name":"block_tool","description":"test","schema":{}}' });
      upsertVerifier(db, { verifier_name: 'block-check', type: 'schema', aciru_order: 'A-0001', spec_json: JSON.stringify({ required: ['id'] }) });
      upsertVerifierBinding(db, { verifier_name: 'block-check', tool_name: 'block_tool' });

      const verifierRunner = new VerifierRunner(db);
      const ctx = makeCtx(db, { verifierRunner });

      // Mock reactLoop to emit hitl from verifier block
      reactLoop.mockReturnValue((async function* () {
        yield { type: 'tool_call', tool: 'block_tool', args: {}, id: 'tc-2' };
        yield { type: 'hitl', tool: 'block_tool', message: 'Verifier blocked tool result', verifier: 'block-check' };
      })());

      await handleChat(makeReq({ message: 'do something' }, token), res, ctx);

      const eventLines = res._chunks.join('');
      expect(eventLines).toContain('event: hitl');
    });

    it('verifierRunner is loaded from DB on each request', async () => {
      const token = makeJwt({ sub: 'user-1' });
      const res = makeRes();

      const verifierRunner = new VerifierRunner(db);
      const loadSpy = vi.spyOn(verifierRunner, 'loadFromDb');

      const ctx = makeCtx(db, { verifierRunner });

      reactLoop.mockReturnValue((async function* () {
        yield { type: 'text', content: 'Hi' };
        yield { type: 'done', usage: {} };
      })());

      await handleChat(makeReq({ message: 'hi' }, token), res, ctx);

      expect(loadSpy).toHaveBeenCalledWith(db);
    });
  });
});
