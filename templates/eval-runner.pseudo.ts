// ============================================================================
// Eval Runner — Reference Implementation (Pseudo-Code)
//
// This is NOT a runnable harness. It shows the runner contract in action so you
// can adapt it to your stack. Every EXTENSION POINT marks where your stack-
// specific code goes.
//
// Estimated adaptation effort: 2-4 hours for a working runner.
// ============================================================================

// ── Types ───────────────────────────────────────────────────────────────────

interface RunnerConfig {
  agentEndpoint: string;
  seedManifestPath: string;
  snapshotEnabled: boolean;
  outputDir: string;
  baselineRunId: string | null;
  concurrency: number;
  timeoutMs: number;
  toolRegistryPath: string;
}

interface AgentResponse {
  response: string;
  toolCalls: { name: string; success: boolean; durationMs: number }[];
  durationMs: number;
}

interface EvalCase {
  id: string;
  description: string;
  difficulty?: string;
  input: { message: string };
  expect: Record<string, unknown>;
}

interface EvalFile {
  metadata: {
    toolName: string;
    toolVersion: string;
    descriptionHash: string;
    registrySize: number;
    generatedAt: string;
    tier: string;
  } | null;
  cases: EvalCase[];
}

interface CaseResult {
  id: string;
  description: string;
  passed: boolean;
  durationMs: number;
  assertionsRun: number;
  assertionsSkipped: number;
  error?: string;
  details: Record<string, unknown>;
}

// ── Entry Point ─────────────────────────────────────────────────────────────

async function runEvalSuite(evalFilePath: string, config: RunnerConfig) {

  // 1. Load eval file — accept both envelope and bare-array formats
  const raw = JSON.parse(readFile(evalFilePath));
  const evalFile: EvalFile = Array.isArray(raw)
    ? { metadata: null, cases: raw }
    : raw;

  // 2. Load seed manifest
  const seedData = fileExists(config.seedManifestPath)
    ? JSON.parse(readFile(config.seedManifestPath))
    : {};

  // 3. Capture snapshot (if enabled)
  const snapshotData = config.snapshotEnabled
    ? await captureSnapshot()   // EXTENSION POINT: your live data capture
    : {};

  // 4. Run staleness checks
  const stalenessWarnings = evalFile.metadata
    ? checkStaleness(evalFile.metadata, config.toolRegistryPath)
    : [];

  // 5. Run each case
  const results: CaseResult[] = [];

  // Sequential by default; parallelize with a concurrency limiter if config.concurrency > 1
  for (const evalCase of evalFile.cases) {
    const result = await runSingleCase(evalCase, config, seedData, snapshotData);
    results.push(result);

    // Print progress inline
    const icon = result.passed ? '✓' : '✗';
    print(`  ${icon} ${result.id}  ${result.description}  ${result.durationMs}ms`);
    if (result.error) {
      print(`    → ${result.error}`);
    }
  }

  // 6. Compute summary
  const summary = {
    totalCases: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    skippedAssertions: results.reduce((n, r) => n + r.assertionsSkipped, 0),
    totalDurationMs: results.reduce((n, r) => n + r.durationMs, 0),
    estimatedCostUsd: null // EXTENSION POINT: estimate from token counts if available
  };

  // 7. Baseline diff (if configured)
  const { regressions, newPasses } = config.baselineRunId
    ? diffAgainstBaseline(config.baselineRunId, results, config.outputDir)
    : { regressions: [], newPasses: [] };

  // 8. Write result file
  const suiteResult = {
    runId: generateUUID(),
    timestamp: new Date().toISOString(),
    tier: evalFile.metadata?.tier ?? 'unknown',
    toolName: evalFile.metadata?.toolName ?? inferToolName(evalFilePath),
    agentEndpoint: config.agentEndpoint,
    metadata: getCurrentMetadata(config.toolRegistryPath, evalFile.metadata?.toolName),
    stalenessWarnings,
    cases: results,
    summary,
    baselineRunId: config.baselineRunId,
    regressions,
    newPasses
  };

  const outputPath = `${config.outputDir}/${suiteResult.toolName}-${suiteResult.tier}-${suiteResult.runId}.json`;
  writeFile(outputPath, JSON.stringify(suiteResult, null, 2));

  // 9. Print summary
  printSummary(suiteResult);

  return suiteResult;
}

// ── Single Case Execution ───────────────────────────────────────────────────

async function runSingleCase(
  evalCase: EvalCase,
  config: RunnerConfig,
  seedData: Record<string, unknown>,
  snapshotData: Record<string, unknown>
): Promise<CaseResult> {

  let assertionsRun = 0;
  let assertionsSkipped = 0;
  const details: Record<string, unknown> = {};

  try {
    // Send message to agent
    const agentResponse = await sendToAgent(config.agentEndpoint, evalCase.input.message, config.timeoutMs);
    // EXTENSION POINT: sendToAgent wraps your agent's API
    // Must return: { response: string, toolCalls: [...], durationMs: number }

    details.toolsCalled = agentResponse.toolCalls.map(tc => tc.name);
    details.responseLength = agentResponse.response.length;
    details.skippedTokens = [];

    const expect = evalCase.expect;

    // ── Assertion 1: toolsCalled (exact match) ──
    if (expect.toolsCalled) {
      assertionsRun++;
      const actual = agentResponse.toolCalls.map(tc => tc.name);
      const expected = expect.toolsCalled as string[];
      if (!arraysEqual(actual, expected)) {
        throw new AssertionError(
          `toolsCalled: expected [${expected}] but got [${actual}]`
        );
      }
    }

    // ── Assertion 2: toolsAcceptable (any valid set) ──
    if (expect.toolsAcceptable) {
      assertionsRun++;
      const actual = agentResponse.toolCalls.map(tc => tc.name).sort();
      const acceptableSets = (expect.toolsAcceptable as string[][]).map(set => {
        if (set.length === 1 && set[0] === '__none__') return [];
        return [...set].sort();
      });
      const matched = acceptableSets.some(set => arraysEqual(actual, set));
      if (!matched) {
        throw new AssertionError(
          `toolsAcceptable: [${actual}] not in acceptable sets: ${JSON.stringify(expect.toolsAcceptable)}`
        );
      }
    }

    // ── Assertion 3: toolsNotCalled ──
    if (expect.toolsNotCalled) {
      assertionsRun++;
      const actual = agentResponse.toolCalls.map(tc => tc.name);
      for (const forbidden of expect.toolsNotCalled as string[]) {
        if (actual.includes(forbidden)) {
          throw new AssertionError(`toolsNotCalled: ${forbidden} was called`);
        }
      }
    }

    // ── Assertion 4: noToolErrors ──
    if (expect.noToolErrors) {
      assertionsRun++;
      const errored = agentResponse.toolCalls.filter(tc => !tc.success);
      if (errored.length > 0) {
        throw new AssertionError(
          `noToolErrors: ${errored.map(tc => tc.name)} errored`
        );
      }
    }

    // ── Assertion 5: responseNonEmpty ──
    if (expect.responseNonEmpty) {
      assertionsRun++;
      if (agentResponse.response.trim().length === 0) {
        throw new AssertionError('responseNonEmpty: response was empty');
      }
    }

    // ── Assertion 6: responseContains ──
    if (expect.responseContains) {
      for (const raw of expect.responseContains as string[]) {
        const resolved = resolveToken(raw, seedData, snapshotData);
        if (resolved === UNRESOLVED) {
          assertionsSkipped++;
          (details.skippedTokens as string[]).push(raw);
          continue;
        }
        assertionsRun++;
        if (!agentResponse.response.includes(resolved)) {
          throw new AssertionError(
            `responseContains: expected '${resolved}' in response but not found`
          );
        }
      }
    }

    // ── Assertion 7: responseContainsAny ──
    if (expect.responseContainsAny) {
      for (const group of expect.responseContainsAny as string[][]) {
        const resolvedGroup = group
          .map(v => resolveToken(v, seedData, snapshotData))
          .filter(v => v !== UNRESOLVED);
        if (resolvedGroup.length === 0) {
          assertionsSkipped++;
          continue;
        }
        assertionsRun++;
        const found = resolvedGroup.some(v => agentResponse.response.includes(v));
        if (!found) {
          throw new AssertionError(
            `responseContainsAny: none of [${resolvedGroup}] found in response`
          );
        }
      }
    }

    // ── Assertion 8: responseNotContains ──
    if (expect.responseNotContains) {
      for (const raw of expect.responseNotContains as string[]) {
        const resolved = resolveToken(raw, seedData, snapshotData);
        if (resolved === UNRESOLVED) {
          assertionsSkipped++;
          continue;
        }
        assertionsRun++;
        if (agentResponse.response.includes(resolved)) {
          throw new AssertionError(
            `responseNotContains: found '${resolved}' in response`
          );
        }
      }
    }

    // ── Assertion 9: responseMatches (regex) ──
    if (expect.responseMatches) {
      for (const pattern of expect.responseMatches as string[]) {
        assertionsRun++;
        const regex = new RegExp(pattern);
        if (!regex.test(agentResponse.response)) {
          throw new AssertionError(
            `responseMatches: pattern /${pattern}/ did not match`
          );
        }
      }
    }

    // ── Assertion 10: maxLatencyMs ──
    if (expect.maxLatencyMs) {
      assertionsRun++;
      if (agentResponse.durationMs > (expect.maxLatencyMs as number)) {
        throw new AssertionError(
          `maxLatencyMs: ${agentResponse.durationMs}ms > ${expect.maxLatencyMs}ms`
        );
      }
    }

    // ── Assertion 11: maxTokens ──
    if (expect.maxTokens) {
      assertionsRun++;
      const tokenCount = estimateTokens(agentResponse.response);
      // EXTENSION POINT: use your tokenizer (tiktoken, cl100k, etc.)
      if (tokenCount > (expect.maxTokens as number)) {
        throw new AssertionError(
          `maxTokens: ${tokenCount} > ${expect.maxTokens}`
        );
      }
    }

    // All assertions passed
    return {
      id: evalCase.id,
      description: evalCase.description,
      passed: true,
      durationMs: agentResponse.durationMs,
      assertionsRun,
      assertionsSkipped,
      details
    };

  } catch (err) {
    return {
      id: evalCase.id,
      description: evalCase.description,
      passed: false,
      durationMs: 0, // may not have completed
      assertionsRun,
      assertionsSkipped,
      error: err instanceof AssertionError ? err.message : String(err),
      details
    };
  }
}

// ── Template Token Resolution ───────────────────────────────────────────────

const UNRESOLVED = Symbol('UNRESOLVED');

function resolveToken(
  value: string,
  seedData: Record<string, unknown>,
  snapshotData: Record<string, unknown>
): string | typeof UNRESOLVED {

  // Not a template token — return as-is
  if (!value.startsWith('{{') || !value.endsWith('}}')) {
    return value;
  }

  const inner = value.slice(2, -2); // e.g., "seed:holdings.equities[0].symbol"
  const colonIdx = inner.indexOf(':');
  if (colonIdx === -1) return value; // malformed token, treat as literal

  const source = inner.slice(0, colonIdx);   // "seed" or "snapshot"
  const path = inner.slice(colonIdx + 1);    // "holdings.equities[0].symbol"

  const data = source === 'seed' ? seedData
             : source === 'snapshot' ? snapshotData
             : null;

  if (!data) return UNRESOLVED;

  // Walk the path
  let current: unknown = data;
  const segments = path.split('.');

  for (const segment of segments) {
    if (current == null) return UNRESOLVED;

    // Check for array index: "equities[0]"
    const bracketMatch = segment.match(/^(\w+)\[(\d+)\]$/);
    if (bracketMatch) {
      const [, key, indexStr] = bracketMatch;
      current = (current as Record<string, unknown>)[key];
      if (!Array.isArray(current)) return UNRESOLVED;
      current = current[parseInt(indexStr, 10)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  if (current === undefined || current === null) return UNRESOLVED;

  // Convert to string
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  return JSON.stringify(current);
}

// ── Staleness Checks ────────────────────────────────────────────────────────

function checkStaleness(
  metadata: EvalFile['metadata'],
  toolRegistryPath: string
): string[] {
  const warnings: string[] = [];
  if (!metadata) return warnings;

  // EXTENSION POINT: Load your tool registry and find the tool by name
  const tool = loadToolFromRegistry(toolRegistryPath, metadata.toolName);
  if (!tool) {
    warnings.push(`Tool '${metadata.toolName}' not found in registry`);
    return warnings;
  }

  // Description hash check
  const currentDescHash = sha256(tool.description).substring(0, 12);
  if (currentDescHash !== metadata.descriptionHash) {
    warnings.push(
      `Description hash mismatch for ${metadata.toolName}: ` +
      `generated against ${metadata.descriptionHash}, current is ${currentDescHash}. ` +
      `Revalidate before treating failures as regressions.`
    );
  }

  // Version check
  if (tool.version && metadata.toolVersion) {
    const currentMajor = tool.version.split('.')[0];
    const evalMajor = metadata.toolVersion.split('.')[0];
    if (currentMajor !== evalMajor) {
      warnings.push(
        `Major version mismatch for ${metadata.toolName}: ` +
        `evals generated for v${metadata.toolVersion}, current is v${tool.version}. ` +
        `Schema may have changed.`
      );
    }
  }

  // Registry size check
  const currentSize = countToolsInRegistry(toolRegistryPath);
  if (currentSize > metadata.registrySize * 1.5) {
    warnings.push(
      `Registry has grown from ${metadata.registrySize} to ${currentSize} tools. ` +
      `Labeled evals may have under-specified toolsAcceptable sets.`
    );
  }

  return warnings;
}

// ── Baseline Diffing ────────────────────────────────────────────────────────

function diffAgainstBaseline(
  baselineRunId: string,
  currentResults: CaseResult[],
  outputDir: string
): { regressions: string[]; newPasses: string[] } {

  // EXTENSION POINT: Load baseline result file by runId from outputDir
  const baseline = loadBaselineResult(outputDir, baselineRunId);
  if (!baseline) return { regressions: [], newPasses: [] };

  const baselineMap = new Map(baseline.cases.map(c => [c.id, c.passed]));
  const regressions: string[] = [];
  const newPasses: string[] = [];

  for (const current of currentResults) {
    const baselinePassed = baselineMap.get(current.id);
    if (baselinePassed === undefined) continue; // new case, no comparison

    if (baselinePassed && !current.passed) {
      regressions.push(current.id);
    }
    if (!baselinePassed && current.passed) {
      newPasses.push(current.id);
    }
  }

  return { regressions, newPasses };
}

// ── Utility Stubs ───────────────────────────────────────────────────────────
// EXTENSION POINT: Replace with real implementations for your stack.

async function sendToAgent(endpoint: string, message: string, timeoutMs: number): Promise<AgentResponse> {
  // HTTP example:
  //   const start = Date.now();
  //   const res = await fetch(endpoint, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ message }),
  //     signal: AbortSignal.timeout(timeoutMs)
  //   });
  //   const body = await res.json();
  //   return { response: body.response, toolCalls: body.toolCalls, durationMs: Date.now() - start };
  throw new Error('Not implemented — replace with your agent client');
}

async function captureSnapshot(): Promise<Record<string, unknown>> {
  // Fetch live data for {{snapshot:*}} tokens
  throw new Error('Not implemented — replace with your snapshot capture logic');
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

function loadToolFromRegistry(registryPath: string, toolName: string): any { /* ... */ }
function countToolsInRegistry(registryPath: string): number { /* ... */ }
function loadBaselineResult(outputDir: string, runId: string): any { /* ... */ }
function getCurrentMetadata(registryPath: string, toolName?: string): any { /* ... */ }
function inferToolName(filePath: string): string { /* ... */ }

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sha256(input: string): string { /* ... */ }
function generateUUID(): string { /* ... */ }
function readFile(path: string): string { /* ... */ }
function writeFile(path: string, content: string): void { /* ... */ }
function fileExists(path: string): boolean { /* ... */ }
function print(msg: string): void { /* ... */ }
function printSummary(result: any): void { /* ... */ }

class AssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'AssertionError'; }
}
