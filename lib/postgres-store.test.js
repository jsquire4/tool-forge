import { describe, it, expect } from 'vitest';
import { PostgresStore, PostgresPromptStore, PostgresPreferenceStore, PostgresAgentRegistry } from './postgres-store.js';

/** Minimal pg.Pool mock backed by in-memory Maps */
function createPoolMock() {
  const promptVersions = [];
  const userPrefs = new Map();
  const agents = new Map();
  let nextId = 1;

  return {
    async query(sql, params = []) {
      // prompt_versions
      if (sql.includes('FROM prompt_versions') && sql.includes('is_active = 1')) {
        const row = promptVersions.find(r => r.is_active === 1);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO prompt_versions')) {
        const id = nextId++;
        promptVersions.push({ id, version: params[0], content: params[1], is_active: 0, created_at: params[2], notes: params[3] });
        return { rows: [{ id }] };
      }
      if (sql.includes('UPDATE prompt_versions SET is_active = 0')) {
        promptVersions.forEach(r => { r.is_active = 0; r.activated_at = null; });
        return { rows: [] };
      }
      if (sql.includes('UPDATE prompt_versions SET is_active = 1')) {
        const id = params[1];
        const row = promptVersions.find(r => r.id === id);
        if (row) { row.is_active = 1; row.activated_at = params[0]; }
        return { rows: [] };
      }
      if (sql.includes('FROM prompt_versions WHERE id =')) {
        const row = promptVersions.find(r => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM prompt_versions ORDER')) {
        return { rows: [...promptVersions].reverse() };
      }

      // user_preferences
      if (sql.includes('FROM user_preferences WHERE user_id =')) {
        const row = userPrefs.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('INSERT INTO user_preferences')) {
        userPrefs.set(params[0], { user_id: params[0], model: params[1], hitl_level: params[2], updated_at: params[3] });
        return { rows: [] };
      }

      // agent_registry — DELETE and targeted checks must come before generic SELECT
      if (sql.startsWith('DELETE FROM agent_registry')) {
        agents.delete(params[0]);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO agent_registry')) {
        const row = { agent_id: params[0], display_name: params[1], is_default: params[11], enabled: params[12] };
        agents.set(params[0], row);
        return { rows: [] };
      }
      if (sql.includes('UPDATE agent_registry SET is_default = 0')) {
        for (const r of agents.values()) r.is_default = 0;
        return { rows: [] };
      }
      if (sql.includes('UPDATE agent_registry SET is_default = 1')) {
        const row = agents.get(params[1]);
        if (row) { row.is_default = 1; }
        return { rows: [] };
      }
      if (sql.includes('SELECT 1 FROM agent_registry WHERE agent_id =')) {
        const row = agents.get(params[0]);
        return { rows: (row && row.enabled) ? [{ 1: 1 }] : [] };
      }
      if (sql.includes('FROM agent_registry WHERE is_default = 1')) {
        const row = [...agents.values()].find(r => r.is_default === 1 && r.enabled === 1);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM agent_registry WHERE agent_id =')) {
        const row = agents.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM agent_registry ORDER BY display_name')) {
        return { rows: [...agents.values()].sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? '')) };
      }

      return { rows: [] };
    },
    async connect() {
      const self = this;
      return {
        async query(sql, params) { return self.query(sql, params); },
        release() {}
      };
    }
  };
}

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

describe('PostgresPromptStore', () => {
  it('round-trips prompt versions', async () => {
    const pool = createPoolMock();
    const store = new PostgresPromptStore(pool);

    expect(await store.getActivePrompt()).toBe('');

    const id = await store.createVersion('v1', 'System prompt v1', 'note');
    expect(typeof id).toBe('number');

    await store.activate(id);
    expect(await store.getActivePrompt()).toBe('System prompt v1');

    const versions = await store.getAllVersions();
    expect(versions.length).toBe(1);
    expect(versions[0].version).toBe('v1');

    const single = await store.getVersion(id);
    expect(single.content).toBe('System prompt v1');
  });
});

describe('PostgresPreferenceStore', () => {
  it('round-trips user preferences', async () => {
    const pool = createPoolMock();
    const config = { allowUserModelSelect: true, allowUserHitlConfig: true, defaultModel: 'claude-sonnet-4-6', defaultHitlLevel: 'cautious' };
    const store = new PostgresPreferenceStore(pool, config);

    expect(await store.getUserPreferences('u1')).toBeNull();

    await store.setUserPreferences('u1', { model: 'gpt-4o', hitlLevel: 'paranoid' });

    const prefs = await store.getUserPreferences('u1');
    expect(prefs).toEqual({ model: 'gpt-4o', hitlLevel: 'paranoid' });
  });

  it('setUserPreferences rejects invalid hitlLevel', async () => {
    const pool = createPoolMock();
    const store = new PostgresPreferenceStore(pool, {});
    await expect(store.setUserPreferences('u1', { hitlLevel: 'invalid' })).rejects.toThrow(/Invalid hitlLevel/);
  });
});

describe('PostgresAgentRegistry', () => {
  it('upserts and resolves agents', async () => {
    const pool = createPoolMock();
    const config = { agents: [] };
    const registry = new PostgresAgentRegistry(config, pool);

    await registry.upsertAgent({
      agent_id: 'support',
      display_name: 'Support Agent',
      is_default: 0, enabled: 1
    });

    const agent = await registry.getAgent('support');
    expect(agent.agent_id).toBe('support');

    const all = await registry.getAllAgents();
    expect(all.length).toBe(1);
  });

  it('resolves default agent', async () => {
    const pool = createPoolMock();
    const registry = new PostgresAgentRegistry({ agents: [] }, pool);

    await registry.upsertAgent({ agent_id: 'a1', display_name: 'A1', is_default: 0, enabled: 1 });
    await registry.setDefault('a1');

    const def = await registry.resolveAgent(null);
    expect(def?.agent_id).toBe('a1');
  });

  it('resolveAgent returns null for unknown id', async () => {
    const pool = createPoolMock();
    const registry = new PostgresAgentRegistry({ agents: [] }, pool);
    expect(await registry.resolveAgent('nonexistent')).toBeNull();
  });

  it('deleteAgent removes agent', async () => {
    const pool = createPoolMock();
    const registry = new PostgresAgentRegistry({ agents: [] }, pool);
    await registry.upsertAgent({ agent_id: 'del', display_name: 'Del', is_default: 0, enabled: 1 });
    await registry.deleteAgent('del');
    expect(await registry.getAgent('del')).toBeNull();
  });
});
