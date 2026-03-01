// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

import chalk from 'chalk';

/**
 * Format a comparison report as a string.
 * @param {import('./types.js').RunComparison} comparison
 * @param {{noColor?: boolean, verbose?: boolean}} [options]
 * @returns {string}
 */
export function formatComparisonReport(comparison, options = {}) {
  const { noColor = false, verbose = false } = options;
  const c = noColor ? makeNoColor() : chalk;

  const lines = [];

  // Header
  lines.push(c.bold('\n=== Eval Run Comparison ==='));
  lines.push(`Base:    ${comparison.base.modelName} (${comparison.base.runId})`);
  lines.push(`Compare: ${comparison.compare.modelName} (${comparison.compare.runId})`);
  lines.push('');

  // Summary stats
  const baseRate = (comparison.base.passRate * 100).toFixed(1);
  const cmpRate = (comparison.compare.passRate * 100).toFixed(1);
  const rateDiff = comparison.compare.passRate - comparison.base.passRate;
  const rateStr = rateDiff >= 0
    ? c.green(`+${(rateDiff * 100).toFixed(1)}%`)
    : c.red(`${(rateDiff * 100).toFixed(1)}%`);

  lines.push(`Pass rate: ${baseRate}% → ${cmpRate}% (${rateStr})`);
  lines.push(`Cases: ${comparison.regressions > 0 ? c.red(`${comparison.regressions} regressions`) : '0 regressions'}, ${comparison.improvements > 0 ? c.green(`${comparison.improvements} improvements`) : '0 improvements'}, ${comparison.unchanged} unchanged`);
  if (comparison.added > 0) lines.push(`  + ${comparison.added} new cases added`);
  if (comparison.removed > 0) lines.push(`  - ${comparison.removed} cases removed`);
  lines.push('');

  // Regressions
  const regressions = comparison.cases.filter(c => c.status === 'regression');
  if (regressions.length > 0) {
    lines.push(c.red.bold('Regressions:'));
    for (const cas of regressions) {
      const base = (cas.basePassRate * 100).toFixed(0);
      const cmp = (cas.comparePassRate * 100).toFixed(0);
      lines.push(`  ${c.red('✗')} ${cas.caseId}: ${base}% → ${cmp}%`);
    }
    lines.push('');
  }

  // Improvements
  const improvements = comparison.cases.filter(c => c.status === 'improvement');
  if (improvements.length > 0) {
    lines.push(c.green.bold('Improvements:'));
    for (const cas of improvements) {
      const base = (cas.basePassRate * 100).toFixed(0);
      const cmp = (cas.comparePassRate * 100).toFixed(0);
      lines.push(`  ${c.green('✓')} ${cas.caseId}: ${base}% → ${cmp}%`);
    }
    lines.push('');
  }

  // Verbose: show all unchanged cases too
  if (verbose) {
    const unchanged = comparison.cases.filter(c => c.status === 'unchanged');
    if (unchanged.length > 0) {
      lines.push(c.gray('Unchanged:'));
      for (const cas of unchanged) {
        const rate = (cas.comparePassRate * 100).toFixed(0);
        lines.push(`  ${c.gray('·')} ${cas.caseId}: ${rate}%`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Create a chalk-compatible no-color proxy.
 * @returns {typeof chalk}
 */
function makeNoColor() {
  const identity = str => str;
  const proxy = new Proxy(identity, {
    get(_, prop) {
      if (prop === 'bold' || prop === 'red' || prop === 'green' || prop === 'gray' || prop === 'yellow') {
        return new Proxy(identity, {
          get(__, p2) { return identity; },
          apply(__, _this, args) { return args[0] ?? ''; }
        });
      }
      return identity;
    },
    apply(_, _this, args) { return args[0] ?? ''; }
  });
  return proxy;
}
