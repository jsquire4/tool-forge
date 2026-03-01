import { describe, it, expect } from 'vitest';
import { PostgresStore, PostgresPromptStore, PostgresPreferenceStore, PostgresAgentRegistry, PostgresEvalStore, PostgresChatAuditStore, PostgresVerifierStore } from './postgres-store.js';

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
    expect(typeof store.getPromotedTools).toBe('function');
    expect(typeof store.upsertToolRegistry).toBe('function');
    expect(typeof store.getToolRegistry).toBe('function');
    expect(typeof store.getAllToolRegistry).toBe('function');
    expect(typeof store.updateToolLifecycle).toBe('function');
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

describe('PostgresEvalStore', () => {
  it('insertEvalRun returns an id', async () => {
    // Create a minimal mock pool that returns { rows: [{ id: 42 }] } for INSERT RETURNING
    const pool = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO eval_runs')) {
          return { rows: [{ id: 42 }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {}
      })
    };
    const store = new PostgresEvalStore(pool);
    const id = await store.insertEvalRun({
      tool_name: 'test_tool', eval_type: 'golden', total_cases: 10,
      passed: 8, failed: 2, skipped: 0, model: 'claude-sonnet-4-6'
    });
    expect(id).toBe(42);
  });

  it('insertEvalRunCases inserts rows in a transaction', async () => {
    const queries = [];
    const client = {
      async query(sql) { queries.push(sql.trim().split('\n')[0].trim()); return { rows: [] }; },
      release() {}
    };
    const pool = {
      async query() { return { rows: [] }; },
      async connect() { return client; }
    };
    const store = new PostgresEvalStore(pool);
    await store.insertEvalRunCases([
      { eval_run_id: 1, tool_name: 'tool_a', status: 'pass', run_at: new Date().toISOString() },
      { eval_run_id: 1, tool_name: 'tool_a', status: 'fail', run_at: new Date().toISOString() }
    ]);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });

  it('insertEvalRunCases rolls back on error', async () => {
    let rolledBack = false;
    const client = {
      async query(sql) {
        if (sql.includes('INSERT INTO eval_run_cases')) throw new Error('DB error');
        if (sql.includes('ROLLBACK')) rolledBack = true;
        return { rows: [] };
      },
      release() {}
    };
    const pool = { async query() { return { rows: [] }; }, async connect() { return client; } };
    const store = new PostgresEvalStore(pool);
    await expect(store.insertEvalRunCases([
      { eval_run_id: 1, tool_name: 'tool_a', status: 'pass', run_at: new Date().toISOString() }
    ])).rejects.toThrow('DB error');
    expect(rolledBack).toBe(true);
  });

  it('listRuns passes limit and offset as params', async () => {
    let capturedParams = [];
    const pool = {
      async query(sql, params) { capturedParams = params; return { rows: [] }; }
    };
    const store = new PostgresEvalStore(pool);
    await store.listRuns(25, 50);
    expect(capturedParams[0]).toBe(25);
    expect(capturedParams[1]).toBe(50);
  });
});

describe('PostgresChatAuditStore', () => {
  it('insertChatAudit inserts a row and returns id', async () => {
    const insertedParams = [];
    const pool = {
      async query(sql, params) {
        if (sql.includes('INSERT INTO chat_audit')) {
          insertedParams.push(...params);
          return { rows: [{ id: 7 }] };
        }
        return { rows: [] };
      }
    };
    const store = new PostgresChatAuditStore(pool);
    const id = await store.insertChatAudit({
      session_id: 'sess-1', user_id: 'user-1', route: '/agent-api/chat',
      status_code: 200, duration_ms: 500, model: 'claude-sonnet-4-6',
      tool_count: 2, hitl_triggered: 0, warnings_count: 0
    });
    expect(id).toBe(7);
    expect(insertedParams[0]).toBe('sess-1'); // session_id is first param
  });

  it('getStats returns shaped stats object', async () => {
    const pool = {
      async query() {
        return { rows: [{ total_sessions: '42', avg_duration_ms: '350.5', error_rate: '0.05', messages_today: '10' }] };
      }
    };
    const store = new PostgresChatAuditStore(pool);
    const stats = await store.getStats();
    expect(stats.totalSessions).toBe(42);
    expect(stats.avgDurationMs).toBe(351);
    expect(stats.errorRate).toBeCloseTo(0.05);
    expect(stats.messagesToday).toBe(10);
  });

  it('getSessions passes limit and offset as params', async () => {
    let capturedParams = [];
    const pool = {
      async query(sql, params) { capturedParams = params; return { rows: [] }; }
    };
    const store = new PostgresChatAuditStore(pool);
    await store.getSessions(50, 100);
    expect(capturedParams[0]).toBe(50);
    expect(capturedParams[1]).toBe(100);
  });
});

describe('PostgresVerifierStore', () => {
  it('upsertVerifier runs without SQL syntax errors', async () => {
    let capturedSql = '';
    const pool = {
      async query(sql, params) {
        capturedSql = sql;
        return { rows: [] };
      }
    };
    const store = new PostgresVerifierStore(pool);
    // This must not throw — if the JS // comment is still inside the SQL, Postgres would reject it.
    // The mock pool captures the SQL so we can inspect it.
    await store.upsertVerifier({
      verifier_name: 'test-verifier', type: 'schema',
      spec_json: JSON.stringify({ required: ['id'] }),
      aciru_category: 'A', aciru_order: 'A-0001', enabled: 1
    });
    // Verify the SQL does NOT contain JS-style // comments (those are not valid SQL)
    expect(capturedSql).not.toContain('//');
    // Verify the SQL does contain the correct Postgres comment syntax if any
  });

  it('getAllVerifiers returns rows with enabled=1', async () => {
    const mockRows = [{ verifier_name: 'v1', enabled: 1 }];
    const pool = {
      async query(sql) {
        if (sql.includes('verifier_registry')) return { rows: mockRows };
        return { rows: [] };
      }
    };
    const store = new PostgresVerifierStore(pool);
    const results = await store.getAllVerifiers();
    expect(results).toHaveLength(1);
    expect(results[0].verifier_name).toBe('v1');
  });

  it('deleteVerifier wraps deletes in a transaction', async () => {
    const txLog = [];
    const client = {
      async query(sql) {
        txLog.push(sql.trim().split(' ')[0]);
        return { rows: [] };
      },
      release() {}
    };
    const pool = {
      async query() { return { rows: [] }; },
      async connect() { return client; }
    };
    const store = new PostgresVerifierStore(pool);
    await store.deleteVerifier('test-verifier');
    expect(txLog[0]).toBe('BEGIN');
    expect(txLog[txLog.length - 1]).toBe('COMMIT');
  });

  it('upsertVerifierBinding inserts binding', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push(sql);
        return { rows: [] };
      }
    };
    const store = new PostgresVerifierStore(pool);
    await store.upsertVerifierBinding({ verifier_name: 'v1', tool_name: 'tool_a', enabled: 1 });
    expect(queries[0]).toContain('verifier_tool_bindings');
  });

  it('getVerifiersForTool returns verifiers joined with bindings', async () => {
    const mockRows = [{ verifier_name: 'v1', type: 'schema' }];
    const pool = {
      async query(sql, params) {
        if (sql.includes('verifier_registry vr')) return { rows: mockRows };
        return { rows: [] };
      }
    };
    const store = new PostgresVerifierStore(pool);
    const results = await store.getVerifiersForTool('tool_a');
    expect(results).toHaveLength(1);
    expect(results[0].verifier_name).toBe('v1');
  });

  it('insertVerifierResult inserts and returns id', async () => {
    const pool = {
      async query() { return { rows: [{ id: 42 }] }; }
    };
    const store = new PostgresVerifierStore(pool);
    const id = await store.insertVerifierResult({
      session_id: 's1', tool_name: 'my_tool', verifier_name: 'v1', outcome: 'warn', message: 'test'
    });
    expect(id).toBe(42);
  });

  it('getResults with toolName filters by tool', async () => {
    let capturedSql = '';
    const pool = {
      async query(sql) { capturedSql = sql; return { rows: [{ tool_name: 'my_tool' }] }; }
    };
    const store = new PostgresVerifierStore(pool);
    const rows = await store.getResults('my_tool');
    expect(capturedSql).toContain('WHERE tool_name');
    expect(rows[0].tool_name).toBe('my_tool');
  });

  it('getResults without toolName returns all', async () => {
    let capturedSql = '';
    const pool = {
      async query(sql) { capturedSql = sql; return { rows: [] }; }
    };
    const store = new PostgresVerifierStore(pool);
    await store.getResults();
    expect(capturedSql).not.toContain('WHERE');
  });
});

describe('updateToolLifecycle', () => {
  it('allows valid lifecycle columns', async () => {
    const setClauses = [];
    const pool = {
      async query(sql, params) {
        if (sql.includes('UPDATE tool_registry')) {
          setClauses.push(sql);
        }
        return { rows: [] };
      }
    };
    const store = new PostgresStore({ connectionString: null });
    store._pool = pool;
    await store.updateToolLifecycle('test_tool', { lifecycle_state: 'promoted', baseline_pass_rate: 0.95 });
    expect(setClauses[0]).toContain('lifecycle_state');
    expect(setClauses[0]).toContain('baseline_pass_rate');
  });

  it('blocks SQL injection via column allowlist', async () => {
    const queries = [];
    const pool = {
      async query(sql, params) {
        queries.push(sql);
        return { rows: [] };
      }
    };
    const store = new PostgresStore({ connectionString: null });
    store._pool = pool;
    // Attempt to inject via a disallowed column name
    await store.updateToolLifecycle('test_tool', {
      'lifecycle_state; DROP TABLE tool_registry; --': 'evil'
    });
    // No query should have been issued because all column names were rejected
    expect(queries).toHaveLength(0);
  });
});
