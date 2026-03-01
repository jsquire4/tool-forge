/**
 * VerifierRunner — post-tool-call checks in the live ReAct loop.
 *
 * Verifier types:
 *   schema  — JSON Schema validation on result (basic type + required checks)
 *   pattern — regex match/reject on result text
 *   custom  — user-provided function loaded from verifiersDir
 *
 * Returns worst outcome: block > warn > pass.
 * Block short-circuits (stops pipeline immediately).
 */

import { insertVerifierResult } from './db.js';
import { resolve, isAbsolute } from 'path';

const OUTCOME_SEVERITY = { pass: 0, warn: 1, block: 2 };

export class VerifierRunner {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} config — forge config (used for verifiersDir path + sandbox settings)
   * @param {import('./verifier-worker-pool.js').VerifierWorkerPool} [workerPool] — optional pre-created pool
   */
  constructor(db, config = {}, workerPool = null) {
    this._db = db;
    this._config = config;
    this._verifiers = new Map(); // toolName → verifier[]
    this._workerPool = workerPool;
    this._ownPool = false; // true if we created the pool internally
  }

  /**
   * Tear down the worker pool (if we own it).
   * Call this when the sidecar shuts down.
   */
  destroy() {
    if (this._ownPool && this._workerPool) {
      this._workerPool.destroy();
      this._workerPool = null;
    }
  }

  /**
   * Register verifiers for a tool (manual/programmatic registration).
   * @param {string} toolName
   * @param {Array<{ name: string, type: 'schema'|'pattern'|'custom', spec: object, order?: string }>} verifiers
   */
  registerVerifiers(toolName, verifiers) {
    this._verifiers.set(toolName, verifiers);
  }

  /**
   * Load all enabled verifiers and their bindings from the DB.
   * Builds the internal _verifiers Map keyed by tool_name.
   * Wildcard bindings stored under '*'.
   *
   * For custom type: spec_json = { filePath, exportName }. Runs through worker pool if sandbox enabled.
   * If file missing → register a warn-only stub.
   *
   * @param {import('better-sqlite3').Database} db
   */
  async loadFromDb(db) {
    const targetDb = db || this._db;
    if (!targetDb) return;

    // Lazily create worker pool for custom verifiers if sandbox is enabled
    // and no pool was provided to the constructor.
    const sandboxEnabled = this._config?.verification?.sandbox !== false;
    if (sandboxEnabled && !this._workerPool) {
      const { VerifierWorkerPool } = await import('./verifier-worker-pool.js');
      this._workerPool = new VerifierWorkerPool({
        size: this._config?.verification?.workerPoolSize ?? undefined,
        timeoutMs: this._config?.verification?.customTimeout ?? 2000,
        maxQueueDepth: this._config?.verification?.maxQueueDepth ?? 200
      });
      this._ownPool = true;
    }

    // Get all enabled verifiers with their bindings
    const allVerifiers = targetDb.prepare(
      'SELECT * FROM verifier_registry WHERE enabled = 1 ORDER BY aciru_order ASC'
    ).all();

    const allBindings = targetDb.prepare(
      'SELECT * FROM verifier_tool_bindings WHERE enabled = 1'
    ).all();

    // Build a map: tool_name → sorted verifier specs
    const toolMap = new Map();

    for (const binding of allBindings) {
      const verifier = allVerifiers.find(v => v.verifier_name === binding.verifier_name);
      if (!verifier) continue;

      let spec;
      try {
        spec = JSON.parse(verifier.spec_json);
      } catch (err) {
        process.stderr.write(`[verifier-runner] Skipping verifier "${verifier.verifier_name}": malformed spec_json: ${err.message}\n`);
        continue;
      }

      const entry = {
        name: verifier.verifier_name,
        type: verifier.type,
        order: verifier.aciru_order,
        spec
      };

      // For custom verifiers, resolve the path (sandboxed to verifiersDir)
      if (verifier.type === 'custom' && spec.filePath) {
        const verifiersDir = this._config?.verification?.verifiersDir;
        const resolvedPath = isAbsolute(spec.filePath) ? spec.filePath : resolve(spec.filePath);
        if (!verifiersDir || !resolvedPath.startsWith(resolve(verifiersDir))) {
          entry.spec = { fn: () => ({ outcome: 'warn', message: `Custom verifier "${verifier.verifier_name}": path outside verifiersDir` }) };
          const toolName = binding.tool_name;
          if (!toolMap.has(toolName)) toolMap.set(toolName, []);
          toolMap.get(toolName).push(entry);
          continue;
        }
        // If sandbox mode and worker pool available, store path for pool dispatch
        if (this._workerPool) {
          entry.spec = {
            ...spec,
            resolvedPath,
            exportName: spec.exportName || 'verify',
            usePool: true
          };
        } else {
          // Sandbox disabled — import directly (dev mode)
          try {
            const mod = await import(resolvedPath);
            const fn = mod[spec.exportName || 'verify'] || mod.default;
            entry.spec = typeof fn === 'function'
              ? { ...spec, fn }
              : { fn: () => ({ outcome: 'warn', message: `Custom verifier "${verifier.verifier_name}": no verify function found` }) };
          } catch {
            entry.spec = { fn: () => ({ outcome: 'warn', message: `Custom verifier "${verifier.verifier_name}": file not found or import failed` }) };
          }
        }
        // Store verifier role for pool timeout/crash outcome
        entry.role = verifier.role ?? 'any';
      }

      const toolName = binding.tool_name;
      if (!toolMap.has(toolName)) toolMap.set(toolName, []);
      toolMap.get(toolName).push(entry);
    }

    // Sort each tool's verifiers by order
    for (const [key, verifiers] of toolMap) {
      verifiers.sort((a, b) => a.order.localeCompare(b.order));
      this._verifiers.set(key, verifiers);
    }
  }

  /**
   * Run all registered verifiers for a tool against the call result.
   * Merges tool-specific verifiers + wildcard ('*') verifiers.
   * Deduplicates by verifier name. Sorts by ACIRU order.
   * Block short-circuits (returns immediately).
   *
   * @param {string} toolName
   * @param {object} args — tool call input
   * @param {object} result — tool call result ({ status, body, error })
   * @returns {{ outcome: 'pass'|'warn'|'block', message: string|null, verifierName: string|null }}
   */
  async verify(toolName, args, result) {
    const toolSpecific = this._verifiers.get(toolName) || [];
    const wildcards = this._verifiers.get('*') || [];

    // Merge and deduplicate by name
    const seen = new Set();
    const merged = [];
    for (const v of [...toolSpecific, ...wildcards]) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        merged.push(v);
      }
    }

    if (merged.length === 0) {
      return { outcome: 'pass', message: null, verifierName: null };
    }

    // Sort by order field if present
    merged.sort((a, b) => (a.order ?? 'Z-9999').localeCompare(b.order ?? 'Z-9999'));

    let worst = { outcome: 'pass', message: null, verifierName: null };

    for (const v of merged) {
      let vResult;
      try {
        switch (v.type) {
          case 'schema':
            vResult = runSchemaVerifier(v.spec, result.body);
            break;
          case 'pattern':
            vResult = runPatternVerifier(v.spec, result.body);
            break;
          case 'custom':
            vResult = await runCustomVerifier(v.spec, toolName, args, result, this._workerPool, v.role ?? 'any');
            break;
          default:
            vResult = { outcome: 'pass', message: `Unknown verifier type: ${v.type}` };
        }
      } catch (err) {
        vResult = { outcome: 'warn', message: `Verifier "${v.name}" threw: ${err.message}` };
      }

      // Block → short-circuit immediately
      if (vResult.outcome === 'block') {
        return { ...vResult, verifierName: v.name };
      }

      if (!(vResult.outcome in OUTCOME_SEVERITY)) {
        vResult = { outcome: 'warn', message: `Verifier "${v.name}" returned invalid outcome: "${vResult.outcome}"` };
      }
      if (OUTCOME_SEVERITY[vResult.outcome] > OUTCOME_SEVERITY[worst.outcome]) {
        worst = { ...vResult, verifierName: v.name };
      }
    }

    return worst;
  }

  /**
   * Log a verifier result to the verifier_results table.
   * @param {string} sessionId
   * @param {string} toolName
   * @param {{ outcome: string, message: string|null, verifierName: string|null }} result
   */
  logResult(sessionId, toolName, result) {
    if (!this._db) return;
    try {
      insertVerifierResult(this._db, {
        session_id: sessionId,
        tool_name: toolName,
        verifier_name: result.verifierName ?? 'unknown',
        outcome: result.outcome,
        message: result.message ?? null
      });
    } catch { /* log failure is non-fatal */ }
  }
}

// ── Verifier implementations ─────────────────────────────────────────────

/**
 * Schema verifier — basic type + required field checks.
 * @param {object} schema — { required: string[], properties: { [key]: { type } } }
 * @param {object} body — tool result body
 * @returns {{ outcome: string, message: string|null }}
 */
function runSchemaVerifier(schema, body) {
  if (!body || typeof body !== 'object') {
    return { outcome: 'block', message: 'Result is not an object' };
  }

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in body)) {
        return { outcome: 'block', message: `Missing required field: ${field}` };
      }
    }
  }

  // Check types
  if (schema.properties) {
    for (const [key, def] of Object.entries(schema.properties)) {
      if (key in body && def.type) {
        const actualType = Array.isArray(body[key]) ? 'array' : typeof body[key];
        if (actualType !== def.type) {
          return { outcome: 'block', message: `Field "${key}" expected type "${def.type}", got "${actualType}"` };
        }
      }
    }
  }

  return { outcome: 'pass', message: null };
}

/**
 * Pattern verifier — regex match/reject on stringified result.
 * @param {{ match?: string, reject?: string, outcome?: string }} spec
 * @param {object} body
 * @returns {{ outcome: string, message: string|null }}
 */
function runPatternVerifier(spec, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const outcome = spec.outcome ?? 'warn';

  if (spec.reject) {
    let regex;
    try { regex = new RegExp(spec.reject); } catch (err) {
      return { outcome: 'warn', message: `Invalid reject regex "${spec.reject}": ${err.message}` };
    }
    if (regex.test(text)) {
      return { outcome, message: `Result matches reject pattern: ${spec.reject}` };
    }
  }

  if (spec.match) {
    let regex;
    try { regex = new RegExp(spec.match); } catch (err) {
      return { outcome: 'warn', message: `Invalid match regex "${spec.match}": ${err.message}` };
    }
    if (!regex.test(text)) {
      return { outcome, message: `Result does not match required pattern: ${spec.match}` };
    }
  }

  return { outcome: 'pass', message: null };
}

/**
 * Custom verifier — routes through worker pool (sandboxed) or calls directly (dev mode).
 * @param {{ fn?: Function, resolvedPath?: string, exportName?: string, usePool?: boolean }} spec
 * @param {string} toolName
 * @param {object} args
 * @param {object} result
 * @param {import('./verifier-worker-pool.js').VerifierWorkerPool|null} workerPool
 * @param {string} role — 'read' | 'write' | 'any'
 * @returns {Promise<{ outcome: string, message: string|null }>}
 */
async function runCustomVerifier(spec, toolName, args, result, workerPool, role) {
  // Sandboxed path: dispatch to worker pool
  if (spec.usePool && workerPool) {
    return workerPool.run(spec.resolvedPath, spec.exportName, toolName, args, result, role);
  }

  // Direct (non-sandboxed / dev mode)
  if (typeof spec.fn !== 'function') {
    return { outcome: 'warn', message: 'Custom verifier has no fn function' };
  }
  return await spec.fn(toolName, args, result);
}
