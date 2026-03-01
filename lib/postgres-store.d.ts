/**
 * Postgres-backed storage adapter for horizontal scaling.
 *
 * Mirrors the SQLite query function signatures from `db.js` but uses a `pg` Pool.
 * Only loaded when `conversation.store === 'postgres'` (or `database.type === 'postgres'`) in config.
 *
 * Requires: `npm install pg`
 */
export class PostgresStore {
  constructor(pgConfig: { connectionString: string });

  /**
   * Connect to Postgres and run schema migrations.
   * Must be called before any other method.
   */
  connect(): Promise<this>;

  /** Close the connection pool. */
  close(): Promise<void>;

  // ── Prompt versions ───────────────────────────────────────────────────────

  getActivePrompt(): Promise<object | null>;
  insertPromptVersion(row: { version: string; content: string; notes?: string | null }): Promise<number | null>;
  activatePromptVersion(id: number): Promise<void>;

  // ── User preferences ──────────────────────────────────────────────────────

  getUserPreferences(userId: string): Promise<{ model: string | null; hitl_level: string | null } | null>;
  upsertUserPreferences(userId: string, prefs: { model?: string; hitlLevel?: string }): Promise<void>;
}
