// ============================================================================
// ToolResult — The universal return shape from a tool execution.
// PSEUDO-CODE: Conceptual contract. Adapt to your stack.
//
// Every tool's execute() function returns this shape. It is the contract
// between the tool layer and the agent loop. The agent reads `error` to
// decide if the call succeeded and `data` to build the response.
// ============================================================================

interface ToolResult {
  tool: string;
  // The snake_case name of the tool that produced this result.
  // Must match the ToolDefinition.name exactly.

  fetchedAt: string;
  // ISO 8601 timestamp of when the result was produced.
  // Example: "2025-01-15T10:30:00.000Z"

  data?: unknown;
  // The successful result payload. Shape is tool-specific.
  // Present when the tool succeeds. Absent on error.

  error?: string;
  // Human-readable error message. Present when the tool fails.
  // Absent on success. The agent uses this to explain failures to the user.
  //
  // Examples:
  //   "Connection refused"
  //   "Request was cancelled"
  //   "Invalid symbol: XYZ123"
}

// ── Key Constraints ─────────────────────────────────────────────────────────
//
// 1. NO `success` boolean. The presence of `error` is the failure signal.
//    `data` present + `error` absent = success.
//    `error` present + `data` absent = failure.
//
// 2. NO `timestamp` field. The field is called `fetchedAt`.
//
// 3. `execute()` MUST never throw. Catch all errors and return them in the
//    `error` field. The one exception: re-throw HITL framework interrupts
//    (e.g., LangGraph's isGraphInterrupt) so the framework can handle them.
//
// 4. `fetchedAt` is always set, even on error. It marks when the attempt
//    was made, which is useful for debugging and staleness detection.
