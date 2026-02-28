/**
 * Integration tests for forge-service /mcp auth (Group 4: Bearer token auth — safety-critical)
 * and basic route non-regression (Group 7).
 *
 * Starts forge-service as a child process per test group, reads the lock file
 * to find the port, then makes HTTP requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SERVICE_PATH = resolve(__dirname, 'forge-service.js');

const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');

/**
 * Wait for the lock file to appear and return its parsed contents.
 * Times out after maxMs milliseconds.
 */
async function waitForLock(maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (existsSync(LOCK_FILE)) {
      try {
        const data = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
        if (data.port) return data;
      } catch (_) {
        // file not fully written yet
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Lock file not created within ${maxMs}ms`);
}

/**
 * Start the forge-service and return { process, port }.
 * Cleans up the lock file first to avoid stale state.
 */
async function startService(env = {}) {
  // Clean up any stale lock file
  if (existsSync(LOCK_FILE)) {
    try { unlinkSync(LOCK_FILE); } catch (_) {}
  }

  const proc = spawn(process.execPath, [SERVICE_PATH], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const { port } = await waitForLock(6000);
  return { proc, port };
}

/**
 * Send DELETE /shutdown to cleanly stop the service, then kill if needed.
 */
async function stopService(port, proc) {
  try {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'DELETE' });
  } catch (_) {}
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 1000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  // Clean up lock file
  if (existsSync(LOCK_FILE)) {
    try { unlinkSync(LOCK_FILE); } catch (_) {}
  }
}

// ── Group 4: Bearer token auth tests ───────────────────────────────────────

describe('forge-service /mcp auth (Group 4)', () => {
  let proc;
  let port;
  const TEST_KEY = 'test-mcp-key-abc123';

  beforeAll(async () => {
    ({ proc, port } = await startService({ FORGE_MCP_KEY: TEST_KEY }));
  }, 10000);

  afterAll(async () => {
    await stopService(port, proc);
  }, 5000);

  it('FORGE_MCP_KEY set, no Authorization header → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  it('FORGE_MCP_KEY set, wrong token → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    });
    expect(res.status).toBe(401);
  });

  it('GET /health still returns 200 (no regression)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('Unknown route → 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it('POST /enqueue unaffected by MCP mount', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'test-endpoint' })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(true);
  });
});

// ── Group 4 continued: key not set → fail-closed ───────────────────────────

describe('forge-service /mcp auth — FORGE_MCP_KEY not set', () => {
  let proc;
  let port;

  beforeAll(async () => {
    // Spawn without FORGE_MCP_KEY in env (strip it from parent env too)
    const env = { ...process.env };
    delete env.FORGE_MCP_KEY;
    ({ proc, port } = await startService({ FORGE_MCP_KEY: '' }));
  }, 10000);

  afterAll(async () => {
    await stopService(port, proc);
  }, 5000);

  it('FORGE_MCP_KEY not set (empty string passed) → 401 for POST /mcp', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sometoken'
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    });
    expect(res.status).toBe(401);
  });

  it('GET /health still returns 200 when FORGE_MCP_KEY is unset', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });
});
