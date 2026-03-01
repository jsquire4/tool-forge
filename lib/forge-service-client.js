#!/usr/bin/env node
/**
 * Forge Service Client — CLI wrapper for the forge-service HTTP bridge.
 * Used by the forge-tool skill (Claude) to interact with the queue.
 *
 * Usage:
 *   node cli/forge-service-client.js start
 *   node cli/forge-service-client.js health
 *   node cli/forge-service-client.js next          # exits 0 + JSON or 1 on empty
 *   node cli/forge-service-client.js complete
 *   node cli/forge-service-client.js enqueue <json>
 *   node cli/forge-service-client.js shutdown
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');

function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
  } catch (_) {
    return null;
  }
}

async function httpRequest(method, path, body, timeoutMs = 35_000) {
  const lock = readLock();
  if (!lock) throw new Error('No forge service running (.forge-service.lock not found)');
  const { port } = lock;

  const { request } = await import('http');
  return new Promise((res, rej) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        res({ statusCode: response.statusCode, body: data });
      });
    });

    req.on('error', rej);
    const timer = setTimeout(() => {
      req.destroy(new Error('timeout'));
    }, timeoutMs);

    req.on('close', () => clearTimeout(timer));

    if (payload) req.write(payload);
    req.end();
  });
}

async function cmdStart() {
  const existing = readLock();
  if (existing) {
    // Verify it's actually alive
    try {
      const r = await httpRequest('GET', '/health', null, 3000);
      if (r.statusCode === 200) {
        const data = JSON.parse(r.body);
        console.log(`Forge service already active on port ${existing.port}`);
        console.log(JSON.stringify(data));
        process.exit(0);
      }
    } catch (_) {
      // Stale lock — remove it before spawning a new instance
    }
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(LOCK_FILE);
    } catch (_) { /* ignore */ }
  }

  const child = spawn('node', [resolve(__dirname, 'forge-service.js')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  let stderrOutput = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { stderrOutput += d.toString(); });

  await new Promise((res, rej) => {
    const timeout = setTimeout(() => {
      const detail = stderrOutput.trim() ? `\nService stderr: ${stderrOutput.trim()}` : '';
      rej(new Error(`Service start timeout${detail}`));
    }, 10_000);
    const poll = setInterval(() => {
      if (readLock()) {
        clearTimeout(timeout);
        clearInterval(poll);
        res();
      }
    }, 200);
    child.on('error', (err) => { clearTimeout(timeout); clearInterval(poll); rej(err); });
  });

  child.unref();
  const lock = readLock();
  console.log(`Forge service started on port ${lock.port}`);
  process.exit(0);
}

async function cmdHealth() {
  const r = await httpRequest('GET', '/health');
  console.log(r.body);
  process.exit(r.statusCode === 200 ? 0 : 1);
}

async function cmdNext() {
  // Long-poll /next — 30s server timeout + 35s client timeout
  const r = await httpRequest('GET', '/next', null, 36_000);
  if (r.statusCode === 200) {
    console.log(r.body);
    process.exit(0);
  } else {
    // 204 = nothing in queue after timeout
    process.exit(1);
  }
}

async function cmdComplete() {
  const r = await httpRequest('POST', '/complete');
  console.log(r.body);
  process.exit(r.statusCode === 200 ? 0 : 1);
}

async function cmdEnqueue(jsonArg) {
  if (!jsonArg) {
    console.error('Usage: forge-service-client.js enqueue <json>');
    process.exit(1);
  }
  let endpoint;
  try {
    endpoint = JSON.parse(jsonArg);
  } catch (_) {
    console.error('Invalid JSON argument');
    process.exit(1);
  }
  const r = await httpRequest('POST', '/enqueue', { endpoint });
  console.log(r.body);
  process.exit(r.statusCode === 200 ? 0 : 1);
}

async function cmdShutdown() {
  const r = await httpRequest('DELETE', '/shutdown');
  console.log(r.body);
  process.exit(0);
}

const [,, cmd, ...args] = process.argv;

const handlers = {
  start: cmdStart,
  health: cmdHealth,
  next: cmdNext,
  complete: cmdComplete,
  enqueue: () => cmdEnqueue(args[0]),
  shutdown: cmdShutdown
};

if (!cmd || !handlers[cmd]) {
  console.error(`Usage: forge-service-client.js <start|health|next|complete|enqueue|shutdown>`);
  process.exit(1);
}

handlers[cmd]().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
