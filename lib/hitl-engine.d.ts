export type HitlLevel = 'autonomous' | 'cautious' | 'standard' | 'paranoid';

export interface HitlToolSpec {
  name?: string;
  /** HTTP method used by the tool — drives 'standard' level pause logic. */
  method?: string;
  /** When true, 'cautious' level will pause for this tool. */
  requiresConfirmation?: boolean;
}

export interface HitlEngineOptions {
  /** better-sqlite3 Database instance — SQLite backend. */
  db?: object;
  /** ioredis / node-redis compatible client — Redis backend (recommended for multi-instance). */
  redis?: object;
  /** node-postgres Pool instance — Postgres backend. */
  pgPool?: object;
  /** Pause state TTL in milliseconds. Default: 300000 (5 minutes). */
  ttlMs?: number;
}

export class HitlEngine {
  constructor(opts?: HitlEngineOptions);

  /**
   * Determine whether a tool call should pause for user confirmation.
   * @param hitlLevel — user's HITL sensitivity level
   * @param toolSpec — tool metadata (method, requiresConfirmation)
   */
  shouldPause(hitlLevel: HitlLevel, toolSpec?: HitlToolSpec): boolean;

  /**
   * Store paused conversation state and return a one-time resume token.
   * The token expires after `ttlMs` milliseconds.
   */
  pause(state: unknown): Promise<string>;

  /**
   * Retrieve and consume the paused state for a resume token.
   * Throws if the token has expired or does not exist.
   */
  resume(resumeToken: string): Promise<unknown>;
}

/**
 * Factory — creates a HitlEngine from forge config.
 * Automatically selects Redis > Postgres > SQLite > in-memory based on which
 * clients are provided.
 *
 * @param config — merged forge config (reads `config.hitl.ttlMs` if set)
 * @param db — better-sqlite3 Database instance (SQLite fallback)
 * @param redis — optional Redis client
 * @param pgPool — optional Postgres Pool
 */
export function makeHitlEngine(
  config: object,
  db: object,
  redis?: object | null,
  pgPool?: object | null
): HitlEngine;
