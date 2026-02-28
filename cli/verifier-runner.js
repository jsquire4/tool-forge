/**
 * VerifierRunner — post-tool-call checks in the live ReAct loop.
 *
 * Verifier types:
 *   schema  — JSON Schema validation on result (basic type + required checks)
 *   pattern — regex match/reject on result text
 *   custom  — user-provided function loaded from verifiersDir
 *
 * Returns worst outcome: block > warn > pass.
 */

import { insertVerifierResult } from './db.js';

const OUTCOME_SEVERITY = { pass: 0, warn: 1, block: 2 };

export class VerifierRunner {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} config — forge config (used for verifiersDir path)
   */
  constructor(db, config = {}) {
    this._db = db;
    this._config = config;
    this._verifiers = new Map(); // toolName → verifier[]
  }

  /**
   * Register verifiers for a tool.
   * @param {string} toolName
   * @param {Array<{ name: string, type: 'schema'|'pattern'|'custom', spec: object }>} verifiers
   */
  registerVerifiers(toolName, verifiers) {
    this._verifiers.set(toolName, verifiers);
  }

  /**
   * Run all registered verifiers for a tool against the call result.
   * Returns worst outcome across all verifiers.
   *
   * @param {string} toolName
   * @param {object} args — tool call input
   * @param {object} result — tool call result ({ status, body, error })
   * @returns {{ outcome: 'pass'|'warn'|'block', message: string|null, verifierName: string|null }}
   */
  async verify(toolName, args, result) {
    const verifiers = this._verifiers.get(toolName);
    if (!verifiers || verifiers.length === 0) {
      return { outcome: 'pass', message: null, verifierName: null };
    }

    let worst = { outcome: 'pass', message: null, verifierName: null };

    for (const v of verifiers) {
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
            vResult = await runCustomVerifier(v.spec, toolName, args, result);
            break;
          default:
            vResult = { outcome: 'pass', message: `Unknown verifier type: ${v.type}` };
        }
      } catch (err) {
        vResult = { outcome: 'warn', message: `Verifier "${v.name}" threw: ${err.message}` };
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
    const regex = new RegExp(spec.reject);
    if (regex.test(text)) {
      return { outcome, message: `Result matches reject pattern: ${spec.reject}` };
    }
  }

  if (spec.match) {
    const regex = new RegExp(spec.match);
    if (!regex.test(text)) {
      return { outcome, message: `Result does not match required pattern: ${spec.match}` };
    }
  }

  return { outcome: 'pass', message: null };
}

/**
 * Custom verifier — calls a user-provided function.
 * @param {{ fn: Function }} spec
 * @param {string} toolName
 * @param {object} args
 * @param {object} result
 * @returns {Promise<{ outcome: string, message: string|null }>}
 */
async function runCustomVerifier(spec, toolName, args, result) {
  if (typeof spec.fn !== 'function') {
    return { outcome: 'warn', message: 'Custom verifier has no fn function' };
  }
  return await spec.fn(toolName, args, result);
}
