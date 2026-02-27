/**
 * Output Groups — Infer which verifiers apply to which tools.
 * Maps tool descriptions/tags to output groups, then to suggested verifiers.
 */

const OUTPUT_GROUP_KEYWORDS = {
  holdings: ['holdings', 'positions', 'allocation', 'portfolio', 'positions'],
  dividends: ['dividends', 'income', 'yield', 'dividend'],
  performance: ['performance', 'p&l', 'returns', 'net worth', 'performance'],
  transactions: ['transactions', 'orders', 'trades', 'order'],
  quotes: ['quotes', 'prices', 'market data', 'market_data'],
  weather: ['weather', 'temperature', 'humidity', 'conditions'],
  forecast: ['forecast', 'prediction', 'outlook', 'precipitation']
};

const VERIFIER_GROUPS = {
  source_attribution: ['*'],
  concentration_risk: ['holdings'],
  stale_data: ['holdings', 'performance', 'quotes', 'dividends', 'weather', 'forecast']
};

/**
 * Infer output groups for a tool from its description and tags.
 * @param {{ description?: string; tags?: string[]; name?: string }} tool
 * @returns {string[]}
 */
export function inferOutputGroups(tool) {
  const text = [
    tool.description || '',
    (tool.tags || []).join(' '),
    tool.name || ''
  ]
    .join(' ')
    .toLowerCase();
  const groups = [];
  for (const [group, keywords] of Object.entries(OUTPUT_GROUP_KEYWORDS)) {
    if (keywords.some((k) => text.includes(k))) groups.push(group);
  }
  return groups.length > 0 ? groups : ['unknown'];
}

/**
 * Get verifiers that would cover the given output groups.
 * @param {string[]} outputGroups
 * @returns {string[]}
 */
export function getVerifiersForGroups(outputGroups) {
  const verifiers = new Set();
  for (const [verifier, groups] of Object.entries(VERIFIER_GROUPS)) {
    if (groups.includes('*')) verifiers.add(verifier);
    else if (groups.some((g) => outputGroups.includes(g))) verifiers.add(verifier);
  }
  return Array.from(verifiers);
}
