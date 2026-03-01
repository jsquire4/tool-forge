// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

/**
 * Compose multiple grader functions — passes only if ALL pass.
 * @param {Array<(input: unknown) => Promise<{pass: boolean, reason?: string}>>} graders
 * @returns {(input: unknown) => Promise<{pass: boolean, reason?: string}>}
 */
export function all(graders) {
  return async (input) => {
    const results = await Promise.all(graders.map(g => g(input)));
    const failed = results.filter(r => !r.pass);
    if (failed.length === 0) return { pass: true };
    return { pass: false, reason: failed.map(r => r.reason).filter(Boolean).join('; ') };
  };
}

/**
 * Compose multiple grader functions — passes if ANY pass.
 * @param {Array<(input: unknown) => Promise<{pass: boolean, reason?: string}>>} graders
 * @returns {(input: unknown) => Promise<{pass: boolean, reason?: string}>}
 */
export function any(graders) {
  return async (input) => {
    const results = await Promise.all(graders.map(g => g(input)));
    if (results.some(r => r.pass)) return { pass: true };
    return { pass: false, reason: results.map(r => r.reason).filter(Boolean).join(' | ') };
  };
}

/**
 * Invert a grader function — passes if the original fails.
 * @param {(input: unknown) => Promise<{pass: boolean, reason?: string}>} grader
 * @returns {(input: unknown) => Promise<{pass: boolean, reason?: string}>}
 */
export function not(grader) {
  return async (input) => {
    const result = await grader(input);
    if (!result.pass) return { pass: true };
    return { pass: false, reason: `Expected grader to fail but it passed` };
  };
}
