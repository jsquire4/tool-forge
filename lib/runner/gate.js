// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * Evaluate gate thresholds against a run summary.
 *
 * @param {{passRate: number, totalCost: number, p95LatencyMs: number, totalCases: number}} summary
 * @param {{passRate?: number, maxCost?: number, p95LatencyMs?: number}} gates
 * @returns {{pass: boolean, results: Array<{gate: string, threshold: number, actual: number, pass: boolean}>}}
 */
export function evaluateGates(summary, gates) {
  const results = [];

  if (gates.passRate !== undefined) {
    const pass = summary.passRate >= gates.passRate;
    results.push({
      gate: 'passRate',
      threshold: gates.passRate,
      actual: summary.passRate,
      pass,
    });
  }

  if (gates.maxCost !== undefined) {
    const pass = summary.totalCost <= gates.maxCost;
    results.push({
      gate: 'maxCost',
      threshold: gates.maxCost,
      actual: summary.totalCost,
      pass,
    });
  }

  if (gates.p95LatencyMs !== undefined) {
    const pass = summary.p95LatencyMs <= gates.p95LatencyMs;
    results.push({
      gate: 'p95LatencyMs',
      threshold: gates.p95LatencyMs,
      actual: summary.p95LatencyMs,
      pass,
    });
  }

  const pass = results.length === 0 || results.every(r => r.pass);
  return { pass, results };
}
