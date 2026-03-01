import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { PromptStore, makePromptStore } from './prompt-store.js';

describe('PromptStore', () => {
  let db, store;
  beforeEach(() => {
    db = makeTestDb();
    store = makePromptStore({}, db);
  });

  it('create + activate + getActivePrompt round-trip', () => {
    const id = store.createVersion('1.0', 'You are a helpful assistant.', 'Initial');
    expect(id).toBeGreaterThan(0);
    expect(store.getActivePrompt()).toBe('');

    store.activate(id);
    expect(store.getActivePrompt()).toBe('You are a helpful assistant.');
  });

  it('getActivePrompt returns empty string when none active', () => {
    expect(store.getActivePrompt()).toBe('');
  });

  it('activate deactivates previous (transaction atomicity)', () => {
    const id1 = store.createVersion('1.0', 'V1');
    const id2 = store.createVersion('2.0', 'V2');

    store.activate(id1);
    expect(store.getActivePrompt()).toBe('V1');

    store.activate(id2);
    expect(store.getActivePrompt()).toBe('V2');

    // Only one should be active
    const active = db.prepare('SELECT COUNT(*) as count FROM prompt_versions WHERE is_active = 1').get();
    expect(active.count).toBe(1);
  });

  it('getAllVersions returns all versions', () => {
    store.createVersion('1.0', 'V1');
    store.createVersion('2.0', 'V2');
    const versions = store.getAllVersions();
    expect(versions).toHaveLength(2);
  });

  it('getVersion returns specific version or null', () => {
    const id = store.createVersion('1.0', 'Content');
    expect(store.getVersion(id)).toBeTruthy();
    expect(store.getVersion(99999)).toBeNull();
  });
});
