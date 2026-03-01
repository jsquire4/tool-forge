#!/usr/bin/env node
/**
 * Forge Service — Local HTTP bridge between the TUI (Terminal A) and
 * the forge-tool skill running in Claude (Terminal B).
 *
 * Usage: node lib/forge-service.js
 *
 * Lock file: .forge-service.lock  → { port, pid, startedAt }
 * Endpoints:
 *   GET  /health   → { status, queueLength, working, uptime }
 *   POST /enqueue  → body: { endpoint } → { queued: true, position }
 *   GET  /next     → long-poll (30s timeout), returns first item or 204
 *   POST /complete → pops queue[0], sets working=false, notifies waiters
 *   DELETE /shutdown → cleanup + exit
 *
 * Library exports:
 *   buildSidecarContext(config, db, env)  — construct sidecar context object
 *   createSidecarRouter(ctx, options)     — HTTP request handler for sidecar routes
 */

import { createServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { writeFileSync, unlinkSync, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { resolve, dirname, sep } from 'path';
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
import { requireDependency } from './dep-check.js';
import { sendJson } from './http-utils.js';
import { handleChat } from './handlers/chat.js';
import { handleChatSync } from './handlers/chat-sync.js';
import { handleChatResume } from './handlers/chat-resume.js';
import { handleAdminConfig } from './handlers/admin.js';
import { handleGetPreferences, handlePutPreferences } from './handlers/preferences.js';
import { createDriftMonitor } from './drift-background.js';
import { VerifierRunner } from './verifier-runner.js';
import { makeAgentRegistry } from './agent-registry.js';
import { handleAgents } from './handlers/agents.js';
import { handleConversations } from './handlers/conversations.js';
import { handleToolsList } from './handlers/tools-list.js';
import { makeRateLimiter } from './rate-limiter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ── Exported library functions ─────────────────────────────────────────────

/**
 * Build the sidecar context object from config, database, and environment.
 * This is the shared state passed to all sidecar request handlers.
 *
 * Creates Redis/Postgres clients based on config when needed.
 * Returns _redisClient and _pgPool for cleanup on shutdown.
 *
 * @param {object} config — merged config (after mergeDefaults)
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, string>} env — environment variables
 * @returns {Promise<{ auth, promptStore, preferenceStore, conversationStore, hitlEngine, verifierRunner, agentRegistry, db, config, env, _redisClient, _pgPool }>}
 */
export async function buildSidecarContext(config, db, env = {}, opts = {}) {
  const auth = createAuth(config.auth);

  let redisClient = null;
  let pgPool = null;
  const storeType = config?.conversation?.store ?? 'sqlite';

  if (storeType === 'redis') {
    await requireDependency('redis');
    const { createClient } = await import('redis');
    const url = config?.conversation?.redis?.url ?? 'redis://localhost:6379';
    redisClient = createClient({ url });
    redisClient.on('error', err => process.stderr.write(`[sidecar] Redis: ${err.message}\n`));
    await redisClient.connect();
  }

  if (storeType === 'postgres' || config?.database?.type === 'postgres') {
    await requireDependency('pg');
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;
    const rawUrl = config?.database?.url;
    let connStr = rawUrl;
    if (rawUrl?.startsWith('${') && rawUrl.endsWith('}')) {
      const SAFE_ENV_VAR_NAME = /^[A-Z_][A-Z0-9_]*$/;
      const varName = rawUrl.slice(2, -1);
      if (!SAFE_ENV_VAR_NAME.test(varName)) {
        throw new Error(`Invalid env var reference in config: "\${${varName}}" — only uppercase letters, digits, and underscores allowed`);
      }
      connStr = env[varName];
    }
    pgPool = new Pool({ connectionString: connStr ?? undefined });
  }

  // Select store backends (Postgres if configured, SQLite otherwise)
  let promptStore, preferenceStore, agentRegistry;
  if (pgPool && config?.database?.type === 'postgres') {
    const { PostgresPromptStore, PostgresPreferenceStore, PostgresAgentRegistry } = await import('./postgres-store.js');
    promptStore = new PostgresPromptStore(pgPool);
    preferenceStore = new PostgresPreferenceStore(pgPool, config);
    agentRegistry = new PostgresAgentRegistry(config, pgPool);
  } else {
    promptStore = makePromptStore(config, db);
    preferenceStore = makePreferenceStore(config, db);
    agentRegistry = makeAgentRegistry(config, db);
  }

  const conversationStore = makeConversationStore(config, db, pgPool);
  const hitlEngine = makeHitlEngine(config, db, redisClient, pgPool);
  const verifierRunner = new VerifierRunner(db, config);
  const rateLimiter = makeRateLimiter(config, redisClient);

  // configPath — used by admin handler to persist overlay changes.
  // Defaults to process.cwd() so library consumers write config to their own
  // project directory, not into the installed package.
  const configPath = opts?.configPath ?? resolve(process.cwd(), 'forge.config.json');

  return {
    auth, promptStore, preferenceStore, conversationStore, hitlEngine, verifierRunner,
    agentRegistry, db, config, env, rateLimiter, configPath,
    _redisClient: redisClient, _pgPool: pgPool
  };
}

/**
 * Serve a static file from the widget directory.
 * Validates the resolved path stays within widgetDir to prevent path traversal.
 * Shared by createSidecarRouter and createDirectServer.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} widgetDir — absolute path to the widget directory
 * @param {function} errorFn — send-error helper: (res, status, body) => void
 */
function serveWidgetFile(req, res, widgetDir, errorFn) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const relativePath = urlPath.replace(/^\/widget\//, '');
  if (!relativePath || relativePath.includes('..')) {
    errorFn(res, 400, { error: 'Invalid path' });
    return;
  }
  const filePath = resolve(widgetDir, relativePath);
  try {
    const realPath = realpathSync(filePath);
    const realWidget = realpathSync(widgetDir);
    if (!realPath.startsWith(realWidget + sep)) {
      errorFn(res, 403, { error: 'Forbidden' });
      return;
    }
    const content = readFileSync(realPath);
    const ext = realPath.split('.').pop();
    const mimeTypes = {
      js: 'application/javascript',
      css: 'text/css',
      html: 'text/html',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
    };
    const mtime = statSync(realPath).mtime.toUTCString();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] ?? 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'public, max-age=3600',
      'ETag': `"${mtime}"`,
    });
    res.end(content);
  } catch (err) {
    if (err.code === 'ENOENT') { errorFn(res, 404, { error: 'Not found' }); return; }
    errorFn(res, 500, { error: 'Internal error' });
  }
}

/**
 * Create an HTTP request handler for all sidecar routes.
 *
 * @param {object} ctx — sidecar context from buildSidecarContext()
 * @param {object} [options]
 * @param {string} [options.widgetDir] — directory for /widget/* static files (defaults to <project>/widget)
 * @param {function} [options.mcpHandler] — optional async (req, res) handler for /mcp route
 * @returns {function(import('http').IncomingMessage, import('http').ServerResponse): Promise<void>}
 */
export function createSidecarRouter(ctx, options = {}) {
  const widgetDir = options.widgetDir || resolve(__dirname, '..', 'widget');
  const mcpHandler = options.mcpHandler || null;

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // ── /mcp route (optional) ──────────────────────────────────────────────
    if (mcpHandler && url.pathname.startsWith('/mcp')) {
      return mcpHandler(req, res);
    }

    // ── /health ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // ── Sidecar API routes ─────────────────────────────────────────────────
    // Normalise /agent-api/v1/* → /agent-api/* so versioned paths hit
    // the same handlers without a proxy rewrite rule.
    const sidecarPath = url.pathname.startsWith('/agent-api/v1/')
      ? '/agent-api/' + url.pathname.slice('/agent-api/v1/'.length)
      : url.pathname;

    if (sidecarPath === '/agent-api/chat' && req.method === 'POST') {
      return handleChat(req, res, ctx);
    }
    if (sidecarPath === '/agent-api/chat-sync' && req.method === 'POST') {
      return handleChatSync(req, res, ctx);
    }
    if (sidecarPath === '/agent-api/chat/resume' && req.method === 'POST') {
      return handleChatResume(req, res, ctx);
    }
    if (sidecarPath === '/agent-api/user/preferences') {
      if (req.method === 'GET') return handleGetPreferences(req, res, ctx);
      if (req.method === 'PUT') return handlePutPreferences(req, res, ctx);
      else { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    }
    if (sidecarPath.startsWith('/agent-api/conversations')) {
      return handleConversations(req, res, ctx);
    }
    if (sidecarPath === '/agent-api/tools' && req.method === 'GET') {
      return handleToolsList(req, res, ctx);
    }
    if (url.pathname.startsWith('/forge-admin/agents')) {
      return handleAgents(req, res, ctx);
    }
    if (url.pathname.startsWith('/forge-admin/config')) {
      return handleAdminConfig(req, res, ctx);
    }

    // ── Widget static file serving ─────────────────────────────────────────
    if (url.pathname.startsWith('/widget/')) {
      serveWidgetFile(req, res, widgetDir, sendJson);
      return;
    }

    // ── 404 fallback ───────────────────────────────────────────────────────
    sendJson(res, 404, { error: 'not found' });
  };
}

// ── Direct-run internals (TUI bridge mode) ──────────────────────────────────

const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');
const NEXT_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 30_000;
const INACTIVITY_TIMEOUT_MS = 90_000;

const startedAt = Date.now();
let lastActivity = Date.now();

const queue = [];
let working = false;
const waiters = []; // pending /next long-poll response objects

// MCP runtime state — initialized in main() after config and lock are ready
let forgeMcpKey = null;  // null = unset = fail-closed
let mcpDb = null;
let mcpConfig = null;

// Sidecar context — initialized when sidecar mode is active
let sidecarCtx = null;

// Sidecar mode: --mode=sidecar disables watchdog, binds 0.0.0.0
const sidecarMode = process.argv.includes('--mode=sidecar');

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
    } else {
      // Strip inline comments (# preceded by space) for unquoted values
      val = val.split(/\s+#/)[0].trim();
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

let server;
let watchdog;

function createDirectServer() {
  server = createHttpServer(async (req, res) => {
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
      const mcpServer = createMcpServer(mcpDb, mcpConfig, sidecarCtx);
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
        waiting: waiters.length,
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
      const sidecarPath = url.pathname.startsWith('/agent-api/v1/')
        ? '/agent-api/' + url.pathname.slice('/agent-api/v1/'.length)
        : url.pathname;

      if (sidecarPath === '/agent-api/chat' && req.method === 'POST') {
        return handleChat(req, res, sidecarCtx);
      }
      if (sidecarPath === '/agent-api/chat-sync' && req.method === 'POST') {
        return handleChatSync(req, res, sidecarCtx);
      }
      if (sidecarPath === '/agent-api/chat/resume' && req.method === 'POST') {
        return handleChatResume(req, res, sidecarCtx);
      }
      if (sidecarPath === '/agent-api/user/preferences') {
        if (req.method === 'GET') return handleGetPreferences(req, res, sidecarCtx);
        if (req.method === 'PUT') return handlePutPreferences(req, res, sidecarCtx);
        else { json(res, 405, { error: 'Method not allowed' }); return; }
      }
      if (sidecarPath.startsWith('/agent-api/conversations')) {
        return handleConversations(req, res, sidecarCtx);
      }
      if (sidecarPath === '/agent-api/tools' && req.method === 'GET') {
        return handleToolsList(req, res, sidecarCtx);
      }
      if (url.pathname.startsWith('/forge-admin/agents')) {
        return handleAgents(req, res, sidecarCtx);
      }
      if (url.pathname.startsWith('/forge-admin/config')) {
        return handleAdminConfig(req, res, sidecarCtx);
      }
    }

    // ── Widget static file serving ───────────────────────────────────────────
    if (url.pathname.startsWith('/widget/')) {
      const directWidgetDir = resolve(PROJECT_ROOT, 'widget');
      // Use json() as the error helper since createDirectServer uses its own json()
      serveWidgetFile(req, res, directWidgetDir, (r, status, body) => json(r, status, body));
      return;
    }

    json(res, 404, { error: 'not found' });
  });

  return server;
}

function shutdown() {
  // Drain waiters with 204
  for (const { res, timer } of waiters) {
    clearTimeout(timer);
    try { res.writeHead(204); res.end(); } catch (_) { /* ignore */ }
  }
  waiters.length = 0;
  removeLock();
  server.close(() => process.exit(0));
  // Force-close lingering keep-alive connections (Node 18.2.0+)
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  setTimeout(() => process.exit(0), 2000);
}

async function main() {
  createDirectServer();

  // Watchdog: self-terminate after inactivity
  watchdog = setInterval(() => {
    if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
      process.stderr.write('[forge-service] No activity for 90s — self-terminating\n');
      shutdown();
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const rawConfig = loadConfig();
  const config = mergeDefaults(rawConfig);
  const port = sidecarMode
    ? (config.sidecar?.port ?? 8001)
    : await getPort();
  const bindHost = sidecarMode ? '0.0.0.0' : '127.0.0.1';

  // Load .env and initialize DB/sidecar context BEFORE server.listen() so that
  // any async errors (Redis connect, bad config, etc.) propagate to main().catch()
  // rather than being swallowed inside the listen callback (M10).
  const envFile = loadDotEnv(resolve(PROJECT_ROOT, '.env'));
  const env = { ...envFile, ...process.env };

  // FORGE_MCP_KEY: process.env takes precedence (set by Docker, CI, test harness),
  // then .env file. Empty string is treated as unset (fail-closed).
  const rawKey = process.env.FORGE_MCP_KEY ?? envFile.FORGE_MCP_KEY ?? '';
  forgeMcpKey = rawKey.trim() || null;

  // Initialize DB; if it fails, log and continue without MCP
  try {
    const dbPath = resolve(PROJECT_ROOT, config.dbPath || 'forge.db');
    mcpDb = getDb(dbPath);
    mcpConfig = config;
    process.stdout.write('[forge-service] MCP server initialized\n');

    // Build sidecar context using the exported function (async — awaited here
    // inside main() so unhandled-rejection is impossible)
    sidecarCtx = await buildSidecarContext(config, mcpDb, env);

    // Seed agents from config.agents[] if defined
    try {
      await sidecarCtx.agentRegistry.seedFromConfig();
      const allAgents = await sidecarCtx.agentRegistry.getAllAgents();
      if (allAgents.length > 0) {
        process.stdout.write(`[forge-service] Agent registry seeded: ${allAgents.length} agent(s)\n`);
      }
    } catch (err) {
      process.stderr.write(`[forge-service] Agent seeding failed: ${err.message}\n`);
    }
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
  }

  // Now start listening — callback is synchronous-only (no awaits inside)
  server.on('error', (err) => {
    process.stderr.write(`forge-service listen error: ${err.message}\n`);
    process.exit(1);
  });
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(port, bindHost, () => {
      server.removeListener('error', rej);
      writeLock(port);
      process.stdout.write(`forge-service started on ${bindHost}:${port}${sidecarMode ? ' (sidecar mode)' : ''}\n`);
      if (sidecarMode) {
        process.stdout.write(`[forge-service] Sidecar ready on ${bindHost}:${port}\n`);
      }
      res();
    });
  });
}

// Guard: only auto-execute when run directly (not when imported as a library)
let isDirectRun = false;
try {
  isDirectRun = Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  // broken symlink or unusual runner — treat as library import
}
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`forge-service failed: ${err.message}\n`);
    process.exit(1);
  });
}
