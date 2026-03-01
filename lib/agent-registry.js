/**
 * AgentRegistry — multi-agent configuration for the sidecar runtime.
 *
 * Each agent selects a subset of tools from the shared tool_registry,
 * overrides model/HITL defaults, and carries its own system prompt.
 *
 * Factory: makeAgentRegistry(config, db)
 */

import {
  upsertAgent, getAgent, getAllAgents, getDefaultAgent,
  setDefaultAgent, deleteAgent
} from './db.js';

export class AgentRegistry {
  /**
   * @param {object} config — merged forge config
   * @param {import('better-sqlite3').Database} db
   */
  constructor(config, db) {
    this._config = config;
    this._db = db;
  }

  /**
   * Resolve an agent by ID. If agentId is null/empty, returns the default agent (or null).
   * If agentId is provided but not found or disabled, returns null.
   *
   * @param {string|null|undefined} agentId
   * @returns {object|null}
   */
  resolveAgent(agentId) {
    if (!agentId) {
      return getDefaultAgent(this._db);
    }
    const agent = getAgent(this._db, agentId);
    if (!agent || !agent.enabled) return null;
    return agent;
  }

  /**
   * Filter tools to an agent's allowlist. If allowlist is '*', returns all.
   * Operates on the { toolRows, tools } shape returned by loadPromotedTools.
   *
   * @param {{ toolRows: object[], tools: object[] }} loaded
   * @param {object|null} agent
   * @returns {{ toolRows: object[], tools: object[] }}
   */
  filterTools(loaded, agent) {
    if (!agent) return loaded;
    const allowlist = agent.tool_allowlist;
    if (!allowlist || allowlist === '*') return loaded;

    let allowed;
    try {
      allowed = JSON.parse(allowlist);
    } catch {
      return { toolRows: [], tools: [] }; // malformed → deny all (fail closed)
    }
    if (!Array.isArray(allowed)) return { toolRows: [], tools: [] };

    const allowSet = new Set(allowed);
    const toolRows = loaded.toolRows.filter(r => allowSet.has(r.tool_name));
    const tools = loaded.tools.filter(t => allowSet.has(t.name));
    return { toolRows, tools };
  }

  /**
   * Build an agent-scoped config by overlaying agent overrides onto the base config.
   * The returned object can be passed to PreferenceStore.resolveEffective() unchanged.
   *
   * @param {object} baseConfig — the merged forge config
   * @param {object|null} agent — agent row or null
   * @returns {object} scoped config
   */
  buildAgentConfig(baseConfig, agent) {
    if (!agent) return baseConfig;

    const scoped = { ...baseConfig };

    if (agent.default_model) scoped.defaultModel = agent.default_model;
    if (agent.default_hitl_level) scoped.defaultHitlLevel = agent.default_hitl_level;
    // Only override boolean flags when explicitly enabled (1), not on DB default (0).
    // DB column is NOT NULL DEFAULT 0, so 0 means "not explicitly set" — defer to base config.
    if (agent.allow_user_model_select) scoped.allowUserModelSelect = true;
    if (agent.allow_user_hitl_config) scoped.allowUserHitlConfig = true;
    if (agent.max_turns != null) scoped.maxTurns = agent.max_turns;
    if (agent.max_tokens != null) scoped.maxTokens = agent.max_tokens;

    return scoped;
  }

  /**
   * Resolve the system prompt for an agent.
   * Fallback chain: agent prompt → promptStore active → config.systemPrompt → default.
   *
   * @param {object|null} agent
   * @param {object} promptStore
   * @param {object} config
   * @returns {string}
   */
  resolveSystemPrompt(agent, promptStore, config) {
    if (agent?.system_prompt) return agent.system_prompt;
    const active = promptStore.getActivePrompt();
    if (active) return active;
    return config.systemPrompt || 'You are a helpful assistant.';
  }

  // ── CRUD pass-throughs ──────────────────────────────────────────────────

  getAgent(agentId) { return getAgent(this._db, agentId); }
  getAllAgents() { return getAllAgents(this._db); }
  upsertAgent(row) { return upsertAgent(this._db, row); }
  setDefault(agentId) { return setDefaultAgent(this._db, agentId); }
  deleteAgent(agentId) { return deleteAgent(this._db, agentId); }

  /**
   * Seed agents from config.agents[] array. Upserts with seeded_from_config=1.
   * Ensures at least one default exists if agents are defined.
   */
  seedFromConfig() {
    const agents = this._config.agents;
    if (!Array.isArray(agents) || agents.length === 0) return;

    let defaultAgentId = null;
    for (const a of agents) {
      if (!a.id || !a.displayName) continue;
      // Skip if agent exists and was modified outside of config seeding
      const existing = getAgent(this._db, a.id);
      if (existing && !existing.seeded_from_config) continue;
      upsertAgent(this._db, {
        agent_id: a.id,
        display_name: a.displayName,
        description: a.description ?? null,
        system_prompt: a.systemPrompt ?? null,
        default_model: a.defaultModel ?? null,
        default_hitl_level: a.defaultHitlLevel ?? null,
        allow_user_model_select: a.allowUserModelSelect ? 1 : 0,
        allow_user_hitl_config: a.allowUserHitlConfig ? 1 : 0,
        tool_allowlist: Array.isArray(a.toolAllowlist) ? JSON.stringify(a.toolAllowlist) : '*',
        max_turns: a.maxTurns ?? null,
        max_tokens: a.maxTokens ?? null,
        is_default: 0, // Don't set via upsert — use setDefaultAgent below to enforce single default
        enabled: 1,
        seeded_from_config: 1
      });
      if (a.isDefault) defaultAgentId = a.id;
    }

    // Enforce single default via setDefaultAgent (atomic clear + set)
    if (defaultAgentId) {
      setDefaultAgent(this._db, defaultAgentId);
    } else if (!getDefaultAgent(this._db)) {
      const first = agents.find(a => a.id && a.displayName);
      if (first) setDefaultAgent(this._db, first.id);
    }
  }
}

/**
 * Factory — creates an AgentRegistry backed by SQLite.
 * For Postgres, use buildSidecarContext which selects the adapter automatically.
 *
 * @param {object} config — merged forge config
 * @param {import('better-sqlite3').Database} db
 * @returns {AgentRegistry}
 */
export function makeAgentRegistry(config, db) {
  return new AgentRegistry(config, db);
}
