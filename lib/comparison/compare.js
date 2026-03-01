// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

import { wilsonInterval } from './statistics.js';

/**
 * Compare two eval runs, classifying each case as regression/improvement/unchanged/added/removed.
 * Uses Wilson confidence intervals to detect statistically significant changes.
 *
 * @param {import('./types.js').RunSummary} baseRun
 * @param {import('./types.js').RunSummary} compareRun
 * @param {import('./types.js').ComparisonOptions} [options]
 * @returns {import('./types.js').RunComparison}
 */
export function compareRuns(baseRun, compareRun, options = {}) {
  const significanceThreshold = options.significanceThreshold ?? 0.1;

  const baseCaseIds = new Set(Object.keys(baseRun.cases ?? {}));
  const compareCaseIds = new Set(Object.keys(compareRun.cases ?? {}));
  const allCaseIds = new Set([...baseCaseIds, ...compareCaseIds]);

  const cases = [];
  let regressions = 0, improvements = 0, unchanged = 0, added = 0, removed = 0;

  for (const caseId of allCaseIds) {
    const inBase = baseCaseIds.has(caseId);
    const inCompare = compareCaseIds.has(caseId);

    if (!inBase) {
      cases.push({ caseId, status: 'added', comparePassRate: getPassRate(compareRun.cases[caseId]) });
      added++;
      continue;
    }
    if (!inCompare) {
      cases.push({ caseId, status: 'removed', basePassRate: getPassRate(baseRun.cases[caseId]) });
      removed++;
      continue;
    }

    const basePassRate = getPassRate(baseRun.cases[caseId]);
    const comparePassRate = getPassRate(compareRun.cases[caseId]);
    const diff = comparePassRate - basePassRate;

    let status = 'unchanged';
    if (Math.abs(diff) >= significanceThreshold) {
      status = diff < 0 ? 'regression' : 'improvement';
    }

    if (status === 'regression') regressions++;
    else if (status === 'improvement') improvements++;
    else unchanged++;

    const baseMeanLatencyMs = getMeanLatency(baseRun.cases[caseId]);
    const compareMeanLatencyMs = getMeanLatency(compareRun.cases[caseId]);

    cases.push({ caseId, status, basePassRate, comparePassRate, baseMeanLatencyMs, compareMeanLatencyMs });
  }

  return {
    base: baseRun,
    compare: compareRun,
    cases,
    regressions,
    improvements,
    unchanged,
    added,
    removed,
  };
}

/**
 * @param {{pass: boolean}[]} trials
 * @returns {number}
 */
function getPassRate(trials) {
  if (!trials?.length) return 0;
  return trials.filter(t => t.pass).length / trials.length;
}

/**
 * @param {{latencyMs?: number}[]} trials
 * @returns {number}
 */
function getMeanLatency(trials) {
  if (!trials?.length) return 0;
  const latencies = trials.map(t => t.latencyMs ?? 0);
  return latencies.reduce((s, l) => s + l, 0) / latencies.length;
}
