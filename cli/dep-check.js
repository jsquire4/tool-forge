/**
 * Dependency Checker — shared utility for checking and optionally
 * installing npm dependencies at runtime.
 *
 * Used by:
 *   - forge-service.js (non-interactive: requireDependency)
 *   - init.js          (interactive: ensureDependencyInteractive)
 */

import { execSync } from 'child_process';

/**
 * Check whether an npm package is available via dynamic import.
 *
 * @param {string} packageName
 * @returns {Promise<{ available: boolean, error?: string }>}
 */
export async function checkDependency(packageName) {
  try {
    await import(packageName);
    return { available: true };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Return a human-readable install hint for a missing package.
 *
 * @param {string} packageName
 * @returns {string}
 */
export function installHint(packageName) {
  return `npm install ${packageName}`;
}

/**
 * Non-interactive dependency check. Throws with a helpful message
 * if the package is not available. Used at sidecar startup where
 * there is no readline interface.
 *
 * @param {string} packageName
 * @returns {Promise<void>}
 */
export async function requireDependency(packageName) {
  const { available } = await checkDependency(packageName);
  if (!available) {
    throw new Error(
      `Required package "${packageName}" is not installed. Run: ${installHint(packageName)}`
    );
  }
}

/**
 * Interactive dependency check — prompts the user to install if missing.
 *
 * @param {string} packageName
 * @param {import('readline').Interface} rl
 * @returns {Promise<boolean>} true if the package is available after check/install
 */
export async function ensureDependencyInteractive(packageName, rl) {
  const { available } = await checkDependency(packageName);
  if (available) return true;

  const answer = await new Promise((resolve) => {
    rl.question(
      `Package "${packageName}" is not installed. Install it now? (y/n): `,
      (ans) => resolve(ans.trim().toLowerCase())
    );
  });

  if (answer !== 'y' && answer !== 'yes') {
    return false;
  }

  try {
    execSync(`npm install ${packageName}`, { stdio: 'inherit' });
    // Verify it's actually available now
    const recheck = await checkDependency(packageName);
    return recheck.available;
  } catch {
    return false;
  }
}
