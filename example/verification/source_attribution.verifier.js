/**
 * source_attribution verifier — Example verifier for the Agent Tool Forge CLI demo.
 * Applies to all tools (wildcard group). Checks that data has a declared source.
 */

export const sourceAttributionVerifier = {
  name: 'source_attribution',
  order: 'A-0001',
  description: 'Verifies that tool responses include a data source attribution.',

  verify(response, _toolCalls) {
    // EXTENSION POINT: check that weather data is attributed to its API source
    // e.g. if (!response?.source) return { pass: false, warnings: ['Missing source attribution'] };
    return { pass: true, warnings: [], flags: [] };
  }
};
