import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { PreferenceStore, makePreferenceStore } from './preference-store.js';

describe('PreferenceStore', () => {
  let db, store;
  beforeEach(() => {
    db = makeTestDb();
    store = makePreferenceStore({}, db);
  });

  it('set + get round-trip', () => {
    store.setUserPreferences('user-1', { model: 'gpt-4o', hitlLevel: 'cautious' });
    const prefs = store.getUserPreferences('user-1');
    expect(prefs).toEqual({ model: 'gpt-4o', hitlLevel: 'cautious' });
  });

  it('get returns null for unknown user', () => {
    expect(store.getUserPreferences('nonexistent')).toBeNull();
  });

  it('resolveEffective uses user pref when config allows', () => {
    store.setUserPreferences('user-1', { model: 'gpt-4o', hitlLevel: 'paranoid' });

    const config = {
      allowUserModelSelect: true,
      allowUserHitlConfig: true,
      defaultModel: 'claude-sonnet-4-6',
      defaultHitlLevel: 'cautious'
    };
    const env = { OPENAI_API_KEY: 'sk-test' };

    const eff = store.resolveEffective('user-1', config, env);
    expect(eff.model).toBe('gpt-4o');
    expect(eff.hitlLevel).toBe('paranoid');
    expect(eff.provider).toBe('openai');
    expect(eff.apiKey).toBe('sk-test');
  });

  it('resolveEffective ignores user pref when config disallows', () => {
    store.setUserPreferences('user-1', { model: 'gpt-4o', hitlLevel: 'paranoid' });

    const config = {
      allowUserModelSelect: false,
      allowUserHitlConfig: false,
      defaultModel: 'claude-sonnet-4-6',
      defaultHitlLevel: 'cautious'
    };

    const eff = store.resolveEffective('user-1', config, { ANTHROPIC_API_KEY: 'ak-test' });
    expect(eff.model).toBe('claude-sonnet-4-6');
    expect(eff.hitlLevel).toBe('cautious');
    expect(eff.provider).toBe('anthropic');
  });

  it('resolveEffective falls back to config default when no user pref', () => {
    const config = {
      allowUserModelSelect: true,
      allowUserHitlConfig: true,
      defaultModel: 'claude-sonnet-4-6',
      defaultHitlLevel: 'standard'
    };

    const eff = store.resolveEffective('new-user', config, {});
    expect(eff.model).toBe('claude-sonnet-4-6');
    expect(eff.hitlLevel).toBe('standard');
  });

  it('rejects invalid hitlLevel', () => {
    expect(() => {
      store.setUserPreferences('user-1', { hitlLevel: 'yolo' });
    }).toThrow(/Invalid hitlLevel/);
  });
});
