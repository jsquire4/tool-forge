import { describe, it, expect } from 'vitest';
import { compareRuns } from './compare.js';

const makeRun = (id, model, passRate, cases = {}) => ({
  runId: id,
  modelName: model,
  passRate,
  totalCases: Object.keys(cases).length,
  totalCost: 0.01,
  meanLatencyMs: 500,
  p95LatencyMs: 1000,
  cases,
});

const makeTrials = (passes, total) =>
  Array.from({ length: total }, (_, i) => ({ pass: i < passes, latencyMs: 100 }));

describe('compareRuns', () => {
  it('classifies a regression (passRate drops by > threshold)', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'c1': makeTrials(10, 10) });
    const comp = makeRun('r2', 'gpt-4o', 0.5, { 'c1': makeTrials(5, 10) });
    const r = compareRuns(base, comp);
    expect(r.regressions).toBe(1);
    const c1 = r.cases.find(c => c.caseId === 'c1');
    expect(c1.status).toBe('regression');
  });

  it('classifies an improvement', () => {
    const base = makeRun('r1', 'gpt-4o', 0.5, { 'c1': makeTrials(5, 10) });
    const comp = makeRun('r2', 'gpt-4o', 1.0, { 'c1': makeTrials(10, 10) });
    const r = compareRuns(base, comp);
    expect(r.improvements).toBe(1);
    const c1 = r.cases.find(c => c.caseId === 'c1');
    expect(c1.status).toBe('improvement');
  });

  it('classifies unchanged (diff < threshold)', () => {
    const base = makeRun('r1', 'gpt-4o', 0.9, { 'c1': makeTrials(9, 10) });
    const comp = makeRun('r2', 'gpt-4o', 0.8, { 'c1': makeTrials(8, 10) });
    const r = compareRuns(base, comp, { significanceThreshold: 0.5 });
    expect(r.unchanged).toBe(1);
    const c1 = r.cases.find(c => c.caseId === 'c1');
    expect(c1.status).toBe('unchanged');
  });

  it('detects added cases', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, {});
    const comp = makeRun('r2', 'gpt-4o', 1.0, { 'new-case': makeTrials(3, 3) });
    const r = compareRuns(base, comp);
    expect(r.added).toBe(1);
    const newCase = r.cases.find(c => c.caseId === 'new-case');
    expect(newCase.status).toBe('added');
  });

  it('detects removed cases', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'old-case': makeTrials(3, 3) });
    const comp = makeRun('r2', 'gpt-4o', 1.0, {});
    const r = compareRuns(base, comp);
    expect(r.removed).toBe(1);
    const oldCase = r.cases.find(c => c.caseId === 'old-case');
    expect(oldCase.status).toBe('removed');
  });

  it('preserves base and compare in result', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, {});
    const comp = makeRun('r2', 'claude', 1.0, {});
    const r = compareRuns(base, comp);
    expect(r.base.runId).toBe('r1');
    expect(r.compare.runId).toBe('r2');
  });

  it('returns zero counts when both runs have no cases', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, {});
    const comp = makeRun('r2', 'gpt-4o', 1.0, {});
    const r = compareRuns(base, comp);
    expect(r.regressions).toBe(0);
    expect(r.improvements).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.cases).toHaveLength(0);
  });

  it('case entry includes basePassRate and comparePassRate', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'c1': makeTrials(10, 10) });
    const comp = makeRun('r2', 'gpt-4o', 0.5, { 'c1': makeTrials(5, 10) });
    const r = compareRuns(base, comp);
    const c1 = r.cases.find(c => c.caseId === 'c1');
    expect(c1.basePassRate).toBe(1.0);
    expect(c1.comparePassRate).toBe(0.5);
  });

  it('case entry for added case includes comparePassRate', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, {});
    const comp = makeRun('r2', 'gpt-4o', 1.0, { 'added': makeTrials(4, 4) });
    const r = compareRuns(base, comp);
    const added = r.cases.find(c => c.caseId === 'added');
    expect(added.comparePassRate).toBe(1.0);
  });

  it('case entry for removed case includes basePassRate', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'removed': makeTrials(3, 3) });
    const comp = makeRun('r2', 'gpt-4o', 1.0, {});
    const r = compareRuns(base, comp);
    const removed = r.cases.find(c => c.caseId === 'removed');
    expect(removed.basePassRate).toBe(1.0);
  });

  it('uses default significanceThreshold of 0.1', () => {
    // diff of 0.2 (8/10 vs 10/10) clearly exceeds the default threshold
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'c1': makeTrials(10, 10) });
    const comp = makeRun('r2', 'gpt-4o', 0.8, { 'c1': makeTrials(8, 10) });
    const r = compareRuns(base, comp);
    // |0.8 - 1.0| = 0.2 >= 0.1 (default) → regression
    expect(r.regressions).toBe(1);
  });

  it('handles multiple cases with mixed statuses', () => {
    const base = makeRun('r1', 'gpt-4o', 0.8, {
      'stable': makeTrials(10, 10),
      'going-down': makeTrials(10, 10),
      'going-up': makeTrials(0, 10),
    });
    const comp = makeRun('r2', 'gpt-4o', 0.8, {
      'stable': makeTrials(10, 10),
      'going-down': makeTrials(0, 10),
      'going-up': makeTrials(10, 10),
      'brand-new': makeTrials(5, 10),
    });
    const r = compareRuns(base, comp);
    expect(r.unchanged).toBe(1);
    expect(r.regressions).toBe(1);
    expect(r.improvements).toBe(1);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it('includes mean latency fields for compared cases', () => {
    const base = makeRun('r1', 'gpt-4o', 1.0, { 'c1': makeTrials(5, 5) });
    const comp = makeRun('r2', 'gpt-4o', 1.0, { 'c1': makeTrials(5, 5) });
    const r = compareRuns(base, comp);
    const c1 = r.cases.find(c => c.caseId === 'c1');
    expect(c1).toHaveProperty('baseMeanLatencyMs');
    expect(c1).toHaveProperty('compareMeanLatencyMs');
    expect(typeof c1.baseMeanLatencyMs).toBe('number');
    expect(typeof c1.compareMeanLatencyMs).toBe('number');
  });
});
