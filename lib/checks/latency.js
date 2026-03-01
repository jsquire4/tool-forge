// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{latencyMs: number, maxLatencyMs: number}} input
 * @returns {import('./types.js').EvalResult}
 */
export function latency({ latencyMs, maxLatencyMs }) {
  if (latencyMs <= maxLatencyMs) return { pass: true };
  return { pass: false, reason: `Latency ${latencyMs}ms exceeded max ${maxLatencyMs}ms` };
}
