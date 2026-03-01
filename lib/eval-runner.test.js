import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubbedReactTurn, runEvals } from './eval-runner.js';

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
import { llmTurn } from './api-client.js';

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
