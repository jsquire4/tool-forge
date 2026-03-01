// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * Compute Wilson score confidence interval for a proportion.
 * @param {number} passes - number of successes
 * @param {number} total - total trials
 * @param {number} [z=1.96] - z-score (1.96 = 95% CI)
 * @returns {{lower: number, upper: number, center: number}}
 */
export function wilsonInterval(passes, total, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0, center: 0 };
  const p = passes / total;
  const z2 = z * z;
  const n = total;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    center,
  };
}

/**
 * Compute statistics for a list of trial results.
 * @param {{pass: boolean, latencyMs?: number}[]} trials
 * @returns {{passRate: number, lower95: number, upper95: number, meanLatencyMs: number, p95LatencyMs: number}}
 */
export function computeTrialStats(trials) {
  if (trials.length === 0) return { passRate: 0, lower95: 0, upper95: 0, meanLatencyMs: 0, p95LatencyMs: 0 };

  const passes = trials.filter(t => t.pass).length;
  const { lower, upper } = wilsonInterval(passes, trials.length);

  const latencies = trials.map(t => t.latencyMs ?? 0).sort((a, b) => a - b);
  const meanLatencyMs = latencies.reduce((s, l) => s + l, 0) / latencies.length;
  const p95Index = Math.floor(latencies.length * 0.95);
  const p95LatencyMs = latencies[Math.min(p95Index, latencies.length - 1)] ?? 0;

  return {
    passRate: passes / trials.length,
    lower95: lower,
    upper95: upper,
    meanLatencyMs,
    p95LatencyMs,
  };
}

/**
 * Compute stats for all cases in a run.
 * @param {Object.<string, {pass: boolean, latencyMs?: number}[]>} allTrials
 * @returns {Object.<string, ReturnType<typeof computeTrialStats>>}
 */
export function computeAllTrialStats(allTrials) {
  return Object.fromEntries(
    Object.entries(allTrials).map(([caseId, trials]) => [caseId, computeTrialStats(trials)])
  );
}
