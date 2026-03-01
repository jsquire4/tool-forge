export interface PromptVersion {
  id: number;
  version: string;
  content: string;
  is_active: number;
  created_at: string;
  activated_at: string | null;
  notes: string | null;
}

/**
 * Versioned system prompt management.
 * The TUI writes prompt versions; the sidecar reads the active one per request.
 * Hot-swap: activating a new version takes effect on the next chat request.
 */
export class PromptStore {
  constructor(db: object);

  /** Get the active prompt content, or `''` if none is active. */
  getActivePrompt(): string;

  /** Get all versions ordered by most recent first. */
  getAllVersions(): PromptVersion[];

  /**
   * Create a new prompt version (inactive by default).
   * @returns The new version's id.
   */
  createVersion(version: string, content: string, notes?: string | null): number;

  /** Activate a prompt version by id (deactivates all others). */
  activate(id: number): void;

  /** Get a specific version by id, or `null` if not found. */
  getVersion(id: number): PromptVersion | null;
}

/**
 * Factory — creates a PromptStore backed by SQLite.
 * For Postgres, use `buildSidecarContext`, which selects the adapter automatically.
 */
export function makePromptStore(config: object, db: object): PromptStore;
