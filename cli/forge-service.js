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
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

function readBody(req) {
  return new Promise((res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { res(data ? JSON.parse(data) : {}); } catch (_) { res({}); }
    });
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
  const port = await getPort();
  server.on('error', (err) => {
    process.stderr.write(`forge-service listen error: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    writeLock(port);
    process.stdout.write(`forge-service started on port ${port}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`forge-service failed: ${err.message}\n`);
  process.exit(1);
});
