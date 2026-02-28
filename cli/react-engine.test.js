import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { upsertToolRegistry } from './db.js';

// Mock llmTurn and normalizeUsage before importing react-engine
vi.mock('./api-client.js', () => ({
  llmTurn: vi.fn(),
  normalizeUsage: vi.fn((usage) => ({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0
  }))
}));

const { reactLoop, executeToolCall } = await import('./react-engine.js');
const { llmTurn } = await import('./api-client.js');

/** Collect all events from async generator. */
async function collectEvents(gen) {
  const events = [];
  for await (const evt of gen) events.push(evt);
  return events;
}

function baseOpts(overrides = {}) {
  return {
    provider: 'anthropic',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'You are helpful.',
    tools: [],
    messages: [{ role: 'user', content: 'Hello' }],
    maxTurns: 10,
    forgeConfig: {},
    db: null,
    ...overrides
  };
}

describe('reactLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('text-only response yields text + done', async () => {
    llmTurn.mockResolvedValueOnce({
      text: 'Hello! How can I help?',
      toolCalls: [],
      usage: { input_tokens: 10, output_tokens: 20 }
    });

    const events = await collectEvents(reactLoop(baseOpts()));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'text', content: 'Hello! How can I help?' });
    expect(events[1].type).toBe('done');
    expect(events[1].usage.inputTokens).toBe(10);
  });

  it('tool call yields tool_call + tool_result then continues loop', async () => {
    const db = makeTestDb();
    upsertToolRegistry(db, {
      tool_name: 'get_weather',
      spec_json: JSON.stringify({
        name: 'get_weather',
        mcpRouting: { endpoint: '/api/weather', method: 'GET', paramMap: {} }
      }),
      lifecycle_state: 'promoted'
    });

    // Turn 1: tool call
    llmTurn.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'tc1', name: 'get_weather', input: { city: 'NYC' } }],
      usage: { input_tokens: 5, output_tokens: 10 }
    });
    // Turn 2: text response after tool
    llmTurn.mockResolvedValueOnce({
      text: 'The weather is sunny.',
      toolCalls: [],
      usage: { input_tokens: 15, output_tokens: 25 }
    });

    // Mock fetch for tool execution
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ temp: 72 }))
    });

    const events = await collectEvents(reactLoop(baseOpts({
      db,
      forgeConfig: { api: { baseUrl: 'http://localhost:3000' } }
    })));

    const types = events.map(e => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('text');
    expect(types).toContain('done');

    global.fetch = undefined;
  });

  it('maxTurns safety limit terminates loop', async () => {
    // Always return a tool call to keep the loop going
    const db = makeTestDb();
    upsertToolRegistry(db, {
      tool_name: 'loopy',
      spec_json: JSON.stringify({ name: 'loopy', mcpRouting: { endpoint: '/loop', paramMap: {} } }),
      lifecycle_state: 'promoted'
    });

    llmTurn.mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'tc', name: 'loopy', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 }
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: () => Promise.resolve('{"ok":true}')
    });

    const events = await collectEvents(reactLoop(baseOpts({
      db,
      maxTurns: 2,
      forgeConfig: { api: { baseUrl: 'http://localhost:3000' } }
    })));

    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect(last.message).toContain('maxTurns');

    global.fetch = undefined;
  });

  it('shouldPause hook yields hitl event and stops', async () => {
    llmTurn.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'tc1', name: 'delete_user', input: { id: '123' } }],
      usage: { input_tokens: 5, output_tokens: 10 }
    });

    const events = await collectEvents(reactLoop(baseOpts({
      hooks: {
        shouldPause: (toolCall) => ({
          pause: true,
          message: `Confirm: ${toolCall.name}`
        })
      }
    })));

    expect(events).toHaveLength(2); // tool_call + hitl
    expect(events[0].type).toBe('tool_call');
    expect(events[1].type).toBe('hitl');
    expect(events[1].message).toBe('Confirm: delete_user');
  });

  it('onAfterToolCall returning warn yields tool_warning', async () => {
    const db = makeTestDb();
    upsertToolRegistry(db, {
      tool_name: 'risky',
      spec_json: JSON.stringify({ name: 'risky', mcpRouting: { endpoint: '/risk', paramMap: {} } }),
      lifecycle_state: 'promoted'
    });

    llmTurn
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'tc1', name: 'risky', input: {} }],
        usage: { input_tokens: 5, output_tokens: 5 }
      })
      .mockResolvedValueOnce({
        text: 'Done with warning.',
        toolCalls: [],
        usage: { input_tokens: 10, output_tokens: 10 }
      });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      text: () => Promise.resolve('{"ok":true}')
    });

    const events = await collectEvents(reactLoop(baseOpts({
      db,
      forgeConfig: { api: { baseUrl: 'http://localhost:3000' } },
      hooks: {
        onAfterToolCall: () => ({ outcome: 'warn', message: 'Suspicious result', verifierName: 'schema-v' })
      }
    })));

    const types = events.map(e => e.type);
    expect(types).toContain('tool_warning');
    expect(events.find(e => e.type === 'tool_warning').message).toBe('Suspicious result');

    global.fetch = undefined;
  });

  it('onAfterToolCall returning block yields hitl event', async () => {
    const db = makeTestDb();
    upsertToolRegistry(db, {
      tool_name: 'bad',
      spec_json: JSON.stringify({ name: 'bad', mcpRouting: { endpoint: '/bad', paramMap: {} } }),
      lifecycle_state: 'promoted'
    });

    llmTurn.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'tc1', name: 'bad', input: {} }],
      usage: { input_tokens: 5, output_tokens: 5 }
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      text: () => Promise.resolve('{"data":"blocked"}')
    });

    const events = await collectEvents(reactLoop(baseOpts({
      db,
      forgeConfig: { api: { baseUrl: 'http://localhost:3000' } },
      hooks: {
        onAfterToolCall: () => ({ outcome: 'block', message: 'Blocked!', verifierName: 'guard' })
      }
    })));

    const last = events[events.length - 1];
    expect(last.type).toBe('hitl');
    expect(last.message).toBe('Blocked!');

    global.fetch = undefined;
  });

  it('LLM error yields error event', async () => {
    llmTurn.mockRejectedValueOnce(new Error('API down'));

    const events = await collectEvents(reactLoop(baseOpts()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].message).toContain('API down');
  });
});

describe('executeToolCall', () => {
  it('returns 404 when tool not found', async () => {
    const db = makeTestDb();
    const result = await executeToolCall('nonexistent', {}, {}, db, null);
    expect(result.status).toBe(404);
    expect(result.error).toContain('not found');
  });

  it('forwards JWT in Authorization header', async () => {
    const db = makeTestDb();
    upsertToolRegistry(db, {
      tool_name: 'authed_tool',
      spec_json: JSON.stringify({ name: 'authed_tool', mcpRouting: { endpoint: '/api/secure', paramMap: {} } }),
      lifecycle_state: 'promoted'
    });

    let capturedHeaders;
    global.fetch = vi.fn().mockImplementation((url, opts) => {
      capturedHeaders = opts.headers;
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve('{"ok":true}')
      });
    });

    await executeToolCall('authed_tool', {}, { api: { baseUrl: 'http://localhost:3000' } }, db, 'my-jwt-token');
    expect(capturedHeaders.Authorization).toBe('Bearer my-jwt-token');

    global.fetch = undefined;
  });
});
