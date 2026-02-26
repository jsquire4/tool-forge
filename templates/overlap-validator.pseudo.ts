// ============================================================================
// Overlap Map Validator — Pseudo-Code
//
// Validates the tool overlap map for structural integrity and generates a
// coverage gap report. Run this before generating evals or after adding a tool.
//
// Three capabilities:
//   1. Symmetry validation — every A→B overlap must have a B→A counterpart
//   2. Coverage gap report — finds tools/overlaps/clusters without eval coverage
//   3. Stale eval detection — flags labeled evals whose toolsAcceptable sets
//      may be under-specified after new tools are added
// ============================================================================

// ── Types ───────────────────────────────────────────────────────────────────

interface OverlapEntry {
  tool: string;
  overlaps: { tool: string; reason: string }[];
  clusters: { name: string; tools: string[] }[];
}

interface OverlapMap {
  tools: OverlapEntry[];
}

interface LabeledEvalCase {
  id: string;
  difficulty: string;
  expect: {
    toolsCalled?: string[];
    toolsAcceptable?: string[][];
  };
}

interface LabeledEvalFile {
  metadata?: { toolName: string };
  cases: LabeledEvalCase[];
}

interface ValidationReport {
  symmetryErrors: SymmetryError[];
  coverageGaps: CoverageGap[];
  staleEvals: StaleEvalWarning[];
  summary: string;
}

interface SymmetryError {
  toolA: string;
  toolB: string;
  direction: 'A→B exists, B→A missing';
}

interface CoverageGap {
  type: 'no_golden' | 'no_labeled' | 'overlap_no_ambiguous' | 'cluster_no_multi';
  tool?: string;
  overlap?: [string, string];
  cluster?: string;
  message: string;
}

interface StaleEvalWarning {
  evalId: string;
  toolName: string;
  reason: string;
  suggestedAction: string;
}

// ── 1. Symmetry Validation ──────────────────────────────────────────────────

function validateSymmetry(overlapMap: OverlapMap): SymmetryError[] {
  const errors: SymmetryError[] = [];

  // Build a set of all declared overlaps as "A→B" pairs
  const declaredPairs = new Set<string>();
  for (const entry of overlapMap.tools) {
    for (const overlap of entry.overlaps) {
      declaredPairs.add(`${entry.tool}→${overlap.tool}`);
    }
  }

  // For every A→B, check B→A exists
  for (const pair of declaredPairs) {
    const [toolA, toolB] = pair.split('→');
    const reverse = `${toolB}→${toolA}`;
    if (!declaredPairs.has(reverse)) {
      errors.push({
        toolA,
        toolB,
        direction: 'A→B exists, B→A missing'
      });
    }
  }

  return errors;
}

// ── 2. Coverage Gap Report ──────────────────────────────────────────────────

function findCoverageGaps(
  overlapMap: OverlapMap,
  goldenEvalFiles: Map<string, any>,    // toolName → golden eval cases
  labeledEvalFiles: Map<string, LabeledEvalFile>,  // toolName → labeled eval file
  registeredTools: string[]              // all tool names in the registry
): CoverageGap[] {
  const gaps: CoverageGap[] = [];

  // Gap A: Tools with no golden evals
  for (const tool of registeredTools) {
    if (!goldenEvalFiles.has(tool)) {
      gaps.push({
        type: 'no_golden',
        tool,
        message: `Tool '${tool}' has no golden eval file`
      });
    }
  }

  // Gap B: Tools with no labeled evals
  for (const tool of registeredTools) {
    if (!labeledEvalFiles.has(tool)) {
      gaps.push({
        type: 'no_labeled',
        tool,
        message: `Tool '${tool}' has no labeled eval file`
      });
    }
  }

  // Gap C: Declared overlaps with no ambiguous eval testing both tools
  for (const entry of overlapMap.tools) {
    for (const overlap of entry.overlaps) {
      const pair: [string, string] = [entry.tool, overlap.tool].sort() as [string, string];

      // Search all labeled evals for an ambiguous case where toolsAcceptable
      // includes a set containing both tools in this overlap pair
      const hasAmbiguousCoverage = findAmbiguousCoverageForPair(
        pair, labeledEvalFiles
      );

      if (!hasAmbiguousCoverage) {
        gaps.push({
          type: 'overlap_no_ambiguous',
          overlap: pair,
          message: `Overlap [${pair[0]}, ${pair[1]}] has no ambiguous eval ` +
                   `with toolsAcceptable containing both tools`
        });
      }
    }
  }

  // Gap D: Declared clusters with no multi-tool eval exercising the full group
  const seenClusters = new Set<string>();
  for (const entry of overlapMap.tools) {
    for (const cluster of entry.clusters) {
      if (seenClusters.has(cluster.name)) continue;
      seenClusters.add(cluster.name);

      const hasFullClusterCoverage = findClusterCoverage(
        cluster.tools, labeledEvalFiles
      );

      if (!hasFullClusterCoverage) {
        gaps.push({
          type: 'cluster_no_multi',
          cluster: cluster.name,
          message: `Cluster '${cluster.name}' [${cluster.tools.join(', ')}] ` +
                   `has no labeled eval exercising all tools in the group`
        });
      }
    }
  }

  return gaps;
}

function findAmbiguousCoverageForPair(
  pair: [string, string],
  labeledEvalFiles: Map<string, LabeledEvalFile>
): boolean {
  for (const [, evalFile] of labeledEvalFiles) {
    for (const evalCase of evalFile.cases) {
      if (evalCase.difficulty !== 'ambiguous') continue;

      // Check toolsAcceptable for a set containing both tools
      if (evalCase.expect.toolsAcceptable) {
        for (const acceptableSet of evalCase.expect.toolsAcceptable) {
          if (acceptableSet.includes(pair[0]) && acceptableSet.includes(pair[1])) {
            return true;
          }
        }
      }

      // Check toolsCalled for both tools
      if (evalCase.expect.toolsCalled) {
        if (evalCase.expect.toolsCalled.includes(pair[0]) &&
            evalCase.expect.toolsCalled.includes(pair[1])) {
          return true;
        }
      }
    }
  }
  return false;
}

function findClusterCoverage(
  clusterTools: string[],
  labeledEvalFiles: Map<string, LabeledEvalFile>
): boolean {
  for (const [, evalFile] of labeledEvalFiles) {
    for (const evalCase of evalFile.cases) {
      // Check if toolsCalled includes ALL tools in the cluster
      if (evalCase.expect.toolsCalled) {
        if (clusterTools.every(t => evalCase.expect.toolsCalled!.includes(t))) {
          return true;
        }
      }
      // Check if any toolsAcceptable set includes ALL tools
      if (evalCase.expect.toolsAcceptable) {
        for (const set of evalCase.expect.toolsAcceptable) {
          if (clusterTools.every(t => set.includes(t))) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ── 3. Stale Eval Detection ─────────────────────────────────────────────────
//
// Run after adding a new tool to the registry. Identifies labeled evals whose
// toolsAcceptable sets may need updating because a new tool creates overlap
// that didn't exist when the evals were generated.

function detectStaleEvals(
  newTool: string,
  newToolOverlaps: string[],         // tools the new tool overlaps with
  labeledEvalFiles: Map<string, LabeledEvalFile>
): StaleEvalWarning[] {
  const warnings: StaleEvalWarning[] = [];

  for (const overlapTool of newToolOverlaps) {
    const evalFile = labeledEvalFiles.get(overlapTool);
    if (!evalFile) continue;

    for (const evalCase of evalFile.cases) {
      if (evalCase.difficulty !== 'ambiguous') continue;
      if (!evalCase.expect.toolsAcceptable) continue;

      // Check if any acceptable set contains the overlapping tool but NOT the new tool.
      // This means the eval was written before the new tool existed and may need
      // an additional acceptable set that includes the new tool.
      const containsOverlapTool = evalCase.expect.toolsAcceptable.some(
        set => set.includes(overlapTool)
      );
      const containsNewTool = evalCase.expect.toolsAcceptable.some(
        set => set.includes(newTool)
      );

      if (containsOverlapTool && !containsNewTool) {
        warnings.push({
          evalId: evalCase.id,
          toolName: overlapTool,
          reason: `New tool '${newTool}' overlaps with '${overlapTool}', but ` +
                  `this eval's toolsAcceptable doesn't include '${newTool}' ` +
                  `as a valid alternative`,
          suggestedAction: `Review whether '${newTool}' should be added to ` +
                           `toolsAcceptable for this case`
        });
      }
    }
  }

  return warnings;
}

// ── 4. Description Change Impact ────────────────────────────────────────────
//
// Run when a tool's description is modified (e.g., during /forge-tool rebuild).
// Surfaces overlap relationships that may be affected by the description change.

function checkDescriptionChangeImpact(
  changedTool: string,
  overlapMap: OverlapMap
): string[] {
  const suggestions: string[] = [];

  const entry = overlapMap.tools.find(e => e.tool === changedTool);
  if (!entry) return suggestions;

  if (entry.overlaps.length > 0) {
    const overlapNames = entry.overlaps.map(o => o.tool).join(', ');
    suggestions.push(
      `Tool '${changedTool}' has declared overlaps with: [${overlapNames}]. ` +
      `Description change may affect routing ambiguity. Review each overlap ` +
      `and consider:`
    );
    for (const overlap of entry.overlaps) {
      suggestions.push(
        `  - ${changedTool} ↔ ${overlap.tool} (${overlap.reason}): ` +
        `Still overlapping? Remove from overlap map if disambiguation is now clear.`
      );
    }
  }

  return suggestions;
}

// ── Full Validation Run ─────────────────────────────────────────────────────

function validate(
  overlapMapPath: string,
  evalDir: string,
  registeredTools: string[]
): ValidationReport {
  const overlapMap = loadJSON(overlapMapPath) as OverlapMap;
  const goldenEvals = loadAllGoldenEvals(evalDir);
  const labeledEvals = loadAllLabeledEvals(evalDir);

  const symmetryErrors = validateSymmetry(overlapMap);
  const coverageGaps = findCoverageGaps(overlapMap, goldenEvals, labeledEvals, registeredTools);

  // Stale eval detection runs only when a new tool name is provided
  const staleEvals: StaleEvalWarning[] = [];

  const summary = [
    `Symmetry: ${symmetryErrors.length === 0 ? '✓ all pairs symmetric' : `✗ ${symmetryErrors.length} asymmetric pairs`}`,
    `Coverage: ${coverageGaps.length === 0 ? '✓ no gaps' : `✗ ${coverageGaps.length} gaps found`}`,
    `  - Tools without golden evals: ${coverageGaps.filter(g => g.type === 'no_golden').length}`,
    `  - Tools without labeled evals: ${coverageGaps.filter(g => g.type === 'no_labeled').length}`,
    `  - Overlaps without ambiguous coverage: ${coverageGaps.filter(g => g.type === 'overlap_no_ambiguous').length}`,
    `  - Clusters without full coverage: ${coverageGaps.filter(g => g.type === 'cluster_no_multi').length}`,
  ].join('\n');

  return { symmetryErrors, coverageGaps, staleEvals, summary };
}

// ── Utility Stubs ───────────────────────────────────────────────────────────
// EXTENSION POINT: Replace with real implementations.

function loadJSON(path: string): unknown { /* ... */ }
function loadAllGoldenEvals(dir: string): Map<string, any> { /* ... */ }
function loadAllLabeledEvals(dir: string): Map<string, LabeledEvalFile> { /* ... */ }
