/**
 * stale_data verifier — Example verifier for the Agent Tool Forge CLI demo.
 * Applies to weather/forecast tools. Warns if fetchedAt is older than threshold.
 */

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const staleDataVerifier = {
  name: 'stale_data',
  order: 'B-0001',
  description: 'Warns when tool response data is older than the staleness threshold.',

  verify(response, _toolCalls) {
    // EXTENSION POINT: check fetchedAt against current time
    if (!response?.fetchedAt) {
      return { pass: true, warnings: ['No fetchedAt timestamp — skipping staleness check'], flags: [] };
    }

    const age = Date.now() - new Date(response.fetchedAt).getTime();
    if (age > STALENESS_THRESHOLD_MS) {
      return {
        pass: false,
        warnings: [`Data is ${Math.round(age / 1000)}s old (threshold: ${STALENESS_THRESHOLD_MS / 1000}s)`],
        flags: ['stale_data']
      };
    }

    return { pass: true, warnings: [], flags: [] };
  }
};
