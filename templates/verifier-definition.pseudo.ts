// ============================================================================
// Verifier — Response verification interface
// PSEUDO-CODE: Conceptual contract. Adapt to your stack.
//
// Verifiers run after the agent responds. They check the response and tool
// call history for quality, safety, and compliance.
// ============================================================================

// ── Types ───────────────────────────────────────────────────────────────────

interface ToolCallRecord {
  toolName: string;
  params: unknown;
  result: string;      // JSON.stringify(ToolResult)
  calledAt: string;
  durationMs: number;
  success: boolean;
}

interface VerificationResult {
  pass: boolean;       // false when flags.length > 0
  warnings: string[];  // informational, never block
  flags: string[];    // hard failures, short-circuit pipeline
}

interface Verifier {
  name: string;        // identifier
  order: string;       // lexicographic execution order (e.g. "A-0001")
  verify: (
    response: string,
    toolCalls: ToolCallRecord[],
    channel?: string
  ) => Promise<VerificationResult>;
}

// ── Order Categories ────────────────────────────────────────────────────────
//
// A-xxxx  Attribution   — source citation, data provenance
// C-xxxx  Compliance    — regulatory checks, policy
// I-xxxx  Interface     — format validation, length limits
// R-xxxx  Risk          — concentration, exposure
// U-xxxx  Uncertainty   — confidence scoring
//
// Pipeline: verifiers run in order; flags short-circuit (later verifiers skipped).
