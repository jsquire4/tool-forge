import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTestDb } from '../tests/helpers/db.js';
import { createMcpServer } from './mcp-server.js';
import { upsertToolRegistry } from './db.js';

async function makeConnectedPair(db, config = {}) {
  const server = createMcpServer(db, config);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

describe('createMcpServer — tools/list', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('empty registry → tools: []', async () => {
    const { client, server } = await makeConnectedPair(db);
    const result = await client.listTools();
    expect(result.tools).toEqual([]);
    await client.close();
    await server.close();
  });

  it('only promoted tools appear in list', async () => {
    upsertToolRegistry(db, {
      tool_name: 'candidate_tool',
      lifecycle_state: 'candidate',
      spec_json: JSON.stringify({ name: 'candidate_tool', description: 'candidate' })
    });
    upsertToolRegistry(db, {
      tool_name: 'promoted_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({ name: 'promoted_tool', description: 'promoted' })
    });

    const { client, server } = await makeConnectedPair(db);
    const result = await client.listTools();
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].name).toBe('promoted_tool');
    await client.close();
    await server.close();
  });

  it('malformed spec_json in one promoted tool → that tool skipped, others still listed', async () => {
    upsertToolRegistry(db, {
      tool_name: 'broken_tool',
      lifecycle_state: 'promoted',
      spec_json: 'NOT VALID JSON {{{'
    });
    upsertToolRegistry(db, {
      tool_name: 'good_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({ name: 'good_tool', description: 'a good tool' })
    });

    const { client, server } = await makeConnectedPair(db);
    const result = await client.listTools();
    expect(result.tools.length).toBe(1);
    expect(result.tools[0].name).toBe('good_tool');
    await client.close();
    await server.close();
  });

  it('tool with no schema fields → inputSchema has empty properties, name and description present', async () => {
    upsertToolRegistry(db, {
      tool_name: 'no_params_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({ name: 'no_params_tool', description: 'no params' })
    });

    const { client, server } = await makeConnectedPair(db);
    const result = await client.listTools();
    expect(result.tools.length).toBe(1);
    const tool = result.tools[0];
    expect(tool.name).toBe('no_params_tool');
    expect(typeof tool.description).toBe('string');
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toEqual({});
    await client.close();
    await server.close();
  });
});

describe('createMcpServer — tools/call', () => {
  let db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('unknown tool name → isError: true (not a protocol error)', async () => {
    const { client, server } = await makeConnectedPair(db);
    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    await client.close();
    await server.close();
  });

  it('tool with no mcpRouting → isError: true', async () => {
    upsertToolRegistry(db, {
      tool_name: 'no_routing',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({ name: 'no_routing', description: 'no routing' })
    });

    const { client, server } = await makeConnectedPair(db);
    const result = await client.callTool({ name: 'no_routing', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no mcpRouting');
    await client.close();
    await server.close();
  });

  it('successful HTTP endpoint → isError: false and response text in content', async () => {
    const mockBody = { holdings: [{ symbol: 'AAPL', quantity: 10 }] };
    const mockServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockBody));
    });
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockServer.address().port;

    try {
      upsertToolRegistry(db, {
        tool_name: 'get_holdings',
        lifecycle_state: 'promoted',
        spec_json: JSON.stringify({
          name: 'get_holdings',
          description: 'Get holdings',
          mcpRouting: { endpoint: '/api/holdings', method: 'GET' }
        })
      });

      const config = { api: { baseUrl: `http://127.0.0.1:${mockPort}` } };
      const { client, server } = await makeConnectedPair(db, config);
      const result = await client.callTool({ name: 'get_holdings', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('AAPL');

      await client.close();
      await server.close();
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  it('non-200 HTTP response → isError: true', async () => {
    const mockServer = createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockServer.address().port;

    try {
      upsertToolRegistry(db, {
        tool_name: 'missing_resource',
        lifecycle_state: 'promoted',
        spec_json: JSON.stringify({
          name: 'missing_resource',
          description: 'Hits a 404 endpoint',
          mcpRouting: { endpoint: '/api/not-there', method: 'GET' }
        })
      });

      const config = { api: { baseUrl: `http://127.0.0.1:${mockPort}` } };
      const { client, server } = await makeConnectedPair(db, config);
      const result = await client.callTool({ name: 'missing_resource', arguments: {} });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('404');

      await client.close();
      await server.close();
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  it('unreachable endpoint → isError: true AND call is logged', async () => {
    upsertToolRegistry(db, {
      tool_name: 'unreachable_tool',
      lifecycle_state: 'promoted',
      spec_json: JSON.stringify({
        name: 'unreachable_tool',
        description: 'calls unreachable endpoint',
        mcpRouting: { endpoint: '/api/test', method: 'GET' }
      })
    });

    const config = { api: { baseUrl: 'http://127.0.0.1:1' } };
    const { client, server } = await makeConnectedPair(db, config);
    const result = await client.callTool({ name: 'unreachable_tool', arguments: {} });
    expect(result.isError).toBe(true);

    // Verify the call was logged even though the endpoint was unreachable
    const { getMcpCallLog } = await import('./db.js');
    const logs = getMcpCallLog(db, 'unreachable_tool');
    expect(logs.length).toBe(1);
    expect(logs[0].error).not.toBeNull();

    await client.close();
    await server.close();
  });
});
