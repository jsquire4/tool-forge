/**
 * CLI handler for `node lib/index.js run`.
 *
 * Usage:
 *   node lib/index.js run --eval <path> [--record] [--replay] [--suite <name>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runEvalSuite } from './index.js';

function parseArgs(args) {
  const opts = { record: false, replay: false, evalPath: null, suite: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--eval' && args[i + 1]) { opts.evalPath = args[++i]; continue; }
    if (args[i] === '--record') { opts.record = true; continue; }
    if (args[i] === '--replay') { opts.replay = true; continue; }
    if (args[i] === '--suite' && args[i + 1]) { opts.suite = args[++i]; continue; }
  }
  return opts;
}

function loadConfig() {
  const configPath = resolve(process.cwd(), 'forge.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Warning: forge.config.json is invalid JSON: ${err.message}`);
    return {};
  }
}

async function buildAgentFn(config) {
  const agentConfig = config.agent ?? {};
  const endpoint = agentConfig.endpoint;
  if (!endpoint) {
    throw new Error('No agent.endpoint configured in forge.config.json.\nAdd: { "agent": { "endpoint": "http://localhost:8001/agent-api/chat-sync" } }');
  }

  const method = agentConfig.method ?? 'POST';
  const headers = { 'Content-Type': 'application/json', ...(agentConfig.headers ?? {}) };
  const inputField = agentConfig.inputField ?? 'message';
  const outputField = agentConfig.outputField ?? 'text';

  return async (message) => {
    const t0 = Date.now();
    const body = JSON.stringify({ [inputField]: message });
    let res;
    try {
      res = await fetch(endpoint, { method, headers, body });
    } catch (err) {
      throw new Error(`Agent request failed: ${err.message}`);
    }
    if (!res.ok) throw new Error(`Agent returned ${res.status}`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Agent at ${endpoint} returned non-JSON response (status ${res.status})`);
    }
    const latencyMs = Date.now() - t0;
    return {
      responseText: data[outputField] ?? '',
      toolsCalled: data.toolsCalled ?? [],
      latencyMs,
    };
  };
}

export async function runCli(args) {
  const opts = parseArgs(args);

  if (!opts.evalPath) {
    console.error('Usage: node lib/index.js run --eval <path> [--record] [--replay] [--suite <name>]');
    process.exit(1);
  }

  const evalPath = resolve(process.cwd(), opts.evalPath);
  if (!existsSync(evalPath)) {
    console.error(`Eval file not found: ${evalPath}`);
    process.exit(1);
  }

  const config = loadConfig();
  const gates = config.gates ?? {};
  const fixturesDir = resolve(process.cwd(), config.fixtures?.dir ?? '.forge-fixtures');
  const ttlDays = config.fixtures?.ttlDays ?? 30;

  console.log(`\nRunning evals: ${opts.evalPath}`);
  if (opts.record) console.log('  [record mode] Saving fixtures');
  if (opts.replay) console.log('  [replay mode] Using cached fixtures where available');

  let agentFn;
  try {
    agentFn = await buildAgentFn(config);
  } catch (err) {
    console.error(`\nConfiguration error: ${err.message}`);
    process.exit(1);
  }

  let summary;
  try {
    summary = await runEvalSuite(evalPath, agentFn, {
      record: opts.record,
      replay: opts.replay,
      fixturesDir,
      ttlDays,
      gates,
      suiteName: opts.suite,
    });
  } catch (err) {
    console.error(`\nEval run failed: ${err.message}`);
    process.exit(1);
  }

  // Print results
  const { total, passed, failed, skipped, passRate, p95LatencyMs, totalCost } = summary;
  const passRatePct = (passRate * 100).toFixed(1);
  const icon = failed === 0 ? '✓' : '✗';

  console.log(`\n${icon} ${passed}/${total} passed (${passRatePct}%)` +
    (skipped > 0 ? `, ${skipped} skipped` : '') +
    (p95LatencyMs > 0 ? `, p95 latency: ${p95LatencyMs}ms` : '') +
    (totalCost > 0 ? `, est. cost: $${totalCost.toFixed(6)}` : ''));

  if (summary.gates) {
    console.log('\nGate results:');
    for (const r of summary.gates.results) {
      const gateIcon = r.pass ? '  ✓' : '  ✗';
      console.log(`${gateIcon} ${r.gate}: ${r.actual} (threshold: ${r.threshold})`);
    }
    if (!summary.gates.pass) {
      console.log('\n✗ Gates failed — build should be blocked');
      process.exit(1);
    } else {
      console.log('\n✓ All gates passed');
    }
  }

  // Print failing cases
  const failures = summary.cases.filter(c => c.status === 'failed');
  if (failures.length > 0) {
    console.log('\nFailing cases:');
    for (const f of failures) {
      console.log(`  ✗ ${f.id ?? '(unnamed)'}: ${f.reason}`);
    }
    process.exit(1);
  }

  process.exit(0);
}
