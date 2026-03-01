import { describe, it, expect } from 'vitest';
import { formatComparisonReport } from './format.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeComparison({ regressions = 0, improvements = 0, unchanged = 0, added = 0, removed = 0, cases = [] } = {}) {
  return {
    base: { runId: 'run-1', modelName: 'claude-3', passRate: 0.7 },
    compare: { runId: 'run-2', modelName: 'gpt-4o', passRate: 0.85 },
    regressions,
    improvements,
    unchanged,
    added,
    removed,
    cases
  };
}

// ── formatComparisonReport ───────────────────────────────────────────────────

describe('formatComparisonReport', () => {
  it('includes base and compare run IDs in output', () => {
    const report = formatComparisonReport(makeComparison());
    expect(report).toContain('run-1');
    expect(report).toContain('run-2');
    expect(report).toContain('claude-3');
    expect(report).toContain('gpt-4o');
  });

  it('shows pass rate change with a + prefix for improvement', () => {
    const report = formatComparisonReport(makeComparison(), { noColor: true });
    // 0.85 - 0.70 = +15.0%
    expect(report).toContain('+15.0%');
  });

  it('shows pass rate change with no + prefix for regression', () => {
    const comparison = {
      ...makeComparison(),
      base: { runId: 'run-1', modelName: 'claude-3', passRate: 0.9 },
      compare: { runId: 'run-2', modelName: 'gpt-4o', passRate: 0.7 },
    };
    const report = formatComparisonReport(comparison, { noColor: true });
    expect(report).toContain('-20.0%');
  });

  it('lists regression cases when present', () => {
    const cases = [{ caseId: 'case-001', status: 'regression', basePassRate: 1.0, comparePassRate: 0.0 }];
    const report = formatComparisonReport(makeComparison({ regressions: 1, cases }), { noColor: true });
    expect(report).toContain('case-001');
    expect(report).toContain('Regressions');
  });

  it('lists improvement cases when present', () => {
    const cases = [{ caseId: 'case-002', status: 'improvement', basePassRate: 0.0, comparePassRate: 1.0 }];
    const report = formatComparisonReport(makeComparison({ improvements: 1, cases }), { noColor: true });
    expect(report).toContain('case-002');
    expect(report).toContain('Improvements');
  });

  it('does NOT show regressions or improvements sections when there are none', () => {
    const report = formatComparisonReport(makeComparison({ unchanged: 5 }), { noColor: true });
    expect(report).not.toContain('Regressions:');
    expect(report).not.toContain('Improvements:');
  });

  it('shows added/removed case counts when non-zero', () => {
    const report = formatComparisonReport(makeComparison({ added: 3, removed: 1 }), { noColor: true });
    expect(report).toContain('3 new cases added');
    expect(report).toContain('1 cases removed');
  });

  it('verbose mode shows unchanged cases', () => {
    const cases = [{ caseId: 'case-unchanged', status: 'unchanged', basePassRate: 0.8, comparePassRate: 0.8 }];
    const report = formatComparisonReport(makeComparison({ unchanged: 1, cases }), { noColor: true, verbose: true });
    expect(report).toContain('case-unchanged');
    expect(report).toContain('Unchanged');
  });

  it('non-verbose mode does not show unchanged cases', () => {
    const cases = [{ caseId: 'case-unchanged', status: 'unchanged', basePassRate: 0.8, comparePassRate: 0.8 }];
    const report = formatComparisonReport(makeComparison({ unchanged: 1, cases }), { noColor: true, verbose: false });
    expect(report).not.toContain('case-unchanged');
  });

  it('noColor mode produces output without ANSI codes', () => {
    const report = formatComparisonReport(makeComparison({ regressions: 1, cases: [
      { caseId: 'r1', status: 'regression', basePassRate: 1, comparePassRate: 0 }
    ] }), { noColor: true });
    // ANSI escape sequences start with ESC (char 27)
    expect(report).not.toMatch(/\x1b\[/);
  });

  it('colored mode is the default (returns a string with content)', () => {
    const report = formatComparisonReport(makeComparison());
    expect(typeof report).toBe('string');
    expect(report).toContain('run-1');
    expect(report).toContain('run-2');
  });

  it('regression section is driven by cases array, not regression counter', () => {
    const comparison = {
      base: { runId: 'run-a', modelName: 'modelA', passRate: 0.8 },
      compare: { runId: 'run-b', modelName: 'modelB', passRate: 0.7 },
      regressions: 2,  // counter says 2 regressions
      improvements: 0,
      unchanged: 8,
      added: 0,
      removed: 0,
      cases: [],  // but cases array is empty
    };
    const report = formatComparisonReport(comparison, { noColor: true });
    // regression section should NOT appear since cases.filter returns empty
    expect(report).not.toContain('Regressions:');
  });
});
