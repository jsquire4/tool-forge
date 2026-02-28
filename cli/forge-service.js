#!/usr/bin/env node
/**
 * Forge Service — Local HTTP bridge between the TUI (Terminal A) and
 * the forge-tool skill running in Claude (Terminal B).
 *
 * Usage: node cli/forge-service.js
 *
 * Lock file: .forge-service.lock  → { port, pid, startedAt }
 * Endpoints:
 *   GET  /health   → { status, queueLength, working, uptime }
 *   POST /enqueue  → body: { endpoint } → { queued: true, position }
 *   GET  /next     → long-poll (30s timeout), returns first item or 204
 *   POST /complete → pops queue[0], sets working=false, notifies waiters
 *   DELETE /shutdown → cleanup + exit
 */

import { createServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { writeFileSync, unlinkSync, existsSync, readFileSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { createMcpServer } from './mcp-server.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mergeDefaults } from './config-schema.js';
import { createAuth } from './auth.js';
import { makePromptStore } from './prompt-store.js';
import { makePreferenceStore } from './preference-store.js';
import { makeConversationStore } from './conversation-store.js';
import { makeHitlEngine } from './hitl-engine.js';
import { handleChat } from './handlers/chat.js';
import { handleChatResume } from './handlers/chat-resume.js';
import { handleAdminConfig } from './handlers/admin.js';
import { handleGetPreferences, handlePutPreferences } from './handlers/preferences.js';
import { createDriftMonitor } from './drift-background.js';
import { VerifierRunner } from './verifier-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');
const NEXT_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const INACTIVITY_TIMEOUT_MS = 90_000;

const startedAt = Date.now();
let lastActivity = Date.now();

const queue = [];
let working = false;
const waiters = []; // pending /next long-poll response objects

// Sidecar mode: --mode=sidecar disables watchdog, binds 0.0.0.0
const sidecarMode = process.argv.includes('--mode=sidecar');

// MCP runtime state — initialized in main() after config and lock are ready
let forgeMcpKey = null;  // null = unset = fail-closed
let mcpDb = null;
let mcpConfig = null;

// Sidecar context — initialized when sidecar mode is active
let sidecarCtx = null;

/**
 * Parse a .env file into a key=value object.
 * Skips blank lines and comments. Strips surrounding quotes from values.
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
function loadDotEnv(envPath) {
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Read forge.config.json from project root. Returns {} on any error.
 * @returns {object}
 */
function loadConfig() {
  const configPath = resolve(PROJECT_ROOT, 'forge.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[forge-service] Could not parse forge.config.json: ${err.message}\n`);
    return {};
  }
}

function getPort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

function writeLock(port) {
  writeFileSync(LOCK_FILE, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8');
}

function removeLock() {
  if (existsSync(LOCK_FILE)) {
    try { unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
  }
}

const MAX_BODY_SIZE = 1_048_576; // 1 MB

function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        rej(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { res(data ? JSON.parse(data) : {}); } catch (_) { res({}); }
    });
    req.on('error', () => res({}));
  });
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Drain waiters: if there is a pending /next and something is available.
 */
function drainWaiters() {
  while (waiters.length > 0 && queue.length > 0 && !working) {
    const { res, timer } = waiters.shift();
    clearTimeout(timer);
    working = true;
    json(res, 200, queue[0]);
  }
}

const server = createHttpServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ── /mcp route — MCP protocol via StreamableHTTP ────────────────────────
  if (url.pathname.startsWith('/mcp')) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // Fail-closed: unset key, empty key, missing token, or wrong token → 401
    const tokenBuf = Buffer.from(token || '');
    const keyBuf = Buffer.from(forgeMcpKey || '');
    if (!forgeMcpKey || !token || tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }
    if (!mcpDb) {
      json(res, 503, { error: 'MCP server not initialized' });
      return;
    }
    const mcpServer = createMcpServer(mcpDb, mcpConfig);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      const parsedBody = await readBody(req);
      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      process.stderr.write(`[forge-service] MCP handler error: ${err.message}\n`);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      status: 'ok',
      queueLength: queue.length,
      working,
      waiting: waiters.length,   // # of active /next long-pollers (Claude sessions watching)
      uptime: Math.floor((Date.now() - startedAt) / 1000)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/enqueue') {
    const body = await readBody(req);
    if (!body.endpoint) {
      json(res, 400, { error: 'endpoint required' });
      return;
    }
    queue.push(body.endpoint);
    lastActivity = Date.now();
    json(res, 200, { queued: true, position: queue.length });
    drainWaiters();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/next') {
    lastActivity = Date.now();

    if (queue.length > 0 && !working) {
      working = true;
      json(res, 200, queue[0]);
      return;
    }

    // Long-poll: wait up to NEXT_TIMEOUT_MS
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.res === res);
      if (idx !== -1) waiters.splice(idx, 1);
      res.writeHead(204);
      res.end();
    }, NEXT_TIMEOUT_MS);

    waiters.push({ res, timer });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/complete') {
    if (queue.length > 0) queue.shift();
    working = false;
    lastActivity = Date.now();
    json(res, 200, { ok: true, remaining: queue.length });
    drainWaiters();
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/shutdown') {
    json(res, 200, { ok: true });
    shutdown();
    return;
  }

  // ── Sidecar routes (only when context is initialized) ───────────────────
  if (sidecarCtx) {
    if (url.pathname === '/agent-api/chat' && req.method === 'POST') {
      return handleChat(req, res, sidecarCtx);
    }
    if (url.pathname === '/agent-api/chat/resume' && req.method === 'POST') {
      return handleChatResume(req, res, sidecarCtx);
    }
    if (url.pathname === '/agent-api/user/preferences') {
      if (req.method === 'GET') return handleGetPreferences(req, res, sidecarCtx);
      if (req.method === 'PUT') return handlePutPreferences(req, res, sidecarCtx);
    }
    if (url.pathname.startsWith('/forge-admin/config')) {
      return handleAdminConfig(req, res, sidecarCtx);
    }
  }

  // ── Widget static file serving ───────────────────────────────────────────
  if (url.pathname.startsWith('/widget/')) {
    const relativePath = url.pathname.slice('/widget/'.length);
    const widgetDir = resolve(PROJECT_ROOT, 'widget');
    const filePath = resolve(widgetDir, relativePath);
    // Path traversal prevention (resolve symlinks)
    if (!existsSync(filePath)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const realPath = realpathSync(filePath);
    const realWidgetDir = realpathSync(widgetDir);
    if (!realPath.startsWith(realWidgetDir)) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const ext = filePath.split('.').pop();
    const MIME_TYPES = { html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(realPath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length, 'Cache-Control': 'public, max-age=3600' });
    res.end(content);
    return;
  }

  json(res, 404, { error: 'not found' });
});

function shutdown() {
  // Drain waiters with 204
  for (const { res, timer } of waiters) {
    clearTimeout(timer);
    try { res.writeHead(204); res.end(); } catch (_) { /* ignore */ }
  }
  waiters.length = 0;
  removeLock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Watchdog: self-terminate after inactivity
const watchdog = setInterval(() => {
  if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
    process.stderr.write('[forge-service] No activity for 90s — self-terminating\n');
    shutdown();
  }
}, WATCHDOG_INTERVAL_MS);
watchdog.unref();

async function main() {
  const rawConfig = loadConfig();
  const config = mergeDefaults(rawConfig);
  const port = sidecarMode
    ? (config.sidecar?.port ?? 8001)
    : await getPort();
  const bindHost = sidecarMode ? '0.0.0.0' : '127.0.0.1';

  server.on('error', (err) => {
    process.stderr.write(`forge-service listen error: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, bindHost, () => {
    writeLock(port);
    process.stdout.write(`forge-service started on ${bindHost}:${port}${sidecarMode ? ' (sidecar mode)' : ''}\n`);

    // Load .env after lock is written
    const envFile = loadDotEnv(resolve(PROJECT_ROOT, '.env'));
    const env = { ...process.env, ...envFile };

    // FORGE_MCP_KEY: check .env file first, then process.env
    // Empty string is treated as unset (fail-closed)
    const rawKey = envFile.FORGE_MCP_KEY ?? process.env.FORGE_MCP_KEY ?? '';
    forgeMcpKey = rawKey.trim() || null;

    // Initialize DB; if it fails, log and continue without MCP
    try {
      const dbPath = resolve(PROJECT_ROOT, config.dbPath || 'forge.db');
      mcpDb = getDb(dbPath);
      mcpConfig = config;
      process.stdout.write('[forge-service] MCP server initialized\n');

      // Initialize sidecar context (available for sidecar routes even outside --mode=sidecar)
      const auth = createAuth(config.auth);
      const promptStore = makePromptStore(config, mcpDb);
      const preferenceStore = makePreferenceStore(config, mcpDb);
      const conversationStore = makeConversationStore(config, mcpDb);
      const hitlEngine = makeHitlEngine(config, mcpDb);
      const verifierRunner = new VerifierRunner(mcpDb, config);
      sidecarCtx = { auth, promptStore, preferenceStore, conversationStore, hitlEngine, verifierRunner, db: mcpDb, config, env };
      process.stdout.write('[forge-service] Sidecar context initialized\n');
    } catch (err) {
      process.stderr.write(`[forge-service] MCP server init failed (MCP disabled): ${err.message}\n`);
      mcpDb = null;
      mcpConfig = null;
    }

    // In sidecar mode: disable watchdog, enable WAL, start drift monitor
    if (sidecarMode) {
      clearInterval(watchdog);
      if (mcpDb) {
        try {
          mcpDb.pragma('journal_mode = WAL');
          process.stdout.write('[forge-service] SQLite WAL mode enabled\n');
        } catch (err) {
          process.stderr.write(`[forge-service] WAL mode failed: ${err.message}\n`);
        }
        const driftMonitor = createDriftMonitor(config, mcpDb);
        driftMonitor.start();
        process.stdout.write('[forge-service] Background drift monitor started\n');
      }
      process.stdout.write(`[forge-service] Sidecar ready on ${bindHost}:${port}\n`);
    }
  });
}

main().catch((err) => {
  process.stderr.write(`forge-service failed: ${err.message}\n`);
  process.exit(1);
});
