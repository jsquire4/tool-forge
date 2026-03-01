import { describe, it, expect } from 'vitest';
import { contentMatch } from './content-match.js';
import { negativeMatch } from './negative-match.js';
import { toolSelection } from './tool-selection.js';
import { latency } from './latency.js';
import { jsonValid } from './json-valid.js';
import { schemaMatch } from './schema-match.js';
import { nonEmpty, DEFAULT_COP_OUT_PHRASES } from './non-empty.js';
import { lengthBounds } from './length-bounds.js';
import { regexMatch } from './regex-match.js';
import { toolCallCount } from './tool-call-count.js';
import { costBudget } from './cost-budget.js';
import { runChecks } from './run-checks.js';

describe('contentMatch', () => {
  it('passes when all strings are present (case-insensitive)', () => {
    expect(contentMatch({ responseText: 'Hello World', mustContain: ['hello', 'WORLD'] }).pass).toBe(true);
  });
  it('fails when a string is missing', () => {
    const r = contentMatch({ responseText: 'Hello', mustContain: ['hello', 'world'] });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('world');
  });
  it('passes with empty mustContain', () => {
    expect(contentMatch({ responseText: 'anything', mustContain: [] }).pass).toBe(true);
  });
});

describe('negativeMatch', () => {
  it('passes when forbidden strings absent', () => {
    expect(negativeMatch({ responseText: 'all good', mustNotContain: ['bad', 'evil'] }).pass).toBe(true);
  });
  it('fails when forbidden string present', () => {
    const r = negativeMatch({ responseText: 'This is bad', mustNotContain: ['bad'] });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('bad');
  });
});

describe('toolSelection', () => {
  it('passes strict: exact set match', () => {
    expect(toolSelection({ expected: ['a', 'b'], actual: ['b', 'a'] }).pass).toBe(true);
  });
  it('fails strict: extra tool called', () => {
    expect(toolSelection({ expected: ['a'], actual: ['a', 'b'] }).pass).toBe(false);
  });
  it('fails strict: missing tool', () => {
    expect(toolSelection({ expected: ['a', 'b'], actual: ['a'] }).pass).toBe(false);
  });
  it('subset mode: expected is subset of actual', () => {
    expect(toolSelection({ expected: ['a'], actual: ['a', 'b'], mode: 'subset' }).pass).toBe(true);
  });
  it('subset mode: fails when expected tool missing from actual', () => {
    expect(toolSelection({ expected: ['c'], actual: ['a', 'b'], mode: 'subset' }).pass).toBe(false);
  });
  it('superset mode: actual must be subset of expected', () => {
    expect(toolSelection({ expected: ['a', 'b', 'c'], actual: ['a'], mode: 'superset' }).pass).toBe(true);
  });
  it('superset mode: fails when actual has tool not in expected', () => {
    expect(toolSelection({ expected: ['a'], actual: ['a', 'z'], mode: 'superset' }).pass).toBe(false);
  });
});

describe('latency', () => {
  it('passes when under limit', () => {
    expect(latency({ latencyMs: 100, maxLatencyMs: 200 }).pass).toBe(true);
  });
  it('fails when over limit', () => {
    const r = latency({ latencyMs: 300, maxLatencyMs: 200 });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('300');
  });
  it('passes exactly at limit', () => {
    expect(latency({ latencyMs: 200, maxLatencyMs: 200 }).pass).toBe(true);
  });
});

describe('jsonValid', () => {
  it('passes for valid JSON', () => {
    expect(jsonValid({ responseText: '{"a":1}' }).pass).toBe(true);
  });
  it('fails for invalid JSON', () => {
    expect(jsonValid({ responseText: 'not json' }).pass).toBe(false);
  });
  it('passes for JSON array', () => {
    expect(jsonValid({ responseText: '[1,2,3]' }).pass).toBe(true);
  });
});

describe('schemaMatch', () => {
  it('passes when all required keys present', () => {
    expect(schemaMatch({ data: { a: 1, b: 'x' }, requiredKeys: ['a', 'b'] }).pass).toBe(true);
  });
  it('fails when a key is missing', () => {
    const r = schemaMatch({ data: { a: 1 }, requiredKeys: ['a', 'b'] });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('b');
  });
  it('passes type checks', () => {
    expect(schemaMatch({ data: { n: 42 }, requiredKeys: ['n'], typeChecks: { n: 'number' } }).pass).toBe(true);
  });
  it('fails type checks', () => {
    const r = schemaMatch({ data: { n: 'str' }, requiredKeys: ['n'], typeChecks: { n: 'number' } });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('n');
  });
});

describe('nonEmpty', () => {
  it('passes for normal response', () => {
    expect(nonEmpty({ responseText: 'Here is the answer.' }).pass).toBe(true);
  });
  it('fails for empty string', () => {
    expect(nonEmpty({ responseText: '' }).pass).toBe(false);
  });
  it('fails for cop-out phrase', () => {
    const r = nonEmpty({ responseText: "I'm sorry, I cannot help." });
    expect(r.pass).toBe(false);
  });
  it('DEFAULT_COP_OUT_PHRASES is an array with entries', () => {
    expect(Array.isArray(DEFAULT_COP_OUT_PHRASES)).toBe(true);
    expect(DEFAULT_COP_OUT_PHRASES.length).toBeGreaterThan(5);
  });
  it('custom cop-out phrases override defaults', () => {
    expect(nonEmpty({ responseText: 'NOPE', copOutPhrases: ['nope'] }).pass).toBe(false);
    expect(nonEmpty({ responseText: "I cannot", copOutPhrases: ['custom'] }).pass).toBe(true);
  });
});

describe('lengthBounds', () => {
  it('passes within bounds', () => {
    expect(lengthBounds({ responseText: 'hello', minLength: 3, maxLength: 10 }).pass).toBe(true);
  });
  it('fails below min', () => {
    expect(lengthBounds({ responseText: 'hi', minLength: 5 }).pass).toBe(false);
  });
  it('fails above max', () => {
    expect(lengthBounds({ responseText: 'hello world', maxLength: 5 }).pass).toBe(false);
  });
});

describe('regexMatch', () => {
  it('passes when pattern matches', () => {
    expect(regexMatch({ responseText: 'foo123bar', pattern: /\d+/ }).pass).toBe(true);
  });
  it('fails when pattern does not match', () => {
    expect(regexMatch({ responseText: 'foobar', pattern: /\d+/ }).pass).toBe(false);
  });
  it('accepts string pattern', () => {
    expect(regexMatch({ responseText: 'hello', pattern: 'hell' }).pass).toBe(true);
  });
});

describe('toolCallCount', () => {
  it('passes within range', () => {
    expect(toolCallCount({ actual: 3, min: 1, max: 5 }).pass).toBe(true);
  });
  it('fails below min', () => {
    expect(toolCallCount({ actual: 0, min: 1 }).pass).toBe(false);
  });
  it('fails above max', () => {
    expect(toolCallCount({ actual: 6, max: 5 }).pass).toBe(false);
  });
});

describe('costBudget', () => {
  it('passes under budget', () => {
    expect(costBudget({ actualCost: 0.001, maxCost: 0.01 }).pass).toBe(true);
  });
  it('fails over budget', () => {
    expect(costBudget({ actualCost: 0.02, maxCost: 0.01 }).pass).toBe(false);
  });
  it('passes exactly at budget', () => {
    expect(costBudget({ actualCost: 0.01, maxCost: 0.01 }).pass).toBe(true);
  });
});

describe('runChecks meta-runner', () => {
  it('runs only checks for provided inputs', () => {
    const result = runChecks({ responseText: 'hello', mustContain: ['hello'] });
    expect(result.checks).toHaveProperty('contentMatch');
    expect(result.checks).not.toHaveProperty('toolSelection');
    expect(result.pass).toBe(true);
  });

  it('returns pass=false if any check fails', () => {
    const result = runChecks({
      responseText: 'hello',
      mustContain: ['world'],  // will fail
    });
    expect(result.pass).toBe(false);
    expect(result.failed).toBe(1);
  });

  it('counts total/passed/failed correctly', () => {
    const result = runChecks({
      responseText: 'hello world',
      mustContain: ['hello'],
      mustNotContain: ['bad'],
    });
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('skips checks with missing inputs', () => {
    const result = runChecks({});
    expect(result.total).toBe(0);
    expect(result.pass).toBe(true);
  });

  it('runs toolSelection when expectedTools and actualTools are provided', () => {
    const result = runChecks({ expectedTools: ['a'], actualTools: ['a'] });
    expect(result.checks).toHaveProperty('toolSelection');
    expect(result.pass).toBe(true);
  });

  it('runs latency check when latencyMs and maxLatencyMs are provided', () => {
    const result = runChecks({ latencyMs: 500, maxLatencyMs: 1000 });
    expect(result.checks).toHaveProperty('latency');
    expect(result.pass).toBe(true);
  });

  it('runs jsonValid check when jsonValid flag is true', () => {
    const result = runChecks({ responseText: '{"ok":true}', jsonValid: true });
    expect(result.checks).toHaveProperty('jsonValid');
    expect(result.pass).toBe(true);
  });

  it('runs costBudget when actualCost and maxCost are provided', () => {
    const result = runChecks({ actualCost: 0.005, maxCost: 0.01 });
    expect(result.checks).toHaveProperty('costBudget');
    expect(result.pass).toBe(true);
  });

  it('runs noHallucinatedNumbers when toolResults and responseText are provided', () => {
    const toolResults = [{ temperature: 72, condition: 'sunny' }];
    const result = runChecks({ responseText: 'The temperature is 72 degrees.', toolResults });
    expect(result.checks).toHaveProperty('noHallucinatedNumbers');
    expect(result.pass).toBe(true);
  });

  it('noHallucinatedNumbers fails when response contains number not in tool results', () => {
    const toolResults = [{ temperature: 72 }];
    const result = runChecks({ responseText: 'The temperature is 99 degrees.', toolResults });
    expect(result.checks).toHaveProperty('noHallucinatedNumbers');
    expect(result.pass).toBe(false);
  });
});
