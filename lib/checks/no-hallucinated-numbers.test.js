import { describe, it, expect } from 'vitest';
import { noHallucinatedNumbers } from './no-hallucinated-numbers.js';

describe('noHallucinatedNumbers', () => {
  it('passes when all numbers match tool results', () => {
    const r = noHallucinatedNumbers({
      responseText: 'The total is 42.5',
      toolResults: { total: 42.5 },
    });
    expect(r.pass).toBe(true);
    expect(r.hallucinated).toHaveLength(0);
  });

  it('fails when numbers in response not in tool results', () => {
    const r = noHallucinatedNumbers({
      responseText: 'The total is 999',
      toolResults: { total: 42 },
    });
    expect(r.pass).toBe(false);
    expect(r.hallucinated).toContain(999);
  });

  it('respects tolerance', () => {
    const r = noHallucinatedNumbers({
      responseText: 'About 42',
      toolResults: { total: 42.1 },
      tolerance: 0.01,
    });
    expect(r.pass).toBe(true);
  });

  it('handles nested tool results', () => {
    const r = noHallucinatedNumbers({
      responseText: 'value: 100',
      toolResults: [{ nested: { deep: 100 } }],
    });
    expect(r.pass).toBe(true);
  });

  it('handles no numbers in response', () => {
    const r = noHallucinatedNumbers({
      responseText: 'no numbers here',
      toolResults: { total: 42 },
    });
    expect(r.pass).toBe(true);
    expect(r.hallucinated).toHaveLength(0);
  });

  it('matched array contains correctly sourced numbers', () => {
    const r = noHallucinatedNumbers({
      responseText: 'The result is 7 out of 10',
      toolResults: { score: 7, outOf: 10 },
    });
    expect(r.pass).toBe(true);
    expect(r.matched).toContain(7);
    expect(r.matched).toContain(10);
  });

  it('fails with multiple hallucinated numbers and lists them in reason', () => {
    const r = noHallucinatedNumbers({
      responseText: 'Values are 111 and 222',
      toolResults: { x: 1 },
    });
    expect(r.pass).toBe(false);
    expect(r.hallucinated).toContain(111);
    expect(r.hallucinated).toContain(222);
    expect(r.reason).toContain('111');
    expect(r.reason).toContain('222');
  });

  it('handles array toolResults at the top level', () => {
    const r = noHallucinatedNumbers({
      responseText: 'Total: 55',
      toolResults: [10, 20, 25],
    });
    expect(r.pass).toBe(false); // 55 not in [10,20,25]
    expect(r.hallucinated).toContain(55);
  });

  it('handles zero values correctly', () => {
    const r = noHallucinatedNumbers({
      responseText: 'The count is 0',
      toolResults: { count: 0 },
    });
    expect(r.pass).toBe(true);
    expect(r.hallucinated).toHaveLength(0);
  });

  it('uses default tolerance of 0.01 (1%)', () => {
    // 100 vs 100.5 — relative diff = 0.005 < 0.01, should pass
    const r = noHallucinatedNumbers({
      responseText: 'About 100',
      toolResults: { v: 100.5 },
    });
    expect(r.pass).toBe(true);
  });

  it('fails when within absolute but outside relative tolerance', () => {
    // 1 vs 2 — relative diff = 0.5, well above default 0.01
    const r = noHallucinatedNumbers({
      responseText: 'Value: 1',
      toolResults: { v: 2 },
      tolerance: 0.01,
    });
    expect(r.pass).toBe(false);
  });
});
