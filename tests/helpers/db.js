import { getDb } from '../../lib/db.js';

export const makeTestDb = () => getDb(':memory:');
