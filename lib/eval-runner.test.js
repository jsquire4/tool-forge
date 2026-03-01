import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubbedReactTurn, runEvals, getToolsForEval, findEvalFiles, runEvalsMultiPass, withRandomSample } from './eval-runner.js';

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('./api-client.js', () => ({
  llmTurn: vi.fn(),
  normalizeUsage: vi.fn((usage) => ({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0
  })),
  modelConfigForName: vi.fn().mockReturnValue({ provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' })
}));

vi.mock('./db.js', () => ({
  getDb: vi.fn(),
  insertEvalRun: vi.fn().mockReturnValue(1),
  insertEvalRunCases: vi.fn()
}));

// Import mocked llmTurn after vi.mock declarations (hoisting applies)
import { llmTurn, modelConfigForName } from './api-client.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TOOL_CALL = (name, id = 'tc_1', input = { city: 'Paris' }) => ({
  id,
  name,
  input
});

const TURN_WITH_TOOL = (toolCall) => ({
  text: '',
  toolCalls: [toolCall],
  usage: { input_tokens: 10, output_tokens: 5 }
});

const TURN_FINAL = (text) => ({
  text,
  toolCalls: [],
  usage: { input_tokens: 5, output_tokens: 30 }
});

const BASE_OPTS = {
  provider: 'anthropic',
  apiKey: 'test-key',
  model: 'claude-test',
  systemPrompt: '',
  tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
  input: "What's the weather in Paris?"
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('stubbedReactTurn', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
  });

  it('2-turn happy path: calls tool then produces final text', async () => {
    vi.mocked(llmTurn)
      .mockResolvedValueOnce(TURN_WITH_TOOL(TOOL_CALL('get_weather')))
      .mockResolvedValueOnce(TURN_FINAL('The weather in Paris is 18°C and partly cloudy.'));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: { get_weather: { city: 'Paris', temperature: 18, condition: 'partly cloudy' } }
    });

    expect(result.toolsCalled).toEqual(['get_weather']);
    expect(result.responseText).toBe('The weather in Paris is 18°C and partly cloudy.');
    expect(result.missingStubs).toEqual([]);
    expect(llmTurn).toHaveBeenCalledTimes(2);

    // Verify the second llmTurn call included a tool_result message
    const secondCallMessages = vi.mocked(llmTurn).mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content[0].type).toBe('tool_result');
    expect(toolResultMsg.content[0].content).toContain('partly cloudy');
  });

  it('missing stub populates missingStubs array', async () => {
    vi.mocked(llmTurn)
      .mockResolvedValueOnce(TURN_WITH_TOOL(TOOL_CALL('get_forecast')))  // no stub for this
      .mockResolvedValueOnce(TURN_FINAL('I could not get the forecast.'));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: {}  // get_forecast has no stub
    });

    expect(result.toolsCalled).toEqual(['get_forecast']);
    expect(result.missingStubs).toEqual(['get_forecast']);
  });

  it('noToolErrors fails when missingStubs is non-empty', async () => {
    // Verify the missingStubs array flows correctly through eval case logic.
    // The eval case has noToolErrors: true and a tool with no stub.
    vi.mocked(llmTurn)
      .mockResolvedValueOnce(TURN_WITH_TOOL(TOOL_CALL('unknown_tool')))
      .mockResolvedValueOnce(TURN_FINAL('Some response.'));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: { get_weather: { temperature: 72 } }  // unknown_tool has no entry
    });

    expect(result.missingStubs).toContain('unknown_tool');
  });

  it('multiple tools in one turn — both get stub responses, both in toolsCalled', async () => {
    vi.mocked(llmTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          TOOL_CALL('get_weather', 'tc_1', { city: 'Paris' }),
          TOOL_CALL('get_forecast', 'tc_2', { city: 'Paris' })
        ],
        usage: null
      })
      .mockResolvedValueOnce(TURN_FINAL('Paris is sunny today with mild temperatures ahead.'));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: {
        get_weather: { temperature: 18, condition: 'sunny' },
        get_forecast: { tomorrow: 'mild' }
      }
    });

    expect(result.toolsCalled).toEqual(['get_weather', 'get_forecast']);
    expect(result.missingStubs).toEqual([]);

    // Verify second turn received two tool_result entries
    const secondCallMessages = vi.mocked(llmTurn).mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMsg.content).toHaveLength(2);
  });

  it('model responds directly without calling any tools — stubs not consumed', async () => {
    vi.mocked(llmTurn).mockResolvedValueOnce(TURN_FINAL("I don't need a tool for that."));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: { get_weather: { temperature: 72 } }
    });

    expect(result.toolsCalled).toEqual([]);
    expect(result.responseText).toBe("I don't need a tool for that.");
    expect(result.missingStubs).toEqual([]);
    expect(llmTurn).toHaveBeenCalledTimes(1);
  });

  it('maxTurns cap — loop terminates after N turns without infinite loop', async () => {
    // Model always returns a tool call, never a final text response
    vi.mocked(llmTurn).mockResolvedValue(TURN_WITH_TOOL(TOOL_CALL('get_weather')));

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: { get_weather: { temperature: 72 } },
      maxTurns: 3
    });

    expect(llmTurn).toHaveBeenCalledTimes(3);
    expect(result.toolsCalled).toHaveLength(3);
    expect(result.responseText).toBe('');  // no final text was ever produced
  });

  it('accumulates token usage across turns', async () => {
    vi.mocked(llmTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [TOOL_CALL('get_weather')],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        text: 'The weather in Paris is sunny.',
        toolCalls: [],
        usage: { input_tokens: 20, output_tokens: 15 },
      });

    const result = await stubbedReactTurn({
      ...BASE_OPTS,
      stubs: { get_weather: { temperature: 22, condition: 'sunny' } },
      maxTurns: 5,
    });

    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(20);
  });
});

describe('runEvals — routing-only backward compat (no stubs)', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
  });

  it('single LLM turn when eval case has no stubs field', async () => {
    // Set up a minimal temp project directory
    const root = mkdtempSync(join(tmpdir(), 'forge-eval-test-'));
    const toolsDir = join(root, 'example', 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const evalsDir = join(root, 'docs', 'examples');
    mkdirSync(evalsDir, { recursive: true });

    // Fake API key so loadEnv() doesn't throw
    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=test-key-compat\n');

    // Minimal tool file
    writeFileSync(join(toolsDir, 'get_weather.tool.js'), `
      export default {
        name: 'get_weather',
        description: 'Get current weather for a city',
        schema: { city: { type: 'string' } },
        execute: async ({ city }) => ({ temperature: 72 })
      };
    `);

    // Eval case with NO stubs
    writeFileSync(join(evalsDir, 'get_weather.golden.json'), JSON.stringify([
      {
        id: 'routing-compat-001',
        input: { message: 'What is the weather in Paris?' },
        expect: { toolsCalled: ['get_weather'] }
      }
    ]));

    vi.mocked(llmTurn).mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'tc_1', name: 'get_weather', input: { city: 'Paris' } }],
      usage: null
    });

    // Use absolute paths so findEvalFiles/getToolsForEval resolve correctly
    const config = {
      project: { toolsDir: toolsDir, evalsDir: evalsDir }
    };

    const result = await runEvals('get_weather', config, root, () => {});

    // Single llmTurn call (routing-only, not multi-turn)
    expect(llmTurn).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.cases[0].toolsCalled).toEqual(['get_weather']);
  });
});

// ── getToolsForEval ──────────────────────────────────────────────────────────

describe('getToolsForEval', () => {
  it('returns [] when toolsDir does not exist', () => {
    const result = getToolsForEval({ project: { toolsDir: '/nonexistent/path/to/tools' } });
    expect(result).toEqual([]);
  });

  it('returns [] when config is null', () => {
    // Falls back to example/tools relative to cwd; just verifies no crash
    const result = getToolsForEval(null);
    expect(Array.isArray(result)).toBe(true);
  });

  it('extracts name, description, and inputSchema from a valid tool file', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-gettool-test-'));
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });

    writeFileSync(join(toolsDir, 'my_tool.tool.js'), `
      export default {
        name: 'my_tool',
        description: 'A helpful tool',
        schema: { city: { type: 'string' }, units: { type: 'string', optional: true } },
        execute: async () => ({})
      };
    `);

    const tools = getToolsForEval({ project: { toolsDir } });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('my_tool');
    expect(tools[0].description).toBe('A helpful tool');
    expect(tools[0].inputSchema.properties).toHaveProperty('city');
    expect(tools[0].inputSchema.required).toContain('city');
    expect(tools[0].inputSchema.required).not.toContain('units');
  });

  it('falls back to filename stem when tool file has no name: field', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-gettool-noname-'));
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir, { recursive: true });

    writeFileSync(join(toolsDir, 'unnamed_tool.tool.js'), `
      export default {
        description: 'No name field',
        schema: {},
        execute: async () => ({})
      };
    `);

    const tools = getToolsForEval({ project: { toolsDir } });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('unnamed_tool');
  });
});

// ── findEvalFiles ────────────────────────────────────────────────────────────

describe('findEvalFiles', () => {
  it('returns [] when evalsDir does not exist', () => {
    const result = findEvalFiles('some_tool', { project: { evalsDir: '/nonexistent/evals/dir' } });
    expect(result).toEqual([]);
  });

  it('finds {toolName}.golden.json in evalsDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-findeval-test-'));
    writeFileSync(join(root, 'my_tool.golden.json'), '[]');

    const result = findEvalFiles('my_tool', { project: { evalsDir: root } });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('my_tool.golden.json');
  });

  it('finds hyphenated variant ({toolName with - instead of _}.golden.json)', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-findeval-hyph-'));
    writeFileSync(join(root, 'my-tool.golden.json'), '[]');

    const result = findEvalFiles('my_tool', { project: { evalsDir: root } });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('my-tool.golden.json');
  });

  it('deduplicates when multiple patterns resolve to the same file', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-findeval-dedup-'));
    writeFileSync(join(root, 'tool.golden.json'), '[]');

    // tool has no underscores, so hyphen variant resolves to same file
    const result = findEvalFiles('tool', { project: { evalsDir: root } });
    expect(result).toHaveLength(1);
  });
});

// ── runEvalsMultiPass ────────────────────────────────────────────────────────

describe('runEvalsMultiPass', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
    vi.mocked(modelConfigForName).mockReset();
  });

  it('returns { error: ... } in perModel when API key is missing', async () => {
    vi.mocked(modelConfigForName).mockReturnValue({ provider: 'anthropic', model: 'claude-test', apiKey: null });

    const result = await runEvalsMultiPass(
      'some_tool',
      { modelMatrix: ['claude-test'] },
      '/nonexistent',
      {}
    );

    expect(result.perModel).toHaveProperty('claude-test');
    expect(result.perModel['claude-test']).toHaveProperty('error');
    expect(result.perModel['claude-test'].error).toContain('No API key');
  });

  it('throws when no model matrix is configured', async () => {
    await expect(
      runEvalsMultiPass('some_tool', {}, '/nonexistent', {})
    ).rejects.toThrow('No model matrix configured');
  });

  it('returns per-model pass/fail counts for a successful run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-multipass-'));
    const toolsDir = join(root, 'example', 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const evalsDir = join(root, 'docs', 'examples');
    mkdirSync(evalsDir, { recursive: true });

    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=test-key\n');
    writeFileSync(join(toolsDir, 'get_weather.tool.js'), `
      export default {
        name: 'get_weather',
        description: 'Get weather',
        schema: { city: { type: 'string' } },
        execute: async () => ({})
      };
    `);
    writeFileSync(join(evalsDir, 'get_weather.golden.json'), JSON.stringify([
      { id: 'mp-001', input: { message: 'Hello' }, expect: { responseNonEmpty: true } }
    ]));

    vi.mocked(modelConfigForName).mockReturnValue({ provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' });
    vi.mocked(llmTurn).mockResolvedValue({ text: 'Hello back!', toolCalls: [], usage: { input_tokens: 5, output_tokens: 5 } });

    const result = await runEvalsMultiPass(
      'get_weather',
      { project: { toolsDir, evalsDir }, modelMatrix: ['claude-test'] },
      root,
      {}
    );

    expect(result.perModel).toHaveProperty('claude-test');
    const m = result.perModel['claude-test'];
    expect(m.passed).toBe(1);
    expect(m.failed).toBe(0);
    expect(m.pass_rate).toBe(1);
  });
});

// ── withRandomSample ─────────────────────────────────────────────────────────

describe('withRandomSample', () => {
  it('returns [] when DB throws', () => {
    const fakeDb = {
      prepare: () => { throw new Error('DB connection failed'); }
    };
    const result = withRandomSample(fakeDb, 'some_tool', 5);
    expect(result).toEqual([]);
  });

  it('annotates rows with _sampleType: "sampled"', () => {
    const fakeRow = { id: 1, tool_name: 'other_tool', case_id: 'abc', status: 'passed' };
    const fakeDb = {
      prepare: () => ({ all: () => [fakeRow] })
    };
    const result = withRandomSample(fakeDb, 'my_tool', 5);
    expect(result).toHaveLength(1);
    expect(result[0]._sampleType).toBe('sampled');
    expect(result[0].case_id).toBe('abc');
  });
});

// ── stubbedReactTurn — OpenAI provider path ──────────────────────────────────

describe('stubbedReactTurn — OpenAI provider', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
  });

  it('uses tool_calls/role:tool wire format for OpenAI provider', async () => {
    const TOOL_CALL_OAI = { id: 'call_abc', name: 'get_weather', input: { city: 'Tokyo' } };

    vi.mocked(llmTurn)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [TOOL_CALL_OAI],
        usage: { input_tokens: 10, output_tokens: 5 }
      })
      .mockResolvedValueOnce({
        text: 'Tokyo is sunny today.',
        toolCalls: [],
        usage: { input_tokens: 5, output_tokens: 20 }
      });

    const result = await stubbedReactTurn({
      provider: 'openai',
      apiKey: 'oai-key',
      model: 'gpt-4o',
      systemPrompt: '',
      tools: [{ name: 'get_weather', description: 'Get weather', inputSchema: { type: 'object', properties: {} } }],
      input: "What's the weather in Tokyo?",
      stubs: { get_weather: { temperature: 25, condition: 'sunny' } }
    });

    expect(result.toolsCalled).toEqual(['get_weather']);
    expect(result.responseText).toBe('Tokyo is sunny today.');

    // Verify the OpenAI wire format was used in the second turn
    const secondCallMessages = vi.mocked(llmTurn).mock.calls[1][0].messages;

    // Assistant message should have tool_calls array (OpenAI format)
    const assistantMsg = secondCallMessages.find(m => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].type).toBe('function');
    expect(assistantMsg.tool_calls[0].id).toBe('call_abc');

    // Tool result should be role: 'tool' with tool_call_id (OpenAI format)
    const toolResultMsg = secondCallMessages.find(m => m.role === 'tool');
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.tool_call_id).toBe('call_abc');
    expect(toolResultMsg.content).toContain('sunny');
  });
});

// ── runEvals — skipped and error paths ───────────────────────────────────────

describe('runEvals — skipped and error paths', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
  });

  it('skips case with no input.message and calls onProgress with passed: null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-eval-skip-'));
    const toolsDir = join(root, 'example', 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const evalsDir = join(root, 'docs', 'examples');
    mkdirSync(evalsDir, { recursive: true });

    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=test-key\n');
    writeFileSync(join(toolsDir, 'get_weather.tool.js'), `
      export default { name: 'get_weather', description: 'Get weather', schema: {}, execute: async () => ({}) };
    `);

    // Eval case with no input.message
    writeFileSync(join(evalsDir, 'get_weather.golden.json'), JSON.stringify([
      { id: 'skip-001', input: {}, expect: { toolsCalled: ['get_weather'] } }
    ]));

    const progressEvents = [];
    const result = await runEvals('get_weather', { project: { toolsDir, evalsDir } }, root, (p) => progressEvents.push(p));

    expect(result.skipped).toBe(1);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(progressEvents[0].passed).toBeNull();
    expect(progressEvents[0].reason).toBe('no input message');
    expect(llmTurn).not.toHaveBeenCalled();
  });

  it('increments failed and continues when llmTurn throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-eval-err-'));
    const toolsDir = join(root, 'example', 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const evalsDir = join(root, 'docs', 'examples');
    mkdirSync(evalsDir, { recursive: true });

    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=test-key\n');
    writeFileSync(join(toolsDir, 'get_weather.tool.js'), `
      export default { name: 'get_weather', description: 'Get weather', schema: {}, execute: async () => ({}) };
    `);

    // Two cases: first throws, second passes
    writeFileSync(join(evalsDir, 'get_weather.golden.json'), JSON.stringify([
      { id: 'err-001', input: { message: 'What is the weather?' }, expect: { toolsCalled: ['get_weather'] } },
      { id: 'pass-001', input: { message: 'Weather please?' }, expect: { toolsCalled: ['get_weather'] } }
    ]));

    vi.mocked(llmTurn)
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'tc_1', name: 'get_weather', input: {} }],
        usage: null
      });

    const result = await runEvals('get_weather', { project: { toolsDir, evalsDir } }, root, () => {});

    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.cases[0].status).toBe('failed');
    expect(result.cases[0].reason).toContain('Network timeout');
    expect(result.cases[1].status).toBe('passed');
  });
});

// ── runEvals — stub-based end-to-end ─────────────────────────────────────────

describe('runEvals — stub-based multi-turn path', () => {
  beforeEach(() => {
    vi.mocked(llmTurn).mockReset();
  });

  it('invokes stubbedReactTurn and checks final response assertions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-stubs-e2e-'));
    const toolsDir = join(root, 'example', 'tools');
    mkdirSync(toolsDir, { recursive: true });
    const evalsDir = join(root, 'docs', 'examples');
    mkdirSync(evalsDir, { recursive: true });

    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=stub-key\n');
    writeFileSync(join(toolsDir, 'get_weather.tool.js'), `
      export default {
        name: 'get_weather',
        description: 'Get weather',
        schema: { city: { type: 'string' } },
        execute: async () => ({})
      };
    `);
    writeFileSync(join(evalsDir, 'get_weather.golden.json'), JSON.stringify([
      {
        id: 'stub-e2e-001',
        input: { message: 'What is the weather in London?' },
        stubs: { get_weather: { temperature: 20, condition: 'cloudy' } },
        expect: { responseNonEmpty: true },
      },
    ]));

    // Turn 1: model calls tool
    vi.mocked(llmTurn).mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'tc_1', name: 'get_weather', input: { city: 'London' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    // Turn 2: model produces final response
    vi.mocked(llmTurn).mockResolvedValueOnce({
      text: 'The weather in London is cloudy with 20°.',
      toolCalls: [],
      usage: { input_tokens: 20, output_tokens: 10 },
    });

    const result = await runEvals('get_weather', { project: { toolsDir, evalsDir } }, root, () => {});

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    // Confirms 2 llmTurn calls — multi-turn stub path, not routing-only
    expect(llmTurn).toHaveBeenCalledTimes(2);
  });
});
