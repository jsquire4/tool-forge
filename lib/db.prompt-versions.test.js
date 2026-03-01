import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import {
  insertPromptVersion,
  activatePromptVersion,
  getActivePrompt,
  getAllPromptVersions
} from './db.js';

describe('prompt_versions', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  it('insert + activate + getActivePrompt round-trip', () => {
    const id = insertPromptVersion(db, { version: '1.0', content: 'You are a helpful assistant.' });
    expect(id).toBeGreaterThan(0);
    expect(getActivePrompt(db)).toBeNull();

    activatePromptVersion(db, id);
    const active = getActivePrompt(db);
    expect(active).not.toBeNull();
    expect(active.version).toBe('1.0');
    expect(active.content).toBe('You are a helpful assistant.');
    expect(active.is_active).toBe(1);
    expect(active.activated_at).toBeTruthy();
  });

  it('activate deactivates the previous active version', () => {
    const id1 = insertPromptVersion(db, { version: '1.0', content: 'Prompt v1' });
    const id2 = insertPromptVersion(db, { version: '2.0', content: 'Prompt v2' });

    activatePromptVersion(db, id1);
    expect(getActivePrompt(db).version).toBe('1.0');

    activatePromptVersion(db, id2);
    const active = getActivePrompt(db);
    expect(active.version).toBe('2.0');

    // Verify only one is active
    const allActive = db.prepare('SELECT * FROM prompt_versions WHERE is_active = 1').all();
    expect(allActive).toHaveLength(1);
  });

  it('getAllPromptVersions returns rows ordered by created_at DESC', () => {
    insertPromptVersion(db, { version: '1.0', content: 'First' });
    insertPromptVersion(db, { version: '2.0', content: 'Second' });
    insertPromptVersion(db, { version: '3.0', content: 'Third' });

    const all = getAllPromptVersions(db);
    expect(all).toHaveLength(3);
    expect(all[0].version).toBe('3.0');
    expect(all[2].version).toBe('1.0');
  });

  it('insertPromptVersion stores notes', () => {
    const id = insertPromptVersion(db, { version: '1.0', content: 'Test', notes: 'Initial version' });
    const all = getAllPromptVersions(db);
    expect(all[0].notes).toBe('Initial version');
  });
});
