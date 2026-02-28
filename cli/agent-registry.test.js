import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../tests/helpers/db.js';
import { makeAgentRegistry } from './agent-registry.js';
import { upsertAgent, getAgent, getAllAgents, getDefaultAgent } from './db.js';

describe('AgentRegistry', () => {
  let db, registry;

  beforeEach(() => {
    db = makeTestDb();
    registry = makeAgentRegistry({}, db);
  });

  describe('resolveAgent', () => {
    it('returns null when no agents exist and no agentId provided', () => {
      expect(registry.resolveAgent(null)).toBeNull();
      expect(registry.resolveAgent(undefined)).toBeNull();
      expect(registry.resolveAgent('')).toBeNull();
    });

    it('returns the default agent when no agentId provided', () => {
      upsertAgent(db, { agent_id: 'support', display_name: 'Support Agent', is_default: 1, enabled: 1 });
      const agent = registry.resolveAgent(null);
      expect(agent).not.toBeNull();
      expect(agent.agent_id).toBe('support');
    });

    it('returns a specific agent by ID', () => {
      upsertAgent(db, { agent_id: 'sales', display_name: 'Sales Agent', enabled: 1 });
      const agent = registry.resolveAgent('sales');
      expect(agent).not.toBeNull();
      expect(agent.agent_id).toBe('sales');
    });

    it('returns null for disabled agent', () => {
      upsertAgent(db, { agent_id: 'disabled', display_name: 'Disabled', enabled: 0 });
      expect(registry.resolveAgent('disabled')).toBeNull();
    });

    it('returns null for non-existent agent', () => {
      expect(registry.resolveAgent('nonexistent')).toBeNull();
    });
  });

  describe('filterTools', () => {
    const loaded = {
      toolRows: [
        { tool_name: 'get_balance', spec_json: '{}' },
        { tool_name: 'create_order', spec_json: '{}' },
        { tool_name: 'list_users', spec_json: '{}' }
      ],
      tools: [
        { name: 'get_balance', description: 'Get balance' },
        { name: 'create_order', description: 'Create order' },
        { name: 'list_users', description: 'List users' }
      ]
    };

    it('returns all tools when agent is null', () => {
      const result = registry.filterTools(loaded, null);
      expect(result.tools).toHaveLength(3);
    });

    it('returns all tools when allowlist is *', () => {
      const agent = { tool_allowlist: '*' };
      const result = registry.filterTools(loaded, agent);
      expect(result.tools).toHaveLength(3);
    });

    it('filters to named subset', () => {
      const agent = { tool_allowlist: JSON.stringify(['get_balance', 'list_users']) };
      const result = registry.filterTools(loaded, agent);
      expect(result.tools).toHaveLength(2);
      expect(result.tools.map(t => t.name)).toEqual(['get_balance', 'list_users']);
      expect(result.toolRows).toHaveLength(2);
    });

    it('malformed JSON allowlist returns empty (fail closed)', () => {
      const agent = { tool_allowlist: 'not-json' };
      const result = registry.filterTools(loaded, agent);
      expect(result.tools).toHaveLength(0);
      expect(result.toolRows).toHaveLength(0);
    });

    it('non-array JSON allowlist returns empty (fail closed)', () => {
      const agent = { tool_allowlist: '{"foo":"bar"}' };
      const result = registry.filterTools(loaded, agent);
      expect(result.tools).toHaveLength(0);
    });
  });

  describe('buildAgentConfig', () => {
    const baseConfig = {
      defaultModel: 'claude-sonnet-4-6',
      defaultHitlLevel: 'cautious',
      allowUserModelSelect: false,
      allowUserHitlConfig: false,
      maxTurns: 10,
      maxTokens: 4096,
      conversation: { window: 25 }
    };

    it('returns base config when agent is null', () => {
      const result = registry.buildAgentConfig(baseConfig, null);
      expect(result).toBe(baseConfig);
    });

    it('overrides model and HITL from agent', () => {
      const agent = {
        default_model: 'gpt-4o',
        default_hitl_level: 'paranoid',
        allow_user_model_select: 1,
        allow_user_hitl_config: 1,
        max_turns: 5,
        max_tokens: 2048
      };
      const result = registry.buildAgentConfig(baseConfig, agent);
      expect(result.defaultModel).toBe('gpt-4o');
      expect(result.defaultHitlLevel).toBe('paranoid');
      expect(result.allowUserModelSelect).toBe(true);
      expect(result.allowUserHitlConfig).toBe(true);
      expect(result.maxTurns).toBe(5);
      expect(result.maxTokens).toBe(2048);
    });

    it('boolean flags with DB default 0 do not override base config', () => {
      const base = { ...baseConfig, allowUserModelSelect: true, allowUserHitlConfig: true };
      const agent = {
        allow_user_model_select: 0,
        allow_user_hitl_config: 0
      };
      const result = registry.buildAgentConfig(base, agent);
      // DB default 0 should NOT override base config true
      expect(result.allowUserModelSelect).toBe(true);
      expect(result.allowUserHitlConfig).toBe(true);
    });

    it('preserves base config values for null agent fields', () => {
      const agent = { default_model: null, default_hitl_level: null, max_turns: null, max_tokens: null };
      const result = registry.buildAgentConfig(baseConfig, agent);
      expect(result.defaultModel).toBe('claude-sonnet-4-6');
      expect(result.defaultHitlLevel).toBe('cautious');
    });
  });

  describe('resolveSystemPrompt', () => {
    it('returns agent prompt when set', () => {
      const agent = { system_prompt: 'You are a sales agent.' };
      const promptStore = { getActivePrompt: () => 'Global prompt' };
      const config = { systemPrompt: 'Config prompt' };
      expect(registry.resolveSystemPrompt(agent, promptStore, config)).toBe('You are a sales agent.');
    });

    it('falls back to global active prompt', () => {
      const promptStore = { getActivePrompt: () => 'Global prompt' };
      const config = { systemPrompt: 'Config prompt' };
      expect(registry.resolveSystemPrompt(null, promptStore, config)).toBe('Global prompt');
    });

    it('falls back to config.systemPrompt', () => {
      const promptStore = { getActivePrompt: () => null };
      const config = { systemPrompt: 'Config prompt' };
      expect(registry.resolveSystemPrompt(null, promptStore, config)).toBe('Config prompt');
    });

    it('falls back to hardcoded default', () => {
      const promptStore = { getActivePrompt: () => null };
      expect(registry.resolveSystemPrompt(null, promptStore, {})).toBe('You are a helpful assistant.');
    });
  });

  describe('CRUD pass-throughs', () => {
    it('upsertAgent + getAgent + getAllAgents', () => {
      registry.upsertAgent({ agent_id: 'a1', display_name: 'Agent 1' });
      registry.upsertAgent({ agent_id: 'a2', display_name: 'Agent 2' });

      expect(registry.getAgent('a1').display_name).toBe('Agent 1');
      expect(registry.getAllAgents()).toHaveLength(2);
    });

    it('setDefault', () => {
      registry.upsertAgent({ agent_id: 'a1', display_name: 'Agent 1' });
      registry.upsertAgent({ agent_id: 'a2', display_name: 'Agent 2' });

      registry.setDefault('a2');
      const def = getDefaultAgent(db);
      expect(def.agent_id).toBe('a2');
    });

    it('deleteAgent', () => {
      registry.upsertAgent({ agent_id: 'a1', display_name: 'Agent 1' });
      registry.deleteAgent('a1');
      expect(registry.getAgent('a1')).toBeNull();
    });
  });

  describe('seedFromConfig', () => {
    it('seeds agents from config.agents array', () => {
      const config = {
        agents: [
          { id: 'support', displayName: 'Support Agent', isDefault: true },
          { id: 'sales', displayName: 'Sales Agent', toolAllowlist: ['get_balance'] }
        ]
      };
      const reg = makeAgentRegistry(config, db);
      reg.seedFromConfig();

      const all = reg.getAllAgents();
      expect(all).toHaveLength(2);

      const def = getDefaultAgent(db);
      expect(def.agent_id).toBe('support');

      const sales = reg.getAgent('sales');
      expect(sales.tool_allowlist).toBe('["get_balance"]');
      expect(sales.seeded_from_config).toBe(1);
    });

    it('sets first agent as default when none explicit', () => {
      const config = {
        agents: [
          { id: 'a1', displayName: 'Agent 1' },
          { id: 'a2', displayName: 'Agent 2' }
        ]
      };
      const reg = makeAgentRegistry(config, db);
      reg.seedFromConfig();

      const def = getDefaultAgent(db);
      expect(def.agent_id).toBe('a1');
    });

    it('skips agents missing id or displayName', () => {
      const config = {
        agents: [
          { displayName: 'No ID' },
          { id: 'valid', displayName: 'Valid' }
        ]
      };
      const reg = makeAgentRegistry(config, db);
      reg.seedFromConfig();

      expect(reg.getAllAgents()).toHaveLength(1);
    });

    it('does not overwrite admin-edited agents (seeded_from_config=0)', () => {
      // Simulate admin creating an agent directly (not from config)
      upsertAgent(db, { agent_id: 'support', display_name: 'Admin Edited', seeded_from_config: 0 });

      const config = {
        agents: [{ id: 'support', displayName: 'Config Version' }]
      };
      const reg = makeAgentRegistry(config, db);
      reg.seedFromConfig();

      // Should NOT overwrite admin-edited agent
      const agent = reg.getAgent('support');
      expect(agent.display_name).toBe('Admin Edited');
    });

    it('enforces single default when multiple isDefault in config', () => {
      const config = {
        agents: [
          { id: 'a1', displayName: 'Agent 1', isDefault: true },
          { id: 'a2', displayName: 'Agent 2', isDefault: true }
        ]
      };
      const reg = makeAgentRegistry(config, db);
      reg.seedFromConfig();

      // Only one agent should be default (the last one with isDefault)
      const all = reg.getAllAgents();
      const defaults = all.filter(a => a.is_default === 1);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].agent_id).toBe('a2');
    });

    it('does nothing when agents array is empty or absent', () => {
      const reg1 = makeAgentRegistry({}, db);
      reg1.seedFromConfig();
      expect(reg1.getAllAgents()).toHaveLength(0);

      const reg2 = makeAgentRegistry({ agents: [] }, db);
      reg2.seedFromConfig();
      expect(reg2.getAllAgents()).toHaveLength(0);
    });
  });
});
