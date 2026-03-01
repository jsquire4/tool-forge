import { describe, it, expect } from 'vitest';
import { checkAdapter, checkResponseContainsAnyGroups, checkToolsAcceptable } from './check-adapter.js';

// ── checkAdapter field mappings ──────────────────────────────────────────────

describe('checkAdapter', () => {
  const BASE_META = { toolsCalled: [], responseText: '' };

  it('maps toolsCalled → expectedTools + actualTools', () => {
    const input = checkAdapter({ expect: { toolsCalled: ['get_weather'] } }, { ...BASE_META, toolsCalled: ['get_weather'] });
    expect(input.expectedTools).toEqual(['get_weather']);
    expect(input.actualTools).toEqual(['get_weather']);
  });

  it('wraps scalar toolsCalled in array', () => {
    const input = checkAdapter({ expect: { toolsCalled: 'get_weather' } }, BASE_META);
    expect(input.expectedTools).toEqual(['get_weather']);
  });

  it('maps responseContains → mustContain (array)', () => {
    const input = checkAdapter({ expect: { responseContains: ['hello', 'world'] } }, BASE_META);
    expect(input.mustContain).toEqual(['hello', 'world']);
  });

  it('wraps scalar responseContains in array', () => {
    const input = checkAdapter({ expect: { responseContains: 'hello' } }, BASE_META);
    expect(input.mustContain).toEqual(['hello']);
  });

  it('maps responseNotContains → mustNotContain', () => {
    const input = checkAdapter({ expect: { responseNotContains: ['bad', 'evil'] } }, BASE_META);
    expect(input.mustNotContain).toEqual(['bad', 'evil']);
  });

  it('maps responseNonEmpty → nonEmpty', () => {
    const input = checkAdapter({ expect: { responseNonEmpty: true } }, BASE_META);
    expect(input.nonEmpty).toBe(true);
  });

  it('maps requiresPreamble (evalCase top-level) → nonEmpty', () => {
    const input = checkAdapter({ requiresPreamble: true, expect: {} }, BASE_META);
    expect(input.nonEmpty).toBe(true);
  });

  it('maps maxLatencyMs + latencyMs together', () => {
    const input = checkAdapter(
      { expect: { maxLatencyMs: 5000 } },
      { ...BASE_META, latencyMs: 1000 }
    );
    expect(input.latencyMs).toBe(1000);
    expect(input.maxLatencyMs).toBe(5000);
  });

  it('does NOT set latency fields when latencyMs is missing from meta', () => {
    const input = checkAdapter({ expect: { maxLatencyMs: 5000 } }, BASE_META);
    expect(input.latencyMs).toBeUndefined();
    expect(input.maxLatencyMs).toBeUndefined();
  });

  it('maps maxCost + cost together', () => {
    const input = checkAdapter(
      { expect: { maxCost: 0.01 } },
      { ...BASE_META, cost: 0.005 }
    );
    expect(input.actualCost).toBe(0.005);
    expect(input.maxCost).toBe(0.01);
  });

  it('maps minToolCalls + maxToolCalls with actualToolCallCount', () => {
    const input = checkAdapter(
      { expect: { minToolCalls: 1, maxToolCalls: 3 } },
      { ...BASE_META, toolsCalled: ['a', 'b'] }
    );
    expect(input.actualToolCallCount).toBe(2);
    expect(input.minToolCalls).toBe(1);
    expect(input.maxToolCalls).toBe(3);
  });

  it('maps jsonValid flag', () => {
    const input = checkAdapter({ expect: { jsonValid: true } }, BASE_META);
    expect(input.jsonValid).toBe(true);
  });

  it('maps schemaData + requiredKeys + typeChecks', () => {
    const input = checkAdapter(
      { expect: { schemaData: { a: 1 }, requiredKeys: ['a'], typeChecks: { a: 'number' } } },
      BASE_META
    );
    expect(input.schemaData).toEqual({ a: 1 });
    expect(input.requiredKeys).toEqual(['a']);
    expect(input.typeChecks).toEqual({ a: 'number' });
  });

  it('sets schemaData without requiredKeys when typeChecks-only', () => {
    // After the fix: schemaData is set and requiredKeys defaults to undefined (not set)
    // The run-checks.js gate is now `requiredKeys !== undefined`, so typeChecks-only works
    const input = checkAdapter(
      { expect: { schemaData: { a: 1 }, typeChecks: { a: 'number' } } },
      BASE_META
    );
    expect(input.schemaData).toEqual({ a: 1 });
    expect(input.typeChecks).toEqual({ a: 'number' });
    expect(input.requiredKeys).toBeUndefined();
  });

  it('maps regexPattern', () => {
    const input = checkAdapter({ expect: { regexPattern: /\d+/ } }, BASE_META);
    expect(input.regexPattern).toBeInstanceOf(RegExp);
  });

  it('does NOT set _responseContainsAny (dead field removed)', () => {
    const input = checkAdapter({ expect: { responseContainsAny: ['a', 'b'] } }, BASE_META);
    expect(input._responseContainsAny).toBeUndefined();
  });
});

// ── checkResponseContainsAnyGroups ───────────────────────────────────────────

describe('checkResponseContainsAnyGroups', () => {
  it('returns pass: true for empty groups', () => {
    expect(checkResponseContainsAnyGroups('anything', [])).toEqual({ pass: true });
  });

  it('returns pass: true when null/undefined groups', () => {
    expect(checkResponseContainsAnyGroups('anything', null)).toEqual({ pass: true });
  });

  it('passes when all grouped string[][] groups have a match', () => {
    const groups = [['temperature', 'degrees'], ['rain', 'sunny']];
    const result = checkResponseContainsAnyGroups('It is 20 degrees and sunny today.', groups);
    expect(result.pass).toBe(true);
  });

  it('fails when one group has no match', () => {
    const groups = [['temperature', 'degrees'], ['snow', 'blizzard']];
    const result = checkResponseContainsAnyGroups('It is 20 degrees today.', groups);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('snow');
  });

  it('normalizes flat string[] to a single group (backward compat)', () => {
    // Flat string[] should be treated as one group where any match passes
    const flat = ['temperature', 'degrees', 'warm'];
    const result = checkResponseContainsAnyGroups('It is warm today.', flat);
    expect(result.pass).toBe(true);
  });

  it('flat string[] fails when none of the strings match', () => {
    const flat = ['snow', 'blizzard', 'ice'];
    const result = checkResponseContainsAnyGroups('It is warm today.', flat);
    expect(result.pass).toBe(false);
  });

  it('returns reason listing all failing groups', () => {
    const groups = [['snow'], ['fog']];
    const result = checkResponseContainsAnyGroups('It is sunny.', groups);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('snow');
    expect(result.reason).toContain('fog');
  });
});

// ── checkToolsAcceptable ─────────────────────────────────────────────────────

describe('checkToolsAcceptable', () => {
  it('returns pass: true for empty acceptable list', () => {
    expect(checkToolsAcceptable(['a'], [])).toEqual({ pass: true });
  });

  it('passes when actual tools exactly match an acceptable set', () => {
    const result = checkToolsAcceptable(['get_weather'], [['get_weather'], ['get_forecast']]);
    expect(result.pass).toBe(true);
  });

  it('fails when actual tools match no acceptable set', () => {
    const result = checkToolsAcceptable(['unknown_tool'], [['get_weather'], ['get_forecast']]);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('unknown_tool');
  });

  it('passes when __none__ is in acceptable set and no tools were called', () => {
    const result = checkToolsAcceptable([], [['__none__']]);
    expect(result.pass).toBe(true);
  });

  it('fails when __none__ is in acceptable set but tools were called', () => {
    const result = checkToolsAcceptable(['get_weather'], [['__none__']]);
    expect(result.pass).toBe(false);
  });

  it('accepts order-independent matching', () => {
    const result = checkToolsAcceptable(['b', 'a'], [['a', 'b']]);
    expect(result.pass).toBe(true);
  });
});
