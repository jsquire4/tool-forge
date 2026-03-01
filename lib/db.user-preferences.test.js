import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { getUserPreferences, upsertUserPreferences } from './db.js';

describe('user_preferences', () => {
  let db;
  beforeEach(() => { db = makeTestDb(); });

  it('upsert creates a new preference row', () => {
    upsertUserPreferences(db, 'user-1', { model: 'gpt-4o', hitlLevel: 'cautious' });
    const prefs = getUserPreferences(db, 'user-1');
    expect(prefs).not.toBeNull();
    expect(prefs.model).toBe('gpt-4o');
    expect(prefs.hitl_level).toBe('cautious');
    expect(prefs.updated_at).toBeTruthy();
  });

  it('upsert updates an existing preference row', () => {
    upsertUserPreferences(db, 'user-1', { model: 'gpt-4o', hitlLevel: 'cautious' });
    upsertUserPreferences(db, 'user-1', { model: 'claude-sonnet-4-6', hitlLevel: 'standard' });

    const prefs = getUserPreferences(db, 'user-1');
    expect(prefs.model).toBe('claude-sonnet-4-6');
    expect(prefs.hitl_level).toBe('standard');
  });

  it('get returns null for unknown user', () => {
    const prefs = getUserPreferences(db, 'nonexistent');
    expect(prefs).toBeNull();
  });

  it('rejects invalid hitlLevel via CHECK constraint', () => {
    expect(() => {
      upsertUserPreferences(db, 'user-1', { hitlLevel: 'invalid' });
    }).toThrow();
  });

  it('allows null model and hitlLevel', () => {
    upsertUserPreferences(db, 'user-1', {});
    const prefs = getUserPreferences(db, 'user-1');
    expect(prefs.model).toBeNull();
    expect(prefs.hitl_level).toBeNull();
  });
});
