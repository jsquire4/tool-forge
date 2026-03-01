/**
 * Integration tests for the sidecar library entry point (cli/sidecar.js).
 *
 * Tests createSidecar(), buildSidecarContext + createSidecarRouter (advanced path),
 * config validation, close(), agent seeding, route existence, and import side effects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';

// Track instances to clean up after each test
const instances = [];

async function cleanup() {
  for (const inst of instances) {
    try { await inst.close(); } catch { /* ignore */ }
  }
  instances.length = 0;
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpPost(port, path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

describe('createSidecar', () => {
  afterEach(cleanup);

  it('starts a server and /health returns 200', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({ auth: { mode: 'trust' } }, { port: 0, host: '127.0.0.1' });
    instances.push(sidecar);

    const addr = sidecar.server.address();
    expect(addr).toBeTruthy();
    expect(addr.port).toBeGreaterThan(0);

    const res = await httpGet(addr.port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns server that is not listening when autoListen=false', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({ auth: { mode: 'trust' } }, { autoListen: false });
    instances.push(sidecar);

    expect(sidecar.server).toBeTruthy();
    expect(sidecar.server.listening).toBe(false);
    expect(sidecar.ctx).toBeTruthy();
    expect(typeof sidecar.close).toBe('function');
  });

  it('rejects invalid config with thrown error', async () => {
    const { createSidecar } = await import('./sidecar.js');
    await expect(
      createSidecar({ auth: { mode: 'bad-mode' } })
    ).rejects.toThrow(/Invalid sidecar config/);
  });

  it('close() stops server and closes DB', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({ auth: { mode: 'trust' } }, { port: 0, host: '127.0.0.1' });
    // Don't push to instances — we close manually
    const port = sidecar.server.address().port;

    // Verify server is running
    const res = await httpGet(port, '/health');
    expect(res.status).toBe(200);

    // Close
    await sidecar.close();

    // Server should no longer accept connections
    await expect(httpGet(port, '/health')).rejects.toThrow();
  });

  it('seeds agents from config', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({
      auth: { mode: 'trust' },
      adminKey: 'test-admin-key',
      agents: [
        { id: 'support', displayName: 'Support Agent' },
        { id: 'portfolio', displayName: 'Portfolio Agent' },
      ]
    }, { port: 0, host: '127.0.0.1' });
    instances.push(sidecar);

    const port = sidecar.server.address().port;

    // Fetch agents via admin endpoint (Bearer token auth)
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/forge-admin/agents`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer test-admin-key' },
      }, (r) => {
        let data = '';
        r.on('data', (chunk) => { data += chunk; });
        r.on('end', () => {
          resolve({ status: r.statusCode, body: JSON.parse(data) });
        });
      });
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
    expect(res.body.agents).toBeInstanceOf(Array);
    const ids = res.body.agents.map(a => a.agent_id);
    expect(ids).toContain('support');
    expect(ids).toContain('portfolio');
  });

  it('/agent-api/chat returns 401 without JWT (proves routing works)', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({
      auth: { mode: 'verify', signingKey: 'test-secret' }
    }, { port: 0, host: '127.0.0.1' });
    instances.push(sidecar);

    const port = sidecar.server.address().port;
    const res = await httpPost(port, '/agent-api/chat', { message: 'hi' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({ auth: { mode: 'trust' } }, { port: 0, host: '127.0.0.1' });
    instances.push(sidecar);

    const port = sidecar.server.address().port;
    const res = await httpGet(port, '/nonexistent');
    expect(res.status).toBe(404);
  });

  it('close() is idempotent — teardown runs only once even when called twice', async () => {
    // Verify that calling close() twice does not double-close Redis/Postgres/SQLite.
    // We spy on ctx._pgPool and db.close via the returned ctx object.
    const { createSidecar } = await import('./sidecar.js');
    const sidecar = await createSidecar({ auth: { mode: 'trust' } }, { port: 0, host: '127.0.0.1', autoListen: true });

    // Inject a spy on the db that the sidecar holds internally.
    // ctx.db is the same db instance created inside createSidecar.
    let closeCallCount = 0;
    const originalClose = sidecar.ctx.db.close.bind(sidecar.ctx.db);
    sidecar.ctx.db.close = () => {
      closeCallCount++;
      try { originalClose(); } catch { /* ignore */ }
    };

    // Call close() twice in parallel — only one teardown should execute.
    await Promise.all([sidecar.close(), sidecar.close()]);

    expect(closeCallCount).toBe(1);
  });

  it('partial config missing optional fields does not throw (mergeDefaults runs before validateConfig)', async () => {
    // A config with no auth (other than explicit trust mode), no conversation, no sidecar fields
    // should succeed because mergeDefaults fills in all required defaults before validation runs.
    const { createSidecar } = await import('./sidecar.js');
    // Provide only adminKey + explicit trust mode — all other fields rely on defaults
    const sidecar = await createSidecar({ adminKey: 'k', auth: { mode: 'trust' } }, { autoListen: false });
    instances.push(sidecar);

    expect(sidecar.ctx).toBeTruthy();
    expect(sidecar.ctx.config.auth.mode).toBe('trust');
    expect(sidecar.ctx.config.defaultHitlLevel).toBe('cautious');
  });
});

describe('buildSidecarContext + createSidecarRouter (advanced path)', () => {
  afterEach(cleanup);

  it('works independently to create a functioning server', async () => {
    const { buildSidecarContext, createSidecarRouter, mergeDefaults, getDb } = await import('./sidecar.js');

    const db = getDb(':memory:');
    const config = mergeDefaults({});
    const ctx = await buildSidecarContext(config, db, {});
    const handler = createSidecarRouter(ctx);

    const server = http.createServer(handler);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));

    // Track for cleanup
    instances.push({
      server,
      close: () => new Promise((res) => {
        server.close(() => { db.close(); res(); });
      })
    });

    const port = server.address().port;
    const res = await httpGet(port, '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('import side effects', () => {
  it('importing sidecar.js does not trigger blessed or start any server', async () => {
    // This test verifies that merely importing the module has no side effects.
    // If blessed were imported at the top level and missing, this would throw.
    // If forge-service.js auto-executed main(), a server would start.
    const mod = await import('./sidecar.js');
    expect(typeof mod.createSidecar).toBe('function');
    expect(typeof mod.buildSidecarContext).toBe('function');
    expect(typeof mod.createSidecarRouter).toBe('function');
    expect(typeof mod.mergeDefaults).toBe('function');
    expect(typeof mod.validateConfig).toBe('function');
    expect(typeof mod.getDb).toBe('function');
    expect(typeof mod.createAuth).toBe('function');
    expect(typeof mod.reactLoop).toBe('function');
    expect(typeof mod.initSSE).toBe('function');
  });
});
