/**
 * Verifier Scanner — Discovers existing verifiers from barrel.
 * Used for gap detection: tools without verifier coverage.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Extract verifier names from barrel file.
 * @param {string} barrelsPath
 * @returns {string[]}
 */
function scanBarrel(barrelsPath) {
  const abs = resolve(process.cwd(), barrelsPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf-8');
  const names = [];
  const re = /export\s+\{\s*(\w+Verifier)\s*\}\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  const lines = content.split('\n').filter((l) => !l.trim().startsWith('//'));
  const text = lines.join('\n');
  while ((m = re.exec(text))) {
    const exportName = m[1];
    const snake = exportName
      .replace(/Verifier$/, '')
      .replace(/([A-Z])/g, (c) => '_' + c.toLowerCase())
      .replace(/^_/, '');
    names.push(snake);
  }
  return names;
}

/**
 * Scan verifier files for `name = 'snake_case'` pattern.
 * @param {string} verifiersDir
 * @returns {string[]}
 */
function scanVerifierFiles(verifiersDir) {
  const abs = resolve(process.cwd(), verifiersDir);
  if (!existsSync(abs)) return [];
  const names = [];
  const files = readdirSync(abs).filter(
    (f) => f.endsWith('.verifier.ts') || f.endsWith('.verifier.js')
  );
  const nameRe = /name\s*=\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    const content = readFileSync(join(abs, file), 'utf-8');
    const m = nameRe.exec(content);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Get existing verifier names.
 * @param {object} config - forge.config verification section
 * @returns {string[]}
 */
export function getExistingVerifiers(config) {
  const verifiers = [];
  if (config?.verifiersDir) {
    const fromFiles = scanVerifierFiles(config.verifiersDir);
    verifiers.push(...fromFiles);
  }
  if (config?.barrelsFile && verifiers.length === 0) {
    const fromBarrel = scanBarrel(config.barrelsFile);
    verifiers.push(...fromBarrel);
  }
  return [...new Set(verifiers)];
}
