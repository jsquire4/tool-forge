import { describe, it, expect } from 'vitest';
import { wilsonInterval, computeTrialStats, computeAllTrialStats } from './statistics.js';

describe('wilsonInterval', () => {
  it('returns {0,0,0} for zero trials', () => {
    const r = wilsonInterval(0, 0);
    expect(r.lower).toBe(0);
    expect(r.upper).toBe(0);
    expect(r.center).toBe(0);
  });

  it('10/10 passes — upper near 1, lower > 0.69', () => {
    const r = wilsonInterval(10, 10);
    expect(r.upper).toBeCloseTo(1, 0);
    expect(r.lower).toBeGreaterThan(0.69);
  });

  it('0/10 passes — lower near 0, upper < 0.31', () => {
    const r = wilsonInterval(0, 10);
    expect(r.lower).toBeCloseTo(0, 0);
    expect(r.upper).toBeLessThan(0.31);
  });

  it('5/10 — interval straddles 0.5', () => {
    const r = wilsonInterval(5, 10);
    expect(r.lower).toBeLessThan(0.5);
    expect(r.upper).toBeGreaterThan(0.5);
  });

  it('lower is always >= 0', () => {
    const r = wilsonInterval(0, 100);
    expect(r.lower).toBeGreaterThanOrEqual(0);
  });

  it('upper is always <= 1', () => {
    const r = wilsonInterval(100, 100);
    expect(r.upper).toBeLessThanOrEqual(1);
  });

  it('center is between lower and upper', () => {
    const r = wilsonInterval(7, 10);
    expect(r.center).toBeGreaterThanOrEqual(r.lower);
    expect(r.center).toBeLessThanOrEqual(r.upper);
  });

  it('center approximates observed proportion', () => {
    // With 50/100 the Wilson center should be close to 0.5
    const r = wilsonInterval(50, 100);
    expect(r.center).toBeCloseTo(0.5, 1);
  });

  it('interval is wider for fewer trials (same proportion)', () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(50, 100);
    const widthSmall = small.upper - small.lower;
    const widthLarge = large.upper - large.lower;
    expect(widthSmall).toBeGreaterThan(widthLarge);
  });

  it('uses custom z-score when provided', () => {
    // z=1 gives a narrower interval than default z=1.96
    const narrow = wilsonInterval(5, 10, 1);
    const wide = wilsonInterval(5, 10, 1.96);
    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower);
  });
});

describe('computeTrialStats', () => {
  it('returns zeros for empty trials', () => {
    const r = computeTrialStats([]);
    expect(r.passRate).toBe(0);
    expect(r.meanLatencyMs).toBe(0);
    expect(r.p95LatencyMs).toBe(0);
    expect(r.lower95).toBe(0);
    expect(r.upper95).toBe(0);
  });

  it('computes passRate correctly', () => {
    const trials = [
      { pass: true, latencyMs: 100 },
      { pass: true, latencyMs: 200 },
      { pass: false, latencyMs: 300 },
    ];
    const r = computeTrialStats(trials);
    expect(r.passRate).toBeCloseTo(2 / 3, 4);
    expect(r.meanLatencyMs).toBeCloseTo(200, 0);
  });

  it('computes p95 latency', () => {
    const trials = Array.from({ length: 20 }, (_, i) => ({ pass: true, latencyMs: (i + 1) * 100 }));
    const r = computeTrialStats(trials);
    // p95 of [100, 200, ..., 2000] should be around 1900
    expect(r.p95LatencyMs).toBeGreaterThan(1500);
  });

  it('passRate is 1.0 for all-passing trials', () => {
    const trials = [
      { pass: true, latencyMs: 50 },
      { pass: true, latencyMs: 60 },
    ];
    expect(computeTrialStats(trials).passRate).toBe(1.0);
  });

  it('passRate is 0 for all-failing trials', () => {
    const trials = [
      { pass: false, latencyMs: 50 },
      { pass: false, latencyMs: 60 },
    ];
    expect(computeTrialStats(trials).passRate).toBe(0);
  });

  it('includes lower95 and upper95 confidence interval fields', () => {
    const trials = [{ pass: true, latencyMs: 100 }, { pass: false, latencyMs: 200 }];
    const r = computeTrialStats(trials);
    expect(r).toHaveProperty('lower95');
    expect(r).toHaveProperty('upper95');
    expect(r.lower95).toBeGreaterThanOrEqual(0);
    expect(r.upper95).toBeLessThanOrEqual(1);
  });

  it('handles trials without latencyMs by defaulting to 0', () => {
    const trials = [{ pass: true }, { pass: true }];
    const r = computeTrialStats(trials);
    expect(r.meanLatencyMs).toBe(0);
    expect(r.p95LatencyMs).toBe(0);
  });

  it('meanLatencyMs is correct for uniform latencies', () => {
    const trials = [
      { pass: true, latencyMs: 100 },
      { pass: true, latencyMs: 200 },
      { pass: true, latencyMs: 300 },
    ];
    expect(computeTrialStats(trials).meanLatencyMs).toBeCloseTo(200, 5);
  });
});

describe('computeAllTrialStats', () => {
  it('computes stats for multiple cases', () => {
    const allTrials = {
      'case-1': [{ pass: true, latencyMs: 100 }],
      'case-2': [{ pass: false, latencyMs: 200 }],
    };
    const r = computeAllTrialStats(allTrials);
    expect(r['case-1'].passRate).toBe(1);
    expect(r['case-2'].passRate).toBe(0);
  });

  it('returns empty object for empty input', () => {
    expect(computeAllTrialStats({})).toEqual({});
  });

  it('preserves all case IDs as keys in output', () => {
    const allTrials = {
      alpha: [{ pass: true, latencyMs: 50 }],
      beta: [{ pass: false, latencyMs: 75 }],
      gamma: [{ pass: true, latencyMs: 100 }],
    };
    const r = computeAllTrialStats(allTrials);
    expect(Object.keys(r).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('handles a case with empty trials array', () => {
    const r = computeAllTrialStats({ 'empty-case': [] });
    expect(r['empty-case'].passRate).toBe(0);
  });
});
