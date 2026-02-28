import { getDb } from '../../cli/db.js';

/**
 * Create an in-memory SQLite database for testing.
 * @returns {import('better-sqlite3').Database}
 */
export const makeTestDb = () => getDb(':memory:');
