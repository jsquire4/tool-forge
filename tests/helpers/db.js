import { getDb } from '../../cli/db.js';

export const makeTestDb = () => getDb(':memory:');
