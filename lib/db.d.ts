// Database handle — better-sqlite3 synchronous API.
// Typed as `object` to avoid requiring @types/better-sqlite3 as a peer dep.
export type Db = object;

/** Open (or create) the SQLite database at `path` and run the full schema migration. */
export function getDb(path: string): Db;
