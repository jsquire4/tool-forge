// ============================================================================
// ToolDefinition — The universal shape for an LLM agent tool.
// PSEUDO-CODE: Conceptual contract. Adapt to your stack.
//
// This describes the contract, not a runnable implementation.
// Adapt the types and validation to your stack (TypeScript/Zod, Python/Pydantic,
// Go/struct tags, etc.). The LLM using the /forge-tool skill will generate
// real code from this shape.
// ============================================================================

// ── Types ───────────────────────────────────────────────────────────────────

type ToolCategory = 'read' | 'write' | 'analysis';
type ConsequenceLevel = 'high' | 'medium' | 'low';

// EXTENSION POINT: Replace with your auth type (JWT wrapper, API key, OAuth token, etc.)
interface AuthCredentials {
  // Example: { mode: 'user', jwt: string } | { mode: 'service', apiKey: string }
}

// EXTENSION POINT: Replace with your API client interface
interface ApiClient {
  get<T>(path: string, auth: AuthCredentials): Promise<T>;
  post<T>(path: string, body: unknown, auth: AuthCredentials): Promise<T>;
  // Add delete, put, patch as needed
}

// The context every tool receives at execution time.
// EXTENSION POINT: Add services your tools need (database, cache, external APIs).
interface ToolContext {
  userId: string;
  abortSignal: AbortSignal;
  auth: AuthCredentials;
  client: ApiClient;
  // autoApproveTools?: Set<string>;  // Optional: for HITL permission matrices
}

// ── ToolDefinition ──────────────────────────────────────────────────────────

interface ToolDefinition {
  // ── Identity ──
  name: string;
  // snake_case, verb-noun format preferred: get_holdings, calculate_tax, check_wash_sale

  description: string;
  // THE ROUTING CONTRACT. This is what the LLM reads in the system prompt to
  // decide when to call this tool. It must be unambiguous relative to every
  // other tool in the registry.
  //
  // Format: "<What it does>. Use when <trigger condition>. <Disambiguation if needed>."
  //
  // Good: "Fetches dividend payment history with dates and amounts. Use when the
  //        user asks about dividends, income, or yield. For overall portfolio
  //        performance, use portfolio_summary instead."
  //
  // Bad:  "Gets portfolio data" — too vague, overlaps with everything

  // ── Classification ──
  category: ToolCategory;
  // read    — retrieves data, no mutations
  // write   — performs mutations (creates, updates, deletes)
  // analysis — computes derived insights from data

  consequenceLevel: ConsequenceLevel;
  // low    — no real-world impact (read-only, summaries)
  // medium — moderate impact (analysis that influences decisions)
  // high   — significant impact (trades, account changes, deletions)

  requiresConfirmation: boolean;
  // Should the agent pause and wait for user approval before executing?
  // Independent of category — collect separately. A read tool could require
  // confirmation (expensive API call), a write tool might not (safe idempotent op).

  timeout: number;
  // Milliseconds. Default: 15000. Increase for slow external APIs.

  // ── Lifecycle ──
  version: string;
  // REQUIRED. Semantic version (e.g., "1.0.0"). Increment on any change to
  // description, schema, or behavior. Eval metadata records this version so
  // stale evals are detectable. Bump rules:
  //   - Description wording change → minor (1.0.0 → 1.1.0)
  //   - Schema field added/removed → major (1.0.0 → 2.0.0)
  //   - Bug fix in execute()    → patch (1.0.0 → 1.0.1)

  status: 'active' | 'deprecated' | 'removed';
  // active     — available in the tool registry and system prompt
  // deprecated — still in registry (existing evals can run) but hidden from
  //              the AVAILABLE TOOLS list in the system prompt. No new routing.
  // removed    — excluded from everything. Kept in source for history.
  //
  // Lifecycle: active → deprecated → removed
  // The system prompt builder should filter: only status === 'active' tools
  // appear in AVAILABLE TOOLS. The eval runner should warn when running evals
  // against deprecated or removed tools.

  // ── Optional metadata ──
  tags?: string[];
  // Domain tags for filtering/grouping: ['portfolio', 'risk', 'compliance']

  dependsOn?: string[];
  // Names of other tools this tool calls internally

  // ── Schema ──
  schema: SCHEMA;
  // EXTENSION POINT: Your validation library's schema type.
  //
  // TypeScript + Zod:     z.ZodTypeAny
  // Python + Pydantic:    type[BaseModel]
  // Go:                   struct with validate tags
  // JSON Schema:          object
  //
  // The schema serves THREE purposes:
  //   1. Runtime validation of LLM-generated parameters
  //   2. JSON Schema generation for the LLM's tool definition
  //   3. Type hints for your IDE

  // ── Execute ──
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
  // The function that does the work. Receives validated params and the context.
  //
  // Rules:
  //   - MUST check context.abortSignal?.aborted before any I/O
  //   - MUST never throw (return error in ToolResult instead)
  //   - Exception: re-throw HITL interrupts if your framework uses them
  //   - Return ToolResult shape (see tool-result.pseudo.ts)
}
