/**
 * Programmatic eval runner API.
 *
 * Usage:
 *   import { runEvalSuite } from './lib/runner/index.js';
 *   const summary = await runEvalSuite('./evals/my-tool.golden.json', async (message) => {
 *     const res = await fetch('http://localhost:8001/agent-api/chat', { ... });
 *     return { responseText: ..., toolsCalled: [], latencyMs: ... };
 *   });
 */

import { readFile } from 'node:fs/promises';
import { runChecks } from '../checks/run-checks.js';
import { checkAdapter, checkResponseContainsAnyGroups, checkToolsAcceptable } from '../checks/check-adapter.js';
import { evaluateGates } from './gate.js';
import { writeFixture, readFixture, sortKeysDeep } from '../fixtures/fixture-store.js';

/**
 * Run an eval suite programmatically.
 *
 * @param {string} evalFilePath - path to eval JSON file
 * @param {(message: string) => Promise<{responseText: string, toolsCalled: string[], latencyMs?: number, cost?: number}>} agentFn
 * @param {{
 *   record?: boolean,
 *   replay?: boolean,
 *   fixturesDir?: string,
 *   ttlDays?: number,
 *   gates?: {passRate?: number, maxCost?: number, p95LatencyMs?: number},
 *   suiteName?: string,
 * }} [opts]
 * @returns {Promise<{total: number, passed: number, failed: number, skipped: number, passRate: number, cases: object[], gates?: object}>}
 */
export async function runEvalSuite(evalFilePath, agentFn, opts = {}) {
  const { record = false, replay = false, fixturesDir = '.forge-fixtures', ttlDays = 30, gates = {}, suiteName } = opts;

  // Load eval cases
  let cases;
  try {
    const raw = await readFile(evalFilePath, 'utf8');
    cases = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to load eval file ${evalFilePath}: ${err.message}`);
  }

  if (!Array.isArray(cases)) {
    throw new Error(`Eval file must contain a JSON array of cases`);
  }

  let passed = 0, failed = 0, skipped = 0;
  const caseResults = [];
  const allLatencies = [];
  let totalCost = 0;

  for (const evalCase of cases) {
    const message = evalCase.input?.message ?? '';
    if (!message) {
      skipped++;
      caseResults.push({ id: evalCase.id, status: 'skipped', reason: 'no input message' });
      continue;
    }

    // Fixture replay
    if (replay) {
      const caseId = evalCase.id ?? message.slice(0, 40);
      const configHash = JSON.stringify(sortKeysDeep(evalCase.expect ?? {}));
      const hit = await readFixture(fixturesDir, caseId, configHash, { ttlDays });
      if (hit.status === 'hit') {
        const { responseText, toolsCalled } = hit.output;
        const failures = checkCase(evalCase, { responseText, toolsCalled });
        const casePassed = failures.length === 0;
        if (casePassed) passed++; else failed++;
        // Note: fixture hits do not contribute latency or cost — p95LatencyMs and totalCost
        // reflect live-only cases. Latency/cost gates trivially pass on fully-cached runs.
        caseResults.push({ id: evalCase.id, status: casePassed ? 'passed' : 'failed', reason: failures.join('; ') || null, fromFixture: true });
        continue;
      }
    }

    // Call agent
    let result;
    try {
      result = await agentFn(message);
    } catch (err) {
      failed++;
      caseResults.push({ id: evalCase.id, status: 'failed', reason: `Agent error: ${err.message}` });
      continue;
    }

    const { responseText = '', toolsCalled = [], latencyMs, cost } = result;

    // Record fixture
    if (record) {
      const caseId = evalCase.id ?? message.slice(0, 40);
      const configHash = JSON.stringify(sortKeysDeep(evalCase.expect ?? {}));
      await writeFixture(fixturesDir, caseId, configHash, { responseText, toolsCalled }).catch((err) => {
        console.warn(`[forge] Failed to write fixture for case "${caseId}": ${err.message}`);
      });
    }

    if (latencyMs !== undefined) allLatencies.push(latencyMs);
    if (cost !== undefined) totalCost += cost;

    const failures = checkCase(evalCase, { responseText, toolsCalled, latencyMs, cost });
    const casePassed = failures.length === 0;
    if (casePassed) passed++; else failed++;
    caseResults.push({ id: evalCase.id, status: casePassed ? 'passed' : 'failed', reason: failures.join('; ') || null });
  }

  const total = cases.length;
  const ran = passed + failed;
  const passRate = ran > 0 ? passed / ran : 0;

  // Compute p95 latency
  const sortedLatencies = [...allLatencies].sort((a, b) => a - b);
  const p95Index = Math.floor((sortedLatencies.length - 1) * 0.95);
  const p95LatencyMs = sortedLatencies[p95Index] ?? 0;

  const summary = { passRate, totalCost, p95LatencyMs, totalCases: total };

  // Gate evaluation
  let gateResult;
  if (Object.keys(gates).some(k => gates[k] != null)) {
    const activeGates = Object.fromEntries(Object.entries(gates).filter(([, v]) => v != null));
    gateResult = evaluateGates(summary, activeGates);
  }

  return {
    total,
    passed,
    failed,
    skipped,
    passRate,
    p95LatencyMs,
    totalCost,
    cases: caseResults,
    ...(suiteName ? { suiteName } : {}),
    ...(gateResult ? { gates: gateResult } : {}),
  };
}

/**
 * Internal assertion runner for a single case.
 * @param {object} evalCase
 * @param {{responseText: string, toolsCalled: string[], latencyMs?: number, cost?: number}} meta
 * @returns {string[]}
 */
function checkCase(evalCase, { responseText, toolsCalled, latencyMs, cost }) {
  const failures = [];
  const input = checkAdapter(evalCase, { toolsCalled, responseText, latencyMs, cost });
  const result = runChecks(input);
  for (const [checkName, checkResult] of Object.entries(result.checks)) {
    if (!checkResult.pass) failures.push(checkResult.reason ?? `${checkName} failed`);
  }

  const expect = evalCase.expect ?? {};
  if (expect.responseContainsAny?.length) {
    const anyResult = checkResponseContainsAnyGroups(responseText, expect.responseContainsAny);
    if (!anyResult.pass) failures.push(anyResult.reason);
  }
  if (expect.toolsAcceptable !== undefined) {
    const acceptResult = checkToolsAcceptable(toolsCalled, expect.toolsAcceptable);
    if (!acceptResult.pass) failures.push(acceptResult.reason);
  }
  return failures;
}
