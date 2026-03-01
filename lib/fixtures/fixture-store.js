// Adapted from agent-eval-kit by FlanaganSe (https://github.com/FlanaganSe/agent-eval-kit)
// MIT License — see LICENSE

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = '1.0.0';
const DEFAULT_TTL_DAYS = 30;

/**
 * Deep-sort all keys in an object (for stable hashing).
 * @param {unknown} obj
 * @returns {unknown}
 */
export function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.keys(obj).sort().map(k => [k, sortKeysDeep(obj[k])])
    );
  }
  return obj;
}

/**
 * Slugify a case ID for use as a filename.
 * @param {string} caseId
 * @returns {string}
 */
function slugify(caseId) {
  return caseId.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Get the fixture file path for a case.
 * @param {string} fixturesDir
 * @param {string} caseId
 * @returns {string}
 */
function fixturePath(fixturesDir, caseId) {
  return join(fixturesDir, `${slugify(caseId)}.jsonl`);
}

/**
 * Write a fixture to disk.
 * @param {string} fixturesDir
 * @param {string} caseId
 * @param {string} configHash
 * @param {unknown} output
 * @returns {Promise<void>}
 */
export async function writeFixture(fixturesDir, caseId, configHash, output) {
  await mkdir(fixturesDir, { recursive: true });
  const meta = { _meta: { configHash, version: VERSION, timestamp: new Date().toISOString() } };
  const data = { output };
  const content = JSON.stringify(meta) + '\n' + JSON.stringify(data) + '\n';
  await writeFile(fixturePath(fixturesDir, caseId), content, 'utf8');
}

/**
 * Read a fixture from disk.
 * @param {string} fixturesDir
 * @param {string} caseId
 * @param {string} configHash
 * @param {{ttlDays?: number}} [opts]
 * @returns {Promise<{status: 'hit', output: unknown} | {status: 'miss', reason: string, storedHash?: string, age?: number}>}
 */
export async function readFixture(fixturesDir, caseId, configHash, opts = {}) {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const path = fixturePath(fixturesDir, caseId);

  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { status: 'miss', reason: 'not-found' };
  }

  const lines = content.trim().split('\n');
  if (lines.length < 2) return { status: 'miss', reason: 'not-found' };

  let metaLine, dataLine;
  try {
    metaLine = JSON.parse(lines[0]);
    dataLine = JSON.parse(lines[1]);
  } catch {
    return { status: 'miss', reason: 'not-found' };
  }

  const stored = metaLine._meta;
  if (!stored) return { status: 'miss', reason: 'not-found' };

  if (stored.configHash !== configHash) {
    return { status: 'miss', reason: 'config-hash-mismatch', storedHash: stored.configHash };
  }

  const ageMs = Date.now() - new Date(stored.timestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > ttlDays) {
    return { status: 'miss', reason: 'stale', age: Math.floor(ageDays) };
  }

  return { status: 'hit', output: dataLine.output };
}

/**
 * List all fixture files in a directory.
 * @param {string} fixturesDir
 * @returns {Promise<string[]>} - array of caseId slugs
 */
export async function listFixtures(fixturesDir) {
  try {
    const files = await readdir(fixturesDir);
    return files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6));
  } catch {
    return [];
  }
}

/**
 * Delete all fixture files in a directory.
 * @param {string} fixturesDir
 * @returns {Promise<number>} - number of files deleted
 */
export async function clearFixtures(fixturesDir) {
  try {
    const files = await readdir(fixturesDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    await Promise.all(jsonlFiles.map(f => unlink(join(fixturesDir, f))));
    return jsonlFiles.length;
  } catch {
    return 0;
  }
}

/**
 * Get statistics about fixtures in a directory.
 * @param {string} fixturesDir
 * @returns {Promise<{count: number, totalBytes: number, oldestDays: number, newestDays: number}>}
 */
export async function fixtureStats(fixturesDir) {
  try {
    const files = await readdir(fixturesDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) return { count: 0, totalBytes: 0, oldestDays: 0, newestDays: 0 };

    const stats = await Promise.all(jsonlFiles.map(f => stat(join(fixturesDir, f))));
    const totalBytes = stats.reduce((sum, s) => sum + s.size, 0);
    const now = Date.now();
    const ages = stats.map(s => (now - s.mtimeMs) / (1000 * 60 * 60 * 24));

    return {
      count: jsonlFiles.length,
      totalBytes,
      oldestDays: Math.floor(Math.max(...ages)),
      newestDays: Math.floor(Math.min(...ages)),
    };
  } catch {
    return { count: 0, totalBytes: 0, oldestDays: 0, newestDays: 0 };
  }
}
