/**
 * Postgres-backed storage adapters for horizontal scaling (0.4.x).
 *
 * This module exports seven classes that mirror the SQLite-backed store
 * interfaces from db.js, prompt-store.js, preference-store.js,
 * agent-registry.js, and the eval/audit/verifier sub-systems.  All classes
 * accept an existing `pg.Pool` (or create one internally) so they can share
 * a single connection pool in sidecar deployments.
 *
 * Requires: `npm install pg`
 * Optional — only loaded when `database.type === 'postgres'` (or
 * `conversation.store === 'postgres'`) in forge config.
 */

// ── PostgresStore ─────────────────────────────────────────────────────────

/**
 * Base store that owns the pg.Pool lifecycle and hosts the tool-registry
 * methods.  Call `connect()` before using any other method.
 */
export class PostgresStore {
  constructor(pgConfig: { connectionString: string });

  /**
   * Connect to Postgres, run schema migrations, and return `this`.
   * Must be called before any other method.
   */
  connect(): Promise<this>;

  /** Drain and close the connection pool. */
  close(): Promise<void>;

  // ── Tool registry ────────────────────────────────────────────────────────

  /** Return all tool_registry rows where lifecycle_state = 'promoted'. */
  getPromotedTools(): Promise<object[]>;

  /** Insert or update a tool_registry row. */
  upsertToolRegistry(row: object): Promise<void>;

  /** Return the tool_registry row for `toolName`, or null if not found. */
  getToolRegistry(toolName: string): Promise<object | null>;

  /** Return all tool_registry rows. */
  getAllToolRegistry(): Promise<object[]>;

  /**
   * Apply lifecycle column updates (lifecycle_state, promoted_at,
   * flagged_at, retired_at, replaced_by, baseline_pass_rate) to a single
   * tool row.  Unknown keys in `updates` are silently ignored.
   */
  updateToolLifecycle(toolName: string, updates: Record<string, unknown>): Promise<void>;
}

// ── PostgresPromptStore ────────────────────────────────────────────────────

/**
 * Postgres-backed PromptStore — same interface as PromptStore in
 * prompt-store.js.  Accepts an existing pg.Pool created by
 * buildSidecarContext.
 */
export class PostgresPromptStore {
  constructor(pool: object);

  /** Return the content of the currently active prompt, or '' if none. */
  getActivePrompt(): Promise<string>;

  /** Return all prompt_versions rows ordered by id DESC. */
  getAllVersions(): Promise<object[]>;

  /** Return a single prompt_versions row by id, or null if not found. */
  getVersion(id: number): Promise<object | null>;

  /**
   * Insert a new prompt version (inactive) and return its generated id,
   * or null on failure.
   */
  createVersion(version: string, content: string, notes?: string | null): Promise<number | null>;

  /**
   * Deactivate all other versions and activate the row with the given id.
   * Runs inside a transaction.
   */
  activate(id: number | string): Promise<void>;
}

// ── PostgresPreferenceStore ────────────────────────────────────────────────

/**
 * Postgres-backed PreferenceStore — same interface as PreferenceStore in
 * preference-store.js.
 */
export class PostgresPreferenceStore {
  constructor(pool: object, config?: object, env?: Record<string, string>);

  /**
   * Return the stored preferences for a user as `{ model, hitlLevel }`,
   * or null if the user has no row.
   */
  getUserPreferences(userId: string): Promise<object | null>;

  /** Insert or update the user_preferences row for `userId`. */
  setUserPreferences(userId: string, prefs: object): Promise<void>;

  /**
   * Resolve the effective runtime settings (model, hitlLevel, provider,
   * apiKey) for a user, merging config defaults with any stored preferences.
   */
  resolveEffective(userId: string, config: object, env: object): Promise<object>;
}

// ── PostgresAgentRegistry ──────────────────────────────────────────────────

/**
 * Postgres-backed AgentRegistry — same interface as AgentRegistry in
 * agent-registry.js.
 */
export class PostgresAgentRegistry {
  constructor(config: object, pool: object);

  /**
   * Return the default agent when `agentId` is null/undefined, or look up
   * by id.  Returns null when the agent is disabled or not found.
   */
  resolveAgent(agentId: string | null): Promise<object | null>;

  /** Return the agent_registry row for `agentId`, or null. */
  getAgent(agentId: string): Promise<object | null>;

  /** Return all agent_registry rows ordered by display_name. */
  getAllAgents(): Promise<object[]>;

  /** Insert or update an agent_registry row. */
  upsertAgent(agent: object): Promise<void>;

  /** Delete the agent_registry row for `agentId`. */
  deleteAgent(agentId: string): Promise<void>;

  /**
   * Clear is_default on all agents and set it on `agentId`.
   * No-ops (with implicit rollback) if the target agent is disabled.
   * Runs inside a transaction.
   */
  setDefault(agentId: string): Promise<void>;

  /**
   * Merge agent-level overrides (model, hitlLevel, tool policy, turn/token
   * limits) on top of the base forge config and return the merged object.
   */
  buildAgentConfig(config: object, agent: object | null): object;

  /**
   * Resolve the system prompt for a request: agent.system_prompt >
   * promptStore active prompt > config.systemPrompt > fallback string.
   */
  resolveSystemPrompt(agent: object | null, promptStore: object, config: object): Promise<string>;

  /**
   * Upsert all agents declared in `config.agents` that are either new or
   * were previously seeded from config.  Sets the default agent when
   * `isDefault` is provided.
   */
  seedFromConfig(): Promise<void>;
}

// ── PostgresEvalStore ──────────────────────────────────────────────────────

/** Postgres-backed store for eval run results and per-case records. */
export class PostgresEvalStore {
  constructor(pool: object);

  /** Insert an eval_runs header row and return its generated id, or null. */
  insertEvalRun(row: object): Promise<number | null>;

  /**
   * Bulk-insert eval_run_cases rows inside a single transaction.
   * No-ops when `rows` is empty.
   */
  insertEvalRunCases(rows: object[]): Promise<void>;

  /**
   * Return an aggregated summary (last_run, total_cases, passed, failed,
   * pass_rate) grouped by tool_name.
   */
  getEvalSummary(): Promise<object[]>;

  /**
   * Return the most recent `windowSize` eval_runs rows for a single tool,
   * ordered newest-first.
   */
  getPerToolRunHistory(toolName: string, windowSize?: number): Promise<object[]>;

  /**
   * Return a paginated list of eval_runs rows ordered by run_at DESC.
   */
  listRuns(limit?: number, offset?: number): Promise<object[]>;
}

// ── PostgresChatAuditStore ─────────────────────────────────────────────────

/** Postgres-backed store for per-request chat audit records. */
export class PostgresChatAuditStore {
  constructor(pool: object);

  /**
   * Insert a chat_audit row and return its generated id, or null on
   * failure.
   */
  insertChatAudit(row: object): Promise<number | null>;

  /**
   * Return aggregate statistics across all chat_audit rows:
   * total sessions, average duration, error rate, and messages in the
   * last 24 hours.
   */
  getStats(): Promise<{
    totalSessions: number;
    avgDurationMs: number;
    errorRate: number;
    messagesToday: number;
  }>;

  /** Return a paginated list of chat_audit rows ordered by created_at DESC. */
  getSessions(limit?: number, offset?: number): Promise<object[]>;
}

// ── PostgresVerifierStore ──────────────────────────────────────────────────

/**
 * Postgres-backed store for verifier registry entries, tool bindings, and
 * per-invocation results.
 */
export class PostgresVerifierStore {
  constructor(pool: object);

  /** Insert or update a verifier_registry row. */
  upsertVerifier(row: object): Promise<void>;

  /** Return the verifier_registry row for `name`, or null. */
  getVerifier(name: string): Promise<object | null>;

  /** Return all enabled verifier_registry rows ordered by aciru_order. */
  getAllVerifiers(): Promise<object[]>;

  /**
   * Delete a verifier and all of its tool bindings inside a transaction.
   */
  deleteVerifier(name: string): Promise<void>;

  /** Insert or update a verifier_tool_bindings row. */
  upsertVerifierBinding(binding: object): Promise<void>;

  /** Delete the binding between a verifier and a specific tool. */
  removeVerifierBinding(verifierName: string, toolName: string): Promise<void>;

  /**
   * Return all enabled verifier_registry rows that are bound to
   * `toolName`, ordered by aciru_order.
   */
  getVerifiersForTool(toolName: string): Promise<object[]>;

  /** Return all verifier_tool_bindings rows for a given verifier. */
  getBindingsForVerifier(verifierName: string): Promise<object[]>;

  /**
   * Insert a verifier_results row and return its generated id, or null on
   * failure.
   */
  insertVerifierResult(row: object): Promise<number | null>;

  /**
   * Return verifier_results rows ordered by created_at DESC.  When
   * `toolName` is provided, results are filtered to that tool.
   */
  getResults(toolName?: string | null, limit?: number): Promise<object[]>;
}
