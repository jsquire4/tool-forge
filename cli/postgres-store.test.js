import { describe, it, expect } from 'vitest';
import { PostgresStore } from './postgres-store.js';

describe('PostgresStore', () => {
  it('exposes expected methods', () => {
    const store = new PostgresStore({ connectionString: 'postgres://localhost/test' });
    expect(typeof store.connect).toBe('function');
    expect(typeof store.close).toBe('function');
    expect(typeof store.getActivePrompt).toBe('function');
    expect(typeof store.insertPromptVersion).toBe('function');
    expect(typeof store.activatePromptVersion).toBe('function');
    expect(typeof store.getUserPreferences).toBe('function');
    expect(typeof store.upsertUserPreferences).toBe('function');
    expect(typeof store.getPromotedTools).toBe('function');
    expect(typeof store.insertVerifierResult).toBe('function');
  });

  it('connect throws without pg package (expected in test env)', async () => {
    const store = new PostgresStore({ connectionString: 'postgres://localhost/test' });
    // pg is not installed in test env — should throw a descriptive error
    // OR if pg IS installed, it will fail to connect (also expected)
    await expect(store.connect()).rejects.toThrow();
  });
});
