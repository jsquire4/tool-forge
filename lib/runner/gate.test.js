import { describe, it, expect } from 'vitest';
import { evaluateGates } from './gate.js';

const makeSummary = (overrides = {}) => ({
  passRate: 0.9,
  totalCost: 0.05,
  p95LatencyMs: 1000,
  totalCases: 10,
  ...overrides,
});

describe('evaluateGates', () => {
  it('passes all gates', () => {
    const r = evaluateGates(makeSummary(), {
      passRate: 0.8,
      maxCost: 0.1,
      p95LatencyMs: 2000,
    });
    expect(r.pass).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(r.results.every(g => g.pass)).toBe(true);
  });

  it('fails passRate gate', () => {
    const r = evaluateGates(makeSummary({ passRate: 0.5 }), { passRate: 0.8 });
    expect(r.pass).toBe(false);
    expect(r.results[0].gate).toBe('passRate');
    expect(r.results[0].pass).toBe(false);
  });

  it('fails maxCost gate', () => {
    const r = evaluateGates(makeSummary({ totalCost: 0.2 }), { maxCost: 0.1 });
    expect(r.pass).toBe(false);
  });

  it('fails p95LatencyMs gate', () => {
    const r = evaluateGates(makeSummary({ p95LatencyMs: 3000 }), { p95LatencyMs: 2000 });
    expect(r.pass).toBe(false);
  });

  it('passes when no gates configured', () => {
    const r = evaluateGates(makeSummary(), {});
    expect(r.pass).toBe(true);
    expect(r.results).toHaveLength(0);
  });

  it('result includes threshold and actual values', () => {
    const r = evaluateGates(makeSummary({ passRate: 0.7 }), { passRate: 0.8 });
    expect(r.results[0].threshold).toBe(0.8);
    expect(r.results[0].actual).toBe(0.7);
  });

  it('passes passRate gate exactly at threshold', () => {
    const r = evaluateGates(makeSummary({ passRate: 0.8 }), { passRate: 0.8 });
    expect(r.pass).toBe(true);
    expect(r.results[0].pass).toBe(true);
  });

  it('passes maxCost gate exactly at threshold', () => {
    const r = evaluateGates(makeSummary({ totalCost: 0.1 }), { maxCost: 0.1 });
    expect(r.pass).toBe(true);
    expect(r.results[0].pass).toBe(true);
  });

  it('passes p95LatencyMs gate exactly at threshold', () => {
    const r = evaluateGates(makeSummary({ p95LatencyMs: 2000 }), { p95LatencyMs: 2000 });
    expect(r.pass).toBe(true);
    expect(r.results[0].pass).toBe(true);
  });

  it('gate results include the gate name', () => {
    const r = evaluateGates(makeSummary(), { passRate: 0.5, maxCost: 1.0, p95LatencyMs: 5000 });
    const gateNames = r.results.map(g => g.gate);
    expect(gateNames).toContain('passRate');
    expect(gateNames).toContain('maxCost');
    expect(gateNames).toContain('p95LatencyMs');
  });

  it('overall pass=false when only one gate fails among multiple', () => {
    const r = evaluateGates(makeSummary({ totalCost: 999 }), {
      passRate: 0.8,
      maxCost: 0.01,
      p95LatencyMs: 2000,
    });
    expect(r.pass).toBe(false);
    const costResult = r.results.find(g => g.gate === 'maxCost');
    expect(costResult.pass).toBe(false);
    const passRateResult = r.results.find(g => g.gate === 'passRate');
    expect(passRateResult.pass).toBe(true);
  });

  it('result.actual reflects the summary value for each gate', () => {
    const r = evaluateGates(
      makeSummary({ passRate: 0.75, totalCost: 0.03, p95LatencyMs: 800 }),
      { passRate: 0.7, maxCost: 0.1, p95LatencyMs: 1000 }
    );
    expect(r.results.find(g => g.gate === 'passRate').actual).toBe(0.75);
    expect(r.results.find(g => g.gate === 'maxCost').actual).toBe(0.03);
    expect(r.results.find(g => g.gate === 'p95LatencyMs').actual).toBe(800);
  });
});
