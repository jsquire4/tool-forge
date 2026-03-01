// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{expected: string[], actual: string[], mode?: 'strict'|'subset'|'superset'|'unordered'}} input
 * @returns {import('./types.js').EvalResult}
 */
export function toolSelection({ expected, actual, mode = 'strict' }) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  if (mode === 'subset') {
    // expected must be subset of actual
    const missing = expected.filter(t => !actualSet.has(t));
    if (missing.length === 0) return { pass: true };
    return { pass: false, reason: `Expected tools not called: ${missing.join(', ')}` };
  }

  if (mode === 'superset') {
    // actual must be subset of expected (expected is superset)
    const unexpected = actual.filter(t => !expectedSet.has(t));
    if (unexpected.length === 0) return { pass: true };
    return { pass: false, reason: `Unexpected tools called: ${unexpected.join(', ')}` };
  }

  // strict / unordered: exact set equality
  const missing = expected.filter(t => !actualSet.has(t));
  const extra = actual.filter(t => !expectedSet.has(t));
  if (missing.length === 0 && extra.length === 0) return { pass: true };
  const parts = [];
  if (missing.length) parts.push(`missing: ${missing.join(', ')}`);
  if (extra.length) parts.push(`unexpected: ${extra.join(', ')}`);
  return { pass: false, reason: parts.join('; ') };
}
