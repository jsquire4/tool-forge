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
import path, { isAbsolute } from 'path';

if (!parentPort) throw new Error('[verifier-worker] Must be run as a Worker thread');

// Module cache: verifierPath → exported function
const moduleCache = new Map();

async function loadFn(resolved, safeExport) {
  const cacheKey = `${resolved}::${safeExport}`;
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey);

  const mod = await import(resolved);
  const fn = mod[safeExport] || mod.default;
  moduleCache.set(cacheKey, fn ?? null);
  return fn ?? null;
}

parentPort.on('message', async ({ id, verifierPath, exportName, toolName, args, result }) => {
  const resolved = typeof verifierPath === 'string' ? path.resolve(verifierPath) : null;
  if (!resolved || !resolved.endsWith('.js') || resolved.startsWith('data:')) {
    parentPort.postMessage({ id, outcome: 'warn', message: 'invalid verifier path' });
    return;
  }
  const safeExport = exportName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName) ? exportName : 'verify';
  try {
    const fn = await loadFn(resolved, safeExport);
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
