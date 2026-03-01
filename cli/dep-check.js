/**
 * Dependency Checker — shared utility for checking and optionally
 * installing npm dependencies at runtime.
 *
 * Used by:
 *   - forge-service.js (non-interactive: requireDependency)
 *   - init.js          (interactive: ensureDependencyInteractive)
 */

import { execFileSync } from 'child_process';

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
    const notInstalled = err.code === 'MODULE_NOT_FOUND' ||
      err.message?.includes('Cannot find package') ||
      err.message?.includes('Does the file exist?') ||
      err.message?.includes('Failed to load url');
    return {
      available: false,
      error: err.message,
      likelyCause: notInstalled ? 'not_installed' : 'broken_package'
    };
  }
}

/**
 * Return a human-readable install hint for a missing package.
 *
 * @param {string} packageName
 * @returns {string}
 */
function installHint(packageName) {
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
  const result = await checkDependency(packageName);
  if (!result.available) {
    if (result.likelyCause === 'broken_package') {
      throw new Error(
        `Package "${packageName}" is installed but failed to load: ${result.error}\nThis may be a native addon compilation issue. Try: npm rebuild ${packageName}`
      );
    }
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
    execFileSync('npm', ['install', packageName], { stdio: 'pipe', timeout: 30000 });
    // Verify it's actually available now
    const recheck = await checkDependency(packageName);
    return recheck.available;
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    console.error(`  ✗ Failed to install ${packageName}: ${detail}`);
    return false;
  }
}
