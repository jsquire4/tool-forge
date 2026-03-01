/**
 * Verifier Worker — ESM Worker thread for sandboxed custom verifier execution.
 *
 * Receives: { id, verifierPath, exportName, toolName, args, result }
 * Replies:  { id, outcome, message }
 *
 * Outcomes: 'pass' | 'warn' | 'block'
 * On unhandled error: posts { id, outcome: 'warn', message: err.message }
 *
 * Module cache: each worker caches imported verifier modules after first load,
 * so repeated calls to the same file are cheap.
 */

import { parentPort } from 'worker_threads';
import { isAbsolute } from 'path';

// Module cache: verifierPath → exported function
const moduleCache = new Map();

async function loadFn(verifierPath, exportName) {
  const cacheKey = `${verifierPath}::${exportName}`;
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey);

  const mod = await import(verifierPath);
  const fn = mod[exportName || 'verify'] || mod.default;
  moduleCache.set(cacheKey, fn ?? null);
  return fn ?? null;
}

parentPort.on('message', async ({ id, verifierPath, exportName, toolName, args, result }) => {
  if (typeof verifierPath !== 'string' || !isAbsolute(verifierPath) || verifierPath.startsWith('data:')) {
    parentPort.postMessage({ id, outcome: 'warn', message: 'Invalid verifier path: must be an absolute file path' });
    return;
  }
  try {
    const fn = await loadFn(verifierPath, exportName);
    if (typeof fn !== 'function') {
      parentPort.postMessage({ id, outcome: 'warn', message: `Custom verifier "${verifierPath}": no verify function found` });
      return;
    }
    const vResult = await fn(toolName, args, result);
    const outcome = vResult?.outcome ?? 'pass';
    const message = vResult?.message ?? null;
    parentPort.postMessage({ id, outcome, message });
  } catch (err) {
    parentPort.postMessage({ id, outcome: 'warn', message: err?.message ?? String(err) });
  }
});
