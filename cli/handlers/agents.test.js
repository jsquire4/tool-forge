import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../../tests/helpers/db.js';
import { makeAgentRegistry } from '../agent-registry.js';
import { handleAgents } from './agents.js';

function makeReq(method, path, body = {}, adminKey = 'test-admin-key') {
  const bodyStr = JSON.stringify(body);
  let dataHandler, endHandler;
  return {
    method,
    url: path,
    headers: { authorization: adminKey ? `Bearer ${adminKey}` : undefined },
    on(event, handler) {
      if (event === 'data') { dataHandler = handler; }
      if (event === 'end') {
        endHandler = handler;
        if (bodyStr) dataHandler(bodyStr);
        endHandler();
      }
      if (event === 'error') { /* no-op */ }
    }
  };
}

function makeRes() {
  let body;
  return {
    writeHead: (code, headers) => { body = { statusCode: code }; },
    end: (data) => {
      try { body.data = JSON.parse(data); } catch { body.data = data; }
    },
    get statusCode() { return body?.statusCode; },
    get body() { return body?.data; },
    _getResponse() { return body; }
  };
}

function makeCtx(db) {
  return {
    config: { adminKey: 'test-admin-key' },
    agentRegistry: makeAgentRegistry({}, db)
  };
}

describe('handleAgents', () => {
  let db, ctx;

  beforeEach(() => {
    db = makeTestDb();
    ctx = makeCtx(db);
  });

  it('returns 503 without adminKey', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('GET', '/forge-admin/agents', {}, 'test-admin-key'),
      res,
      { config: { adminKey: null }, agentRegistry: ctx.agentRegistry }
    );
    expect(res.statusCode).toBe(503);
  });

  it('returns 403 with wrong adminKey', async () => {
    const res = makeRes();
    await handleAgents(makeReq('GET', '/forge-admin/agents', {}, 'wrong-key'), res, ctx);
    expect(res.statusCode).toBe(403);
  });

  it('GET /forge-admin/agents — returns empty list', async () => {
    const res = makeRes();
    await handleAgents(makeReq('GET', '/forge-admin/agents'), res, ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body.agents).toHaveLength(0);
  });

  it('POST /forge-admin/agents — creates agent', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'support', displayName: 'Support Bot' }),
      res, ctx
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.agent_id).toBe('support');
    expect(res.body.display_name).toBe('Support Bot');
  });

  it('POST /forge-admin/agents — validates id format', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'BAD ID!', displayName: 'Bad' }),
      res, ctx
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /forge-admin/agents — rejects missing displayName', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'valid' }),
      res, ctx
    );
    expect(res.statusCode).toBe(400);
  });

  it('POST /forge-admin/agents — rejects duplicate', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'support', display_name: 'Existing' });
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'support', displayName: 'Dup' }),
      res, ctx
    );
    expect(res.statusCode).toBe(409);
  });

  it('GET /forge-admin/agents/:agentId — returns agent', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'support', display_name: 'Support' });
    const res = makeRes();
    await handleAgents(makeReq('GET', '/forge-admin/agents/support'), res, ctx);
    expect(res.statusCode).toBe(200);
    expect(res.body.agent_id).toBe('support');
  });

  it('GET /forge-admin/agents/:agentId — 404 for missing', async () => {
    const res = makeRes();
    await handleAgents(makeReq('GET', '/forge-admin/agents/ghost'), res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('PUT /forge-admin/agents/:agentId — updates agent', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'support', display_name: 'Support' });
    const res = makeRes();
    await handleAgents(
      makeReq('PUT', '/forge-admin/agents/support', { displayName: 'Updated Support', defaultModel: 'gpt-4o' }),
      res, ctx
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.display_name).toBe('Updated Support');
    expect(res.body.default_model).toBe('gpt-4o');
  });

  it('PUT /forge-admin/agents/:agentId — 404 for missing', async () => {
    const res = makeRes();
    await handleAgents(makeReq('PUT', '/forge-admin/agents/ghost', { displayName: 'Ghost' }), res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /forge-admin/agents/:agentId — deletes agent', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'support', display_name: 'Support' });
    const res = makeRes();
    await handleAgents(makeReq('DELETE', '/forge-admin/agents/support'), res, ctx);
    expect(res.statusCode).toBe(200);
    expect(ctx.agentRegistry.getAgent('support')).toBeNull();
  });

  it('DELETE /forge-admin/agents/:agentId — 404 for missing', async () => {
    const res = makeRes();
    await handleAgents(makeReq('DELETE', '/forge-admin/agents/ghost'), res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('DELETE default agent auto-promotes another', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'a1', display_name: 'Agent 1' });
    ctx.agentRegistry.upsertAgent({ agent_id: 'a2', display_name: 'Agent 2' });
    ctx.agentRegistry.setDefault('a1');

    const res = makeRes();
    await handleAgents(makeReq('DELETE', '/forge-admin/agents/a1'), res, ctx);
    expect(res.statusCode).toBe(200);

    // a2 should now be default
    const a2 = ctx.agentRegistry.getAgent('a2');
    expect(a2.is_default).toBe(1);
  });

  it('POST /forge-admin/agents/:agentId/set-default — sets default', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'a1', display_name: 'Agent 1' });
    ctx.agentRegistry.upsertAgent({ agent_id: 'a2', display_name: 'Agent 2' });

    const res = makeRes();
    await handleAgents(makeReq('POST', '/forge-admin/agents/a2/set-default'), res, ctx);
    expect(res.statusCode).toBe(200);

    // Verify a2 is now default
    const agent = ctx.agentRegistry.getAgent('a2');
    expect(agent.is_default).toBe(1);
  });

  it('POST /forge-admin/agents/:agentId/set-default — 404 for missing', async () => {
    const res = makeRes();
    await handleAgents(makeReq('POST', '/forge-admin/agents/ghost/set-default'), res, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('validates defaultHitlLevel', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'bad', displayName: 'Bad', defaultHitlLevel: 'yolo' }),
      res, ctx
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('defaultHitlLevel');
  });

  it('rejects fractional maxTurns', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'bad', displayName: 'Bad', maxTurns: 3.7 }),
      res, ctx
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('maxTurns');
  });

  it('supports toolAllowlist as array', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('POST', '/forge-admin/agents', { id: 'scoped', displayName: 'Scoped', toolAllowlist: ['get_balance', 'list_users'] }),
      res, ctx
    );
    expect(res.statusCode).toBe(201);
    expect(res.body.tool_allowlist).toBe('["get_balance","list_users"]');
  });

  it('returns 501 when agentRegistry is null', async () => {
    const res = makeRes();
    await handleAgents(
      makeReq('GET', '/forge-admin/agents'),
      res,
      { config: { adminKey: 'test-admin-key' }, agentRegistry: null }
    );
    expect(res.statusCode).toBe(501);
  });

  it('PUT marks agent as admin-edited (seeded_from_config=0)', async () => {
    ctx.agentRegistry.upsertAgent({ agent_id: 'seeded', display_name: 'Seeded', seeded_from_config: 1 });
    const res = makeRes();
    await handleAgents(
      makeReq('PUT', '/forge-admin/agents/seeded', { displayName: 'Admin Edit' }),
      res, ctx
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.display_name).toBe('Admin Edit');
    expect(res.body.seeded_from_config).toBe(0);
  });
});
