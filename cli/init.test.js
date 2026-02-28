import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ask, choose, confirm,
  detectProvider, generateAdminKey,
  loadEnv, mergeEnvFile,
  writeWidgetHtml, runInit,
} from './init.js';

// ── Mock readline ───────────────────────────────────────────────────────────

/** Build a mock rl that answers questions from a queue of responses. */
function mockRl(responses) {
  const queue = [...responses];
  return {
    question(_prompt, cb) { cb(queue.shift() ?? ''); },
    close() {},
  };
}

// ── Temp dir helper ─────────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'forge-init-'));
}

// ── Unit tests ──────────────────────────────────────────────────────────────

describe('init — unit helpers', () => {
  describe('detectProvider', () => {
    it('detects anthropic from sk-ant- prefix', () => {
      const r = detectProvider('sk-ant-abc123');
      expect(r.provider).toBe('anthropic');
      expect(r.envKey).toBe('ANTHROPIC_API_KEY');
    });

    it('detects openai from sk- prefix (non-ant)', () => {
      const r = detectProvider('sk-proj-abc123');
      expect(r.provider).toBe('openai');
      expect(r.envKey).toBe('OPENAI_API_KEY');
    });

    it('detects google from AIza prefix', () => {
      const r = detectProvider('AIzaSyAbc123');
      expect(r.provider).toBe('google');
      expect(r.envKey).toBe('GOOGLE_API_KEY');
    });

    it('defaults to anthropic for unknown prefix', () => {
      const r = detectProvider('some-random-key');
      expect(r.provider).toBe('anthropic');
      expect(r.envKey).toBe('ANTHROPIC_API_KEY');
    });
  });

  describe('generateAdminKey', () => {
    it('returns 64-char hex string', () => {
      const key = generateAdminKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates unique keys', () => {
      const a = generateAdminKey();
      const b = generateAdminKey();
      expect(a).not.toBe(b);
    });
  });

  describe('ask / choose / confirm', () => {
    it('ask returns trimmed input or default', async () => {
      expect(await ask(mockRl(['hello']), 'Q')).toBe('hello');
      expect(await ask(mockRl(['']), 'Q', 'def')).toBe('def');
      expect(await ask(mockRl(['  spaced  ']), 'Q')).toBe('spaced');
    });

    it('choose returns selected option value', async () => {
      const opts = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ];
      expect(await choose(mockRl(['2']), 'Pick', opts, 0)).toBe('b');
      expect(await choose(mockRl(['']), 'Pick', opts, 0)).toBe('a'); // default
      expect(await choose(mockRl(['99']), 'Pick', opts, 1)).toBe('b'); // out-of-range → default
    });

    it('confirm returns boolean', async () => {
      expect(await confirm(mockRl(['y']), 'Ok?', true)).toBe(true);
      expect(await confirm(mockRl(['n']), 'Ok?', true)).toBe(false);
      expect(await confirm(mockRl(['']), 'Ok?', true)).toBe(true);
      expect(await confirm(mockRl(['']), 'Ok?', false)).toBe(false);
      expect(await confirm(mockRl(['yes']), 'Ok?', false)).toBe(true);
    });
  });

  describe('loadEnv / mergeEnvFile', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTmpDir(); });

    it('loadEnv returns empty object for missing file', () => {
      expect(loadEnv(join(tmpDir, '.env'))).toEqual({});
    });

    it('loadEnv parses key=value and strips quotes', () => {
      const envPath = join(tmpDir, '.env');
      writeFileSync(envPath, 'FOO=bar\nBAZ="quoted"\n# comment\nEMPTY=\n', 'utf-8');
      const env = loadEnv(envPath);
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('quoted');
      expect(env.EMPTY).toBe('');
    });

    it('mergeEnvFile preserves existing keys and adds new ones', () => {
      const envPath = join(tmpDir, '.env');
      writeFileSync(envPath, 'EXISTING=keep\n', 'utf-8');

      const { added, skipped } = mergeEnvFile(envPath, {
        EXISTING: 'overwrite-attempt',
        NEW_KEY: 'new-value',
      });

      expect(added).toEqual(['NEW_KEY']);
      expect(skipped).toEqual(['EXISTING']);

      const content = readFileSync(envPath, 'utf-8');
      expect(content).toContain('EXISTING=keep');
      expect(content).toContain('NEW_KEY=new-value');
      expect(content).not.toContain('overwrite-attempt');
    });

    it('mergeEnvFile creates file if missing', () => {
      const envPath = join(tmpDir, '.env-new');
      mergeEnvFile(envPath, { KEY: 'val' });
      expect(existsSync(envPath)).toBe(true);
      expect(readFileSync(envPath, 'utf-8')).toContain('KEY=val');
    });
  });

  describe('writeWidgetHtml', () => {
    it('contains correct port and endpoint', () => {
      const tmpDir = makeTmpDir();
      const path = join(tmpDir, 'widget.html');
      writeWidgetHtml(path, 9090, null);

      const html = readFileSync(path, 'utf-8');
      expect(html).toContain('localhost:9090');
      expect(html).toContain('endpoint="http://localhost:9090"');
      expect(html).toContain('<forge-chat');
      expect(html).not.toMatch(/<forge-chat[^>]+agent="/);

    });

    it('includes agent attribute when provided', () => {
      const tmpDir = makeTmpDir();
      const path = join(tmpDir, 'widget.html');
      writeWidgetHtml(path, 8001, 'support');

      const html = readFileSync(path, 'utf-8');
      expect(html).toContain('agent="support"');
    });
  });
});

// ── Config assembly tests ───────────────────────────────────────────────────

describe('init — config assembly via validateConfig', () => {
  it('sidecar config passes validation', async () => {
    const { validateConfig } = await import('./config-schema.js');
    const raw = {
      defaultModel: 'claude-sonnet-4-6',
      sidecar: { enabled: true, port: 8001 },
      auth: { mode: 'trust' },
      agents: [{ id: 'support', displayName: 'Support' }],
    };
    const { valid, errors } = validateConfig(raw);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('TUI-only config passes validation', async () => {
    const { validateConfig } = await import('./config-schema.js');
    const raw = { defaultModel: 'gpt-4o' };
    const { valid } = validateConfig(raw);
    expect(valid).toBe(true);
  });

  it('postgres config with database section passes through mergeDefaults', async () => {
    const { mergeDefaults } = await import('./config-schema.js');
    const raw = {
      defaultModel: 'claude-sonnet-4-6',
      database: { type: 'postgres', url: '${DATABASE_URL}' },
    };
    const merged = mergeDefaults(raw);
    expect(merged.database.type).toBe('postgres');
    expect(merged.database.url).toBe('${DATABASE_URL}');
    expect(merged.defaultModel).toBe('claude-sonnet-4-6');
  });
});

// ── E2E integration tests ───────────────────────────────────────────────────

describe('init — E2E flows', () => {
  let tmpDir;
  let savedAnthropicKey, savedOpenaiKey;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Clear env keys so the wizard doesn't auto-skip the API key step
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    savedOpenaiKey = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    // Restore env keys
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (savedOpenaiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenaiKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it('E2E: sidecar + sqlite — generates config, env, widget', async () => {
    // Answers: mode=both, key=sk-ant-test123, model=1 (default), db=sqlite,
    // auth=trust, discovery=skip, agent=yes id=support name=Support,
    // widget=yes
    const rl = mockRl([
      '2',           // mode: both
      'sk-ant-test123', // api key
      '1',           // model: claude-sonnet-4-6
      '1',           // db: sqlite
      '1',           // auth: trust
      '',            // discovery: skip
      'y',           // create agent: yes
      'support',     // agent id
      'Support Bot', // display name
      'y',           // widget: yes
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    // Config written
    const configPath = join(tmpDir, 'forge.config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.sidecar.enabled).toBe(true);
    expect(config.sidecar.port).toBe(8001);
    expect(config.defaultModel).toBe('claude-sonnet-4-6');
    expect(config.auth.mode).toBe('trust');
    expect(config.adminKey).toBeTruthy();
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('support');
    expect(config.database.type).toBe('sqlite');

    // .env written
    const envPath = join(tmpDir, '.env');
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-test123');
    expect(envContent).toContain('FORGE_ADMIN_KEY=');

    // Widget written
    const widgetPath = join(tmpDir, 'forge-widget.html');
    expect(existsSync(widgetPath)).toBe(true);
    const widgetHtml = readFileSync(widgetPath, 'utf-8');
    expect(widgetHtml).toContain('agent="support"');
    expect(widgetHtml).toContain('localhost:8001');
  });

  it('E2E: sidecar + postgres — DATABASE_URL in env, database.type in config', async () => {
    const rl = mockRl([
      '1',           // mode: sidecar
      'sk-ant-pg123',
      '1',           // model
      '2',           // db: postgres
      'postgresql://u:p@localhost:5432/forge', // db url
      'y',           // store in .env
      '1',           // auth: trust
      '',            // discovery: skip
      'n',           // no agent
      'n',           // no widget
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    const config = JSON.parse(readFileSync(join(tmpDir, 'forge.config.json'), 'utf-8'));
    expect(config.database.type).toBe('postgres');
    expect(config.database.url).toBe('${DATABASE_URL}');

    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('DATABASE_URL=postgresql://u:p@localhost:5432/forge');
  });

  it('E2E: TUI-only — only config + env, no widget', async () => {
    const rl = mockRl([
      '3',           // mode: tui
      'sk-ant-tui1',
      '1',           // model
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    const config = JSON.parse(readFileSync(join(tmpDir, 'forge.config.json'), 'utf-8'));
    expect(config.defaultModel).toBe('claude-sonnet-4-6');
    expect(config.sidecar).toEqual({ enabled: false, port: 8001 }); // defaults
    expect(config.adminKey).toBeNull(); // default — not set for TUI-only

    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-tui1');
    expect(envContent).not.toContain('FORGE_ADMIN_KEY');

    // No widget
    expect(existsSync(join(tmpDir, 'forge-widget.html'))).toBe(false);
  });

  it('preserves existing .env keys during init', async () => {
    // Pre-create .env with existing key
    writeFileSync(join(tmpDir, '.env'), 'MY_SECRET=keep-this\n', 'utf-8');

    const rl = mockRl([
      '3',           // tui
      'sk-ant-merge1',
      '1',           // model
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('MY_SECRET=keep-this');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-merge1');
  });

  it('overwrite protection — skips config when user declines', async () => {
    // Pre-create forge.config.json
    writeFileSync(join(tmpDir, 'forge.config.json'), '{"existing":true}\n', 'utf-8');

    const rl = mockRl([
      '3',           // tui
      'sk-ant-skip1',
      '1',           // model
      'n',           // don't overwrite config
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    // Config should still have original content
    const config = JSON.parse(readFileSync(join(tmpDir, 'forge.config.json'), 'utf-8'));
    expect(config.existing).toBe(true);
  });

  it('KEY_NAME=value format in API key prompt', async () => {
    const rl = mockRl([
      '3',           // tui
      'OPENAI_API_KEY=sk-proj-mykey',
      '1',           // model (gpt-4o since openai detected)
    ]);

    await runInit({ projectRoot: tmpDir, rl });

    const envContent = readFileSync(join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('OPENAI_API_KEY=sk-proj-mykey');

    const config = JSON.parse(readFileSync(join(tmpDir, 'forge.config.json'), 'utf-8'));
    expect(config.defaultModel).toBe('gpt-4o');
  });
});
