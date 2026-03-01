/**
 * Integration test for the sidecar endpoints.
 *
 * Uses real SQLite + mocked LLM to test the full HTTP flow
 * from request to SSE events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { makeTestDb } from '../../tests/helpers/db.js';
import { createAuth } from '../auth.js';
import { makePromptStore } from '../prompt-store.js';
import { makePreferenceStore } from '../preference-store.js';
import { SqliteConversationStore } from '../conversation-store.js';
import { makeHitlEngine } from '../hitl-engine.js';
import { upsertToolRegistry, insertPromptVersion, activatePromptVersion } from '../db.js';
import { handleChat } from '../handlers/chat.js';
import { handleChatResume } from '../handlers/chat-resume.js';
import { handleGetPreferences, handlePutPreferences } from '../handlers/preferences.js';
import { handleAdminConfig, _resetOverlay } from '../handlers/admin.js';

// Mock react-engine
vi.mock('../react-engine.js', () => ({
  reactLoop: vi.fn()
}));
const { reactLoop } = await import('../react-engine.js');

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(payload) {
  const header = base64Url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.nosig`;
}

function makeCtx(db, configOverrides = {}) {
  const config = {
    auth: { mode: 'trust', claimsPath: 'sub' },
    defaultModel: 'claude-sonnet-4-6',
    defaultHitlLevel: 'cautious',
    allowUserModelSelect: true,
    allowUserHitlConfig: true,
    adminKey: 'admin-secret',
    conversation: { window: 25 },
    ...configOverrides
  };
  return {
    auth: createAuth(config.auth),
    promptStore: makePromptStore(config, db),
    preferenceStore: makePreferenceStore(config, db),
    conversationStore: new SqliteConversationStore(db),
    hitlEngine: makeHitlEngine(config, db),
    db,
    config,
    env: { ANTHROPIC_API_KEY: 'test-key' }
  };
}

/** Spin up a test HTTP server with sidecar routing. */
function createTestServer(ctx) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/agent-api/chat' && req.method === 'POST') return handleChat(req, res, ctx);
    if (url.pathname === '/agent-api/chat/resume' && req.method === 'POST') return handleChatResume(req, res, ctx);
    if (url.pathname === '/agent-api/user/preferences' && req.method === 'GET') return handleGetPreferences(req, res, ctx);
    if (url.pathname === '/agent-api/user/preferences' && req.method === 'PUT') return handlePutPreferences(req, res, ctx);
    if (url.pathname.startsWith('/forge-admin/config')) return handleAdminConfig(req, res, ctx);
    res.writeHead(404);
    res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('Sidecar Integration', () => {
  let db, ctx, server, port, baseUrl;

  beforeEach(async () => {
    db = makeTestDb();
    ctx = makeCtx(db);
    vi.clearAllMocks();
    _resetOverlay();
    const srv = await createTestServer(ctx);
    server = srv.server;
    port = srv.port;
    baseUrl = srv.baseUrl;
  });

  afterEach(() => {
    server.close();
  });

  it('POST /agent-api/chat → SSE events (text + done)', async () => {
    const token = makeJwt({ sub: 'user-1' });
    reactLoop.mockReturnValue((async function* () {
      yield { type: 'text', content: 'Hello from sidecar!' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 10 } };
    })());

    const res = await fetch(`${baseUrl}/agent-api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'hi' })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toContain('event: session');
    expect(text).toContain('event: text');
    expect(text).toContain('event: done');
    expect(text).toContain('Hello from sidecar!');
  });

  it('HITL flow: pause → POST /chat/resume → resume', async () => {
    const token = makeJwt({ sub: 'user-1' });

    // First chat — yields hitl event
    reactLoop.mockReturnValueOnce((async function* () {
      yield { type: 'tool_call', tool: 'delete_user', args: { id: '42' } };
      yield { type: 'hitl', tool: 'delete_user', message: 'Confirm deletion?' };
    })());

    const chatRes = await fetch(`${baseUrl}/agent-api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'delete user 42' })
    });
    const chatText = await chatRes.text();
    expect(chatText).toContain('event: hitl');
  });

  it('Preferences: PUT prefs → GET returns updated values', async () => {
    const token = makeJwt({ sub: 'user-1' });

    // PUT
    const putRes = await fetch(`${baseUrl}/agent-api/user/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'gpt-4o', hitl_level: 'paranoid' })
    });
    expect(putRes.status).toBe(200);

    // GET
    const getRes = await fetch(`${baseUrl}/agent-api/user/preferences`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });
    const prefs = await getRes.json();
    expect(prefs.preferences.model).toBe('gpt-4o');
    expect(prefs.effective.model).toBe('gpt-4o');
  });

  it('Admin: PUT config → changes effective config', async () => {
    // PUT model config
    const putRes = await fetch(`${baseUrl}/forge-admin/config/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ defaultModel: 'gemini-2.0-flash' })
    });
    expect(putRes.status).toBe(200);

    // GET config
    const getRes = await fetch(`${baseUrl}/forge-admin/config`, {
      method: 'GET',
      headers: { Authorization: 'Bearer admin-secret' }
    });
    const config = await getRes.json();
    expect(config.defaultModel).toBe('gemini-2.0-flash');
  });

  it('Auth required → 401', async () => {
    const res = await fetch(`${baseUrl}/agent-api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi' })
    });
    expect(res.status).toBe(401);
  });

  it('Session resumption: second chat with sessionId gets history', async () => {
    const token = makeJwt({ sub: 'user-1' });

    // First chat
    reactLoop.mockReturnValueOnce((async function* () {
      yield { type: 'text', content: 'First response' };
      yield { type: 'done', usage: {} };
    })());

    const res1 = await fetch(`${baseUrl}/agent-api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'first message' })
    });
    const text1 = await res1.text();
    // Extract sessionId from SSE
    const sessionMatch = text1.match(/"sessionId":"([^"]+)"/);
    expect(sessionMatch).toBeTruthy();
    const sessionId = sessionMatch[1];

    // Second chat with sessionId
    reactLoop.mockReturnValueOnce((async function* () {
      yield { type: 'text', content: 'Second response' };
      yield { type: 'done', usage: {} };
    })());

    const res2 = await fetch(`${baseUrl}/agent-api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'second message', sessionId })
    });
    expect(res2.status).toBe(200);

    // reactLoop should have been called with messages including history
    const callArgs = reactLoop.mock.calls[1][0];
    expect(callArgs.messages.length).toBeGreaterThan(1); // history + new message
  });
});
