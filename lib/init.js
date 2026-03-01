/**
 * Forge Init — Interactive setup wizard.
 *
 * Usage:
 *   node lib/index.js init
 *   npx forge init
 *
 * Walks through mode, API key, model, database, auth, API discovery,
 * first agent, and widget — then generates forge.config.json, .env,
 * and optionally forge-widget.html.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { mergeDefaults, validateConfig } from './config-schema.js';
import { ensureDependencyInteractive } from './dep-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Security / file helpers ──────────────────────────────────────────────────

/**
 * Reject values containing newline or null characters before writing to .env.
 * @param {*} val
 * @returns {string}
 */
export function sanitizeEnvValue(val) {
  if (typeof val !== 'string') return String(val ?? '');
  if (/[\r\n\0]/.test(val)) {
    throw new Error(`Invalid value: newline characters are not allowed in .env values`);
  }
  return val;
}

/**
 * Validate a URL is safe to fetch (no private/loopback/file addresses).
 * Throws if the URL is unsafe.
 * @param {string} rawUrl
 */
export function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Invalid URL format'); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http:// and https:// URLs are allowed');
  }
  const host = u.hostname.toLowerCase();
  // URL.hostname wraps IPv6 addresses in brackets (e.g. [fc00::1]), so strip
  // them before testing against IPv6 prefix patterns.
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  // Block private/loopback/link-local addresses
  const isPrivateIPv4 = (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host)
  );
  // ULA range fc00::/7 covers any address starting with fc or fd.
  // Use bare prefix match (no digit count) so fc::1 and fd::1 are also blocked.
  const isPrivateIPv6 = (
    bare === '::1' ||
    /^fe80:/i.test(bare) ||
    /^fc/i.test(bare) ||
    /^fd/i.test(bare)
  );
  if (isPrivateIPv4 || isPrivateIPv6) {
    throw new Error('Private, loopback, and link-local URLs are not allowed');
  }
}

/**
 * Write a file atomically via a temp file + rename.
 * @param {string} destPath
 * @param {string} content
 */
export function atomicWriteFile(destPath, content) {
  const tmp = `${destPath}.tmp.${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, destPath);
}

// ── Prompt helpers ──────────────────────────────────────────────────────────

/**
 * Prompt for a single line.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
export function ask(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (ans) => {
      resolve(ans.trim() || defaultValue);
    });
  });
}

/**
 * Numbered choice list. Returns the value from the selected option.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {{ label: string, value: * }[]} options
 * @param {number} [defaultIdx=0] - 0-based default index
 * @returns {Promise<*>}
 */
export function choose(rl, question, options, defaultIdx = 0) {
  console.log(`\n${question}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i].label}`);
  }
  return new Promise((resolve) => {
    rl.question(`Choose [1-${options.length}] (default: ${defaultIdx + 1}): `, (ans) => {
      const num = parseInt(ans.trim(), 10);
      if (num >= 1 && num <= options.length) {
        resolve(options[num - 1].value);
      } else {
        resolve(options[defaultIdx].value);
      }
    });
  });
}

/**
 * Yes/no confirmation.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {boolean} [defaultYes=true]
 * @returns {Promise<boolean>}
 */
export function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`${question} (${hint}): `, (ans) => {
      const a = ans.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

// ── Provider detection ──────────────────────────────────────────────────────

const PROVIDER_PREFIXES = [
  { prefix: 'sk-ant-', provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  { prefix: 'sk-',     provider: 'openai',    envKey: 'OPENAI_API_KEY' },
  { prefix: 'AIza',    provider: 'google',     envKey: 'GOOGLE_API_KEY' },
];

/**
 * Detect provider from API key value prefix.
 * @param {string} keyValue
 * @returns {{ provider: string, envKey: string }}
 */
export function detectProvider(keyValue) {
  for (const { prefix, provider, envKey } of PROVIDER_PREFIXES) {
    if (keyValue.startsWith(prefix)) return { provider, envKey };
  }
  return { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' };
}

// ── Model lists ─────────────────────────────────────────────────────────────

const MODEL_LISTS = {
  anthropic: [
    { label: 'claude-sonnet-4-6 (recommended)', value: 'claude-sonnet-4-6' },
    { label: 'claude-opus-4-6',                 value: 'claude-opus-4-6' },
    { label: 'claude-haiku-4-5-20251001',       value: 'claude-haiku-4-5-20251001' },
  ],
  openai: [
    { label: 'gpt-4o (recommended)', value: 'gpt-4o' },
    { label: 'gpt-4o-mini',          value: 'gpt-4o-mini' },
    { label: 'o3-mini',              value: 'o3-mini' },
  ],
  google: [
    { label: 'gemini-2.0-flash (recommended)', value: 'gemini-2.0-flash' },
    { label: 'gemini-2.5-pro-exp',             value: 'gemini-2.5-pro-exp' },
  ],
};

// ── Admin key ───────────────────────────────────────────────────────────────

/** Generate a 64-char hex admin key. */
export function generateAdminKey() {
  return crypto.randomBytes(32).toString('hex');
}

// ── .env helpers ────────────────────────────────────────────────────────────

/**
 * Load .env file into a Map-like object. Preserves insertion order.
 * @param {string} envPath
 * @returns {Record<string, string>}
 */
export function loadEnv(envPath) {
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

/**
 * Merge new entries into an existing .env file. Existing keys are preserved.
 * Returns { added: string[], skipped: string[] }.
 * @param {string} envPath
 * @param {Record<string, string>} newEntries
 * @returns {{ added: string[], skipped: string[] }}
 */
export function mergeEnvFile(envPath, newEntries) {
  const existing = loadEnv(envPath);
  const added = [];
  const skipped = [];

  // Track which keys already existed before we add new ones
  const preExistingKeys = new Set(Object.keys(existing));

  for (const [key, value] of Object.entries(newEntries)) {
    if (key in existing) {
      skipped.push(key);
    } else {
      existing[key] = value;
      added.push(key);
    }
  }

  const lines = Object.entries(existing).map(([k, v]) => {
    // Apply sanitization to newly added values
    if (!preExistingKeys.has(k)) {
      return `${k}=${sanitizeEnvValue(v)}`;
    }
    return `${k}=${v}`;
  });
  atomicWriteFile(envPath, lines.join('\n') + '\n');

  return { added, skipped };
}

// ── Widget HTML ─────────────────────────────────────────────────────────────

/**
 * Generate a standalone widget HTML file.
 * @param {string} filePath
 * @param {number} port
 * @param {string|null} agentId
 */
export function writeWidgetHtml(filePath, port, agentId) {
  const agentAttr = agentId ? ` agent="${agentId}"` : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge Chat Widget</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
  </style>
</head>
<body>

  <!-- Copy this script tag into your app's HTML -->
  <script src="http://localhost:${port}/widget/forge-chat.js"></script>

  <!-- Copy this tag where you want the chat widget to appear -->
  <forge-chat endpoint="http://localhost:${port}"${agentAttr}></forge-chat>

  <!--
    Notes:
    - The script + custom element are all you need.
    - Change "endpoint" to your production sidecar URL when deploying.
    ${agentId ? `- agent="${agentId}" routes chat to the "${agentId}" agent.` : '- Add agent="your-agent-id" to route chat to a specific agent.'}
    - The widget uses Shadow DOM — no style conflicts with your app.
  -->

</body>
</html>
`;
  atomicWriteFile(filePath, html);
}

// ── Main wizard ─────────────────────────────────────────────────────────────

const AGENT_ID_RE = /^[a-z0-9_-]+$/;

/**
 * Run the interactive init wizard.
 * @param {{ projectRoot?: string, rl?: readline.Interface }} [opts]
 */
export async function runInit(opts = {}) {
  const projectRoot = opts.projectRoot || resolve(__dirname, '..');
  const ownRl = !opts.rl;
  const rl = opts.rl || readline.createInterface({ input: process.stdin, output: process.stdout });

  const configPath = resolve(projectRoot, 'forge.config.json');
  const envPath = resolve(projectRoot, '.env');
  const widgetPath = resolve(projectRoot, 'forge-widget.html');

  const filesWritten = [];
  const envKeysAdded = [];
  const envKeysSkipped = [];

  try {
    // ── Step 1: Mode ──────────────────────────────────────────────────────
    const mode = await choose(rl, 'How will you use Forge?', [
      { label: 'Sidecar only — embed AI agent runtime in your app', value: 'sidecar' },
      { label: 'TUI + Sidecar — full dev workflow + production runtime', value: 'both' },
      { label: 'TUI only — tool development and testing', value: 'tui' },
    ], 1); // default: both

    const hasSidecar = mode === 'sidecar' || mode === 'both';

    // ── Step 2: API Key ───────────────────────────────────────────────────
    const existingEnv = loadEnv(envPath);
    const envKeys = Object.keys(existingEnv);
    const hasKey = envKeys.some(k => /ANTHROPIC|OPENAI|GOOGLE|GEMINI/i.test(k))
                || process.env.ANTHROPIC_API_KEY
                || process.env.OPENAI_API_KEY;

    let provider = 'anthropic';
    let apiKeyEnvName = null;
    let apiKeyValue = null;

    if (hasKey) {
      // Detect provider from existing key
      if (envKeys.some(k => /ANTHROPIC/i.test(k)) || process.env.ANTHROPIC_API_KEY) provider = 'anthropic';
      else if (envKeys.some(k => /OPENAI/i.test(k)) || process.env.OPENAI_API_KEY) provider = 'openai';
      else if (envKeys.some(k => /GOOGLE|GEMINI/i.test(k))) provider = 'google';
      console.log(`\nAPI key detected (${provider}). Skipping.`);
    } else {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        console.log('');
        const keyInput = await ask(rl, 'Enter your API key (or KEY_NAME=value)');
        if (!keyInput) break;
        if (keyInput.includes('=')) {
          const eqIdx = keyInput.indexOf('=');
          const candidateName = keyInput.slice(0, eqIdx).trim().toUpperCase();
          if (!/^[A-Z_][A-Z0-9_]*$/.test(candidateName)) {
            console.log('  ✗ Invalid env var name. Use only letters, digits, and underscores (e.g. MY_API_KEY=sk-...)');
            continue;
          }
          apiKeyEnvName = candidateName;
          apiKeyValue = keyInput.slice(eqIdx + 1).trim();
          // Infer provider from env name
          if (/ANTHROPIC/i.test(apiKeyEnvName)) provider = 'anthropic';
          else if (/OPENAI/i.test(apiKeyEnvName)) provider = 'openai';
          else if (/GOOGLE|GEMINI/i.test(apiKeyEnvName)) provider = 'google';
          else {
            const detected = detectProvider(apiKeyValue);
            provider = detected.provider;
          }
        } else {
          const detected = detectProvider(keyInput);
          provider = detected.provider;
          apiKeyEnvName = detected.envKey;
          apiKeyValue = keyInput;
        }
        break;
      }
    }

    // ── Step 3: Model ─────────────────────────────────────────────────────
    const modelOptions = MODEL_LISTS[provider] || MODEL_LISTS.anthropic;
    const model = await choose(rl, 'Choose your default model:', modelOptions, 0);

    // ── Step 4: Storage (sidecar modes) ────────────────────────────────────
    let dbType = 'sqlite';
    let dbUrl = null;
    let storeDbUrlInEnv = false;
    let conversationStore = 'sqlite';
    let redisUrl = null;
    let storeRedisUrlInEnv = false;

    if (hasSidecar) {
      const storageChoice = await choose(rl, 'Where should chat history be stored?', [
        { label: 'SQLite (local file, zero setup — default)', value: 'sqlite' },
        { label: 'Postgres (shared DB for dev+prod, remote access)', value: 'postgres' },
        { label: 'Redis (in-memory, fast, auto-expiry)', value: 'redis' },
      ], 0);

      if (storageChoice === 'postgres') {
        dbType = 'postgres';
        conversationStore = 'postgres';
        dbUrl = await ask(rl, 'Postgres connection URL (e.g. postgresql://user:pass@host:5432/forge)');
        storeDbUrlInEnv = await confirm(rl, 'Store connection URL in .env as DATABASE_URL?', true);
        await ensureDependencyInteractive('pg', rl);
      } else if (storageChoice === 'redis') {
        conversationStore = 'redis';
        redisUrl = await ask(rl, 'Redis URL', 'redis://localhost:6379');
        storeRedisUrlInEnv = await confirm(rl, 'Store Redis URL in .env as REDIS_URL?', true);
        await ensureDependencyInteractive('redis', rl);
      }
    }

    // ── Step 5: Auth Mode (sidecar only) ──────────────────────────────────
    let authMode = 'trust';
    let signingKeyEnvName = null;
    let signingKeyValue = null;

    if (hasSidecar) {
      authMode = await choose(rl, 'How will your app authenticate users?', [
        { label: 'Trust mode (no verification — local dev)', value: 'trust' },
        { label: 'JWT verify (HMAC-SHA256 — production)', value: 'verify' },
      ], 0);

      if (authMode === 'verify') {
        signingKeyEnvName = await ask(rl, 'Signing key env var name', 'JWT_SIGNING_KEY');
        signingKeyValue = await ask(rl, `Value for ${signingKeyEnvName} (leave empty to use trust mode instead)`);
        if (!signingKeyValue.trim()) {
          // User left empty — fall back to trust mode, don't write placeholder
          authMode = 'trust';
          signingKeyEnvName = null;
          signingKeyValue = null;
          console.log('  → Using trust mode (no JWT verification). Set auth.mode to "verify" later by adding a signing key.');
        }
      }
    }

    // ── Step 6: API Discovery (sidecar only) ─────────────────────────────
    let discoveryUrl = null;

    if (hasSidecar) {
      console.log('');
      discoveryUrl = await ask(rl, 'OpenAPI spec URL? (press Enter to skip)');
      if (discoveryUrl) {
        // Validate URL is safe before fetching
        try {
          assertSafeUrl(discoveryUrl);
        } catch (err) {
          console.log(`  ✗ Discovery URL rejected: ${err.message}`);
          discoveryUrl = null;
        }
        if (discoveryUrl) {
          // Attempt fetch with 10s timeout and 512KB response cap
          try {
            const resp = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10000) });
            const text = await resp.text();
            if (text.length > 512 * 1024) throw new Error('Response too large (max 512KB)');
            if (resp.ok) {
              const body = JSON.parse(text);
              const paths = Object.keys(body.paths || {});
              console.log(`  Found ${paths.length} path(s) in spec.`);
            } else {
              console.log(`  Warning: got HTTP ${resp.status} — saving URL anyway.`);
            }
          } catch (err) {
            console.log(`  Could not fetch spec (${err.message}) — saving URL anyway.`);
          }
        }
      } else {
        console.log('  You can add API discovery later in forge.config.json → api.discovery');
        discoveryUrl = null;
      }
    }

    // ── Step 7: First Agent (sidecar only) ───────────────────────────────
    let agent = null;

    if (hasSidecar) {
      const wantAgent = await confirm(rl, '\nCreate your first agent?', true);
      if (wantAgent) {
        let agentId = '';
        while (!AGENT_ID_RE.test(agentId)) {
          agentId = await ask(rl, 'Agent slug (lowercase, hyphens, underscores)', 'support');
          if (!AGENT_ID_RE.test(agentId)) {
            console.log('  Must match /^[a-z0-9_-]+$/. Try again.');
          }
        }
        const displayName = await ask(rl, 'Display name', agentId.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
        agent = { id: agentId, displayName, toolAllowlist: '*', isDefault: true };
      }
    }

    // ── Step 8: Widget Snippet (sidecar only) ────────────────────────────
    let writeWidget = false;

    if (hasSidecar) {
      writeWidget = await confirm(rl, 'Generate a chat widget HTML snippet?', true);
    }

    // ── Assemble config ─────────────────────────────────────────────────

    const raw = { defaultModel: model };

    // Generate adminKey value for .env (never written plaintext to config)
    const adminKeyValue = hasSidecar ? generateAdminKey() : null;

    if (hasSidecar) {
      raw.sidecar = { enabled: true, port: 8001 };
      raw.adminKey = '${FORGE_ADMIN_KEY}';
      raw.auth = { mode: authMode };
      if (authMode === 'verify') {
        raw.auth.signingKey = `\${${signingKeyEnvName}}`;
      }
      raw.database = { type: dbType };
      if (dbType === 'postgres') {
        raw.database.url = storeDbUrlInEnv ? '${DATABASE_URL}' : dbUrl;
      }
      raw.conversation = { store: conversationStore };
      if (conversationStore === 'redis') {
        raw.conversation.redis = { url: storeRedisUrlInEnv ? '${REDIS_URL}' : redisUrl };
      }
      if (discoveryUrl) {
        raw.api = { discovery: discoveryUrl };
      }
      if (agent) {
        raw.agents = [agent];
      }
    }

    // Validate
    const { valid, errors } = validateConfig(raw);
    if (!valid) {
      console.log('\nConfig validation warnings:');
      for (const e of errors) console.log(`  - ${e}`);
      const proceed = await confirm(rl, 'Proceed anyway?', true);
      if (!proceed) {
        console.log('Aborted.');
        return;
      }
    }

    const merged = mergeDefaults(raw);

    // ── Write forge.config.json ──────────────────────────────────────────

    if (existsSync(configPath)) {
      const overwrite = await confirm(rl, '\nforge.config.json already exists. Overwrite?', false);
      if (!overwrite) {
        console.log('  Skipping forge.config.json');
      } else {
        atomicWriteFile(configPath, JSON.stringify(merged, null, 2) + '\n');
        filesWritten.push('forge.config.json');
      }
    } else {
      atomicWriteFile(configPath, JSON.stringify(merged, null, 2) + '\n');
      filesWritten.push('forge.config.json');
    }

    // ── Write .env ───────────────────────────────────────────────────────

    const envEntries = {};
    if (apiKeyEnvName && apiKeyValue) {
      envEntries[apiKeyEnvName] = apiKeyValue;
    }
    if (hasSidecar && adminKeyValue) {
      envEntries.FORGE_ADMIN_KEY = adminKeyValue;
    }
    if (signingKeyEnvName && signingKeyValue) {
      envEntries[signingKeyEnvName] = signingKeyValue;
    }
    if (storeDbUrlInEnv && dbUrl) {
      envEntries.DATABASE_URL = dbUrl;
    }
    if (storeRedisUrlInEnv && redisUrl) {
      envEntries.REDIS_URL = redisUrl;
    }

    if (Object.keys(envEntries).length > 0) {
      const { added, skipped } = mergeEnvFile(envPath, envEntries);
      envKeysAdded.push(...added);
      envKeysSkipped.push(...skipped);
      filesWritten.push('.env');
    }

    // ── Write widget HTML ────────────────────────────────────────────────

    if (writeWidget) {
      if (existsSync(widgetPath)) {
        const overwrite = await confirm(rl, 'forge-widget.html already exists. Overwrite?', false);
        if (!overwrite) {
          console.log('  Skipping forge-widget.html');
        } else {
          writeWidgetHtml(widgetPath, merged.sidecar.port, agent?.id || null);
          filesWritten.push('forge-widget.html');
        }
      } else {
        writeWidgetHtml(widgetPath, merged.sidecar.port, agent?.id || null);
        filesWritten.push('forge-widget.html');
      }
    }

    // ── Summary ──────────────────────────────────────────────────────────

    const modeLabel = mode === 'sidecar' ? 'sidecar' : mode === 'both' ? 'tui + sidecar' : 'tui';
    const dbLabel = conversationStore === 'redis' ? 'redis' : dbType === 'postgres' ? 'postgres' : 'sqlite';
    const portLabel = hasSidecar ? `, port ${merged.sidecar.port}` : '';

    console.log('\n── Forge initialized ──────────────────────────────────────');
    for (const f of filesWritten) {
      if (f === 'forge.config.json') {
        console.log(`  ✓ forge.config.json  (${modeLabel}${hasSidecar ? ' + ' + dbLabel : ''}${portLabel})`);
      } else if (f === '.env') {
        const keyList = [...envKeysAdded];
        if (envKeysSkipped.length > 0) {
          keyList.push(`skipped: ${envKeysSkipped.join(', ')}`);
        }
        console.log(`  ✓ .env               (${keyList.join(', ')})`);
      } else if (f === 'forge-widget.html') {
        console.log('  ✓ forge-widget.html  (copy <script> + <forge-chat> into your app)');
      }
    }

    if (filesWritten.length === 0) {
      console.log('  (no files written)');
    }

    console.log('\n  Next steps:');
    if (hasSidecar) {
      console.log('    Start the sidecar:   npx forge-service --mode=sidecar');
    }
    if (writeWidget) {
      console.log('    Open the widget:     open forge-widget.html');
    }
    if (mode === 'both' || mode === 'tui') {
      console.log('    Build tools via TUI: npx forge');
    }
    console.log('────────────────────────────────────────────────────────────\n');

  } finally {
    if (ownRl) rl.close();
  }
}
