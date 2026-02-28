/**
 * Sidecar — Library entry point for tool-forge.
 *
 * Usage:
 *   import { createSidecar } from 'tool-forge';
 *   const sidecar = await createSidecar({ ... }, { port: 8001 });
 *   // sidecar.server, sidecar.ctx, sidecar.close()
 *
 * Advanced:
 *   import { buildSidecarContext, createSidecarRouter, mergeDefaults, getDb } from 'tool-forge';
 */

import { createServer as createHttpServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db.js';
import { mergeDefaults, validateConfig } from './config-schema.js';
import { buildSidecarContext, createSidecarRouter } from './forge-service.js';
import { createDriftMonitor } from './drift-background.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create a fully configured sidecar instance.
 *
 * @param {object} config — sidecar configuration (auth, agents, model, etc.)
 * @param {object} [options]
 * @param {number} [options.port=8001] — port to listen on
 * @param {string} [options.host='0.0.0.0'] — bind address
 * @param {string} [options.dbPath=':memory:'] — SQLite database path
 * @param {Record<string, string>} [options.env] — environment variables (defaults to process.env)
 * @param {boolean} [options.autoListen=true] — start listening immediately
 * @param {boolean} [options.enableDrift=false] — start background drift monitor
 * @param {string} [options.widgetDir] — custom widget directory
 * @returns {Promise<{ server: import('http').Server, ctx: object, close: () => void }>}
 */
export async function createSidecar(config = {}, options = {}) {
  const {
    port = 8001,
    host = '0.0.0.0',
    dbPath = ':memory:',
    env = process.env,
    autoListen = true,
    enableDrift = false,
    widgetDir,
  } = options;

  // Validate config before proceeding
  const { valid, errors } = validateConfig(config);
  if (!valid) {
    throw new Error(`Invalid sidecar config: ${errors.join('; ')}`);
  }

  // Merge defaults into user config
  const merged = mergeDefaults(config);

  // Initialize database with WAL mode
  const db = getDb(dbPath);
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    // WAL not supported on all platforms — continue without it
  }

  // Build sidecar context (async — may create Redis/Postgres clients)
  const ctx = await buildSidecarContext(merged, db, env);

  // Seed agents from config
  ctx.agentRegistry.seedFromConfig();

  // Build request handler
  const routerOpts = {};
  if (widgetDir) routerOpts.widgetDir = widgetDir;
  const router = createSidecarRouter(ctx, routerOpts);

  // Create HTTP server
  const server = createHttpServer(router);

  // Optional drift monitor
  let driftMonitor = null;
  if (enableDrift) {
    driftMonitor = createDriftMonitor(merged, db);
    driftMonitor.start();
  }

  // close() tears down everything cleanly
  function close() {
    if (driftMonitor) {
      driftMonitor.stop();
      driftMonitor = null;
    }

    async function teardownConnections() {
      try { if (ctx._redisClient) await ctx._redisClient.quit(); } catch { /* ignore */ }
      try { if (ctx._pgPool) await ctx._pgPool.end(); } catch { /* ignore */ }
      try { db.close(); } catch { /* already closed */ }
    }

    return new Promise((resolve) => {
      server.close(async () => {
        await teardownConnections();
        resolve();
      });
      // Force-close after 2s if connections linger
      setTimeout(async () => {
        await teardownConnections();
        resolve();
      }, 2000);
    });
  }

  // Optionally start listening
  if (autoListen) {
    await new Promise((res, rej) => {
      server.on('error', rej);
      server.listen(port, host, () => res());
    });
  }

  return { server, ctx, close };
}

// Re-exports for advanced consumers
export { buildSidecarContext, createSidecarRouter } from './forge-service.js';
export { createAuth } from './auth.js';
export { reactLoop } from './react-engine.js';
export { mergeDefaults, validateConfig, CONFIG_DEFAULTS } from './config-schema.js';
export { getDb } from './db.js';
export { initSSE } from './sse.js';
export { VerifierRunner } from './verifier-runner.js';
export { makePromptStore } from './prompt-store.js';
export { makePreferenceStore } from './preference-store.js';
export { makeConversationStore } from './conversation-store.js';
export { makeHitlEngine } from './hitl-engine.js';
export { makeAgentRegistry, AgentRegistry } from './agent-registry.js';
