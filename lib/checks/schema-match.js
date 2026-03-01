// Adapted from evalkit by wkhori (https://github.com/wkhori/evalkit)
// MIT License — see LICENSE

/**
 * @param {{data: Object, requiredKeys: string[], typeChecks?: Object.<string, string>}} input
 * @returns {import('./types.js').EvalResult}
 */
export function schemaMatch({ data, requiredKeys, typeChecks }) {
  const missingKeys = requiredKeys.filter(k => !(k in data));
  if (missingKeys.length > 0) {
    return { pass: false, reason: `Missing keys: ${missingKeys.join(', ')}` };
  }
  if (typeChecks) {
    const typeErrors = [];
    for (const [key, expectedType] of Object.entries(typeChecks)) {
      const actualType = typeof data[key];
      if (actualType !== expectedType) {
        typeErrors.push(`${key}: expected ${expectedType}, got ${actualType}`);
      }
    }
    if (typeErrors.length > 0) {
      return { pass: false, reason: `Type mismatches: ${typeErrors.join('; ')}` };
    }
  }
  return { pass: true };
}
