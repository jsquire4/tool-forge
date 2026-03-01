/**
 * Onboarding View — First-time setup wizard shown when no API key or no forge.config.json.
 *
 * Checklist-style screen with 3 steps:
 *   1. Add API Key (required)
 *   2. Set tools directory (optional)
 *   3. Choose model (optional, has default)
 *   → Launch Forge
 */

import blessed from 'blessed';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'forge.config.json');
const ENV_FILE = resolve(PROJECT_ROOT, '.env');

const DEFAULT_TOOLS_DIR = 'example/tools';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const ONBOARDING_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-4o-mini'
];

const DEFAULT_CONFIG = {
  project: { toolsDir: DEFAULT_TOOLS_DIR },
  models: {
    generation: DEFAULT_MODEL,
    eval: DEFAULT_MODEL,
    verifier: DEFAULT_MODEL,
    secondary: null
  },
  multiModel: {
    enabled: false,
    compareOnGenerate: false
  }
};

// ---------------------------------------------------------------------------
// Helpers (mirrored from settings.js)
// ---------------------------------------------------------------------------

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')); } catch (_) { return {}; }
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function loadEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const lines = readFileSync(ENV_FILE, 'utf-8').split('\n');
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

function saveEnv(envMap) {
  const lines = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Detect which provider key is present in envMap.
 * Returns a short label, or null if none found.
 */
function detectApiKeyProvider(envMap) {
  const keys = Object.keys(envMap);
  if (keys.some((k) => /ANTHROPIC/i.test(k))) return 'anthropic';
  if (keys.some((k) => /OPENAI/i.test(k)))    return 'openai';
  if (keys.some((k) => /GOOGLE|GEMINI/i.test(k))) return 'google';
  return null;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup, startService }) {
  // Track which steps are done: [apiKey, toolsDir, model]
  const completed = [false, false, false];

  // Step values chosen during this session
  const chosen = {
    provider: null,   // e.g. 'anthropic'
    toolsDir: null,   // e.g. 'example/tools'
    model: null       // e.g. 'claude-sonnet-4-6'
  };

  // Pre-fill from existing state
  const initialEnv = loadEnv();
  const initialProvider = detectApiKeyProvider(initialEnv);
  if (initialProvider) {
    completed[0] = true;
    chosen.provider = initialProvider;
  }

  const initialCfg = loadConfig();
  if (initialCfg.project?.toolsDir) {
    completed[1] = true;
    chosen.toolsDir = initialCfg.project.toolsDir;
  }
  if (initialCfg.models?.generation) {
    completed[2] = true;
    chosen.model = initialCfg.models.generation;
  }

  // -------------------------------------------------------------------------
  // Layout: title box + list
  // -------------------------------------------------------------------------

  const titleBox = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    content: '\n  {bold}{cyan-fg}Tool Forge{/cyan-fg} — First Time Setup{/bold}   {#555555-fg}Let\'s get you set up in 3 steps.{/#555555-fg}',
    style: { fg: 'white' }
  });

  const list = blessed.list({
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-3',
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' }
    },
    padding: { top: 0, left: 2 }
  });

  const statusBar = blessed.box({
    top: '100%-1',
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { fg: '#888888' }
  });

  content.append(titleBox);
  content.append(list);
  content.append(statusBar);

  setFooter(' {bold}↑↓{/bold} navigate  {bold}Enter{/bold} select  {bold}b{/bold} skip setup');

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function checkMark(idx) {
    return completed[idx] ? '{green-fg}✓{/green-fg}' : ' ';
  }

  function stepLabel(idx, label, detail) {
    const mark = checkMark(idx);
    const num = idx + 1;
    const detailStr = detail
      ? `  {#888888-fg}${detail}{/#888888-fg}`
      : '';
    return `  [${mark}] {bold}${num}.{/bold}  ${label}${detailStr}`;
  }

  function step1Detail() {
    if (!completed[0]) return '(required)';
    return `{green-fg}${chosen.provider} ✓{/green-fg}`;
  }

  function step2Detail() {
    if (!completed[1]) return '(optional)';
    return `{green-fg}${chosen.toolsDir}{/green-fg}`;
  }

  function step3Detail() {
    if (!completed[2]) return '(optional)';
    return `{green-fg}${chosen.model}{/green-fg}`;
  }

  function renderList() {
    const divider = `  {#444444-fg}${'─'.repeat(46)}{/#444444-fg}`;
    const launchStyle = completed[0]
      ? '{bold}{green-fg}  → Launch Forge{/green-fg}{/bold}'
      : '{#888888-fg}  → Launch Forge  {yellow-fg}(add API key first){/yellow-fg}{/#888888-fg}';

    list.setItems([
      stepLabel(0, 'Add API Key       ', step1Detail()),
      stepLabel(1, 'Set tools directory', step2Detail()),
      stepLabel(2, 'Choose model       ', step3Detail()),
      divider,
      launchStyle
    ]);
    screen.render();
  }

  renderList();

  // -------------------------------------------------------------------------
  // Step handlers
  // -------------------------------------------------------------------------

  function handleStep1() {
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 'shrink',
      width: '70%',
      top: 'center',
      left: 'center',
      label: ' Add API Key ',
      tags: true,
      keys: true
    });

    openPopup?.();
    prompt.input(
      'Enter ANTHROPIC_API_KEY (or KEY_NAME=value for other providers):',
      '',
      (err, val) => {
        closePopup?.();
        prompt.destroy();

        if (!err && val && val.trim()) {
          const input = val.trim();
          const envMap = loadEnv();
          let keyName, keyValue;

          if (input.includes('=')) {
            // KEY=value format
            const eqIdx = input.indexOf('=');
            keyName = input.slice(0, eqIdx).trim().toUpperCase();
            keyValue = input.slice(eqIdx + 1).trim();
          } else {
            // Bare value — assume ANTHROPIC_API_KEY
            keyName = 'ANTHROPIC_API_KEY';
            keyValue = input;
          }

          envMap[keyName] = keyValue;
          try {
            saveEnv(envMap);
            chosen.provider = detectApiKeyProvider(envMap) || keyName.toLowerCase().split('_')[0];
            completed[0] = true;
          } catch (err) {
            statusBar.setContent(`{red-fg}⚠ Could not save .env: ${err.message}{/red-fg}`);
            screen.render();
          }
        }

        renderList();
        list.focus();
        screen.render();
      }
    );
  }

  function handleStep2() {
    const current = chosen.toolsDir || DEFAULT_TOOLS_DIR;
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 'shrink',
      width: '70%',
      top: 'center',
      left: 'center',
      label: ' Set Tools Directory ',
      tags: true,
      keys: true
    });

    openPopup?.();
    prompt.input(
      'Path to your tools directory (relative to project root):',
      current,
      (err, val) => {
        closePopup?.();
        prompt.destroy();

        if (!err && val !== null && val !== undefined) {
          const trimmed = val.trim() || DEFAULT_TOOLS_DIR;
          const cfg = loadConfig();
          cfg.project = cfg.project || {};
          cfg.project.toolsDir = trimmed;
          try {
            saveConfig(cfg);
            config.project = config.project || {};
            config.project.toolsDir = trimmed;
            chosen.toolsDir = trimmed;    // only set if save succeeds
            completed[1] = true;           // only set if save succeeds
          } catch (err) {
            statusBar?.setContent?.(`{red-fg}⚠ Could not save config: ${err.message}{/red-fg}`);
            screen.render();
          }
        }

        renderList();
        list.focus();
        screen.render();
      }
    );
  }

  function handleStep3() {
    const current = chosen.model || DEFAULT_MODEL;

    // Mark current selection in the displayed list
    const markedItems = ONBOARDING_MODELS.map((m) =>
      m === current
        ? `  {green-fg}● ${m}{/green-fg}`
        : `    ${m}`
    );

    const popup = blessed.box({
      parent: screen,
      border: 'line',
      height: ONBOARDING_MODELS.length + 4,
      width: 44,
      top: 'center',
      left: 'center',
      label: ' Choose Model ',
      tags: true,
      style: { border: { fg: 'blue' } }
    });

    const modelList = blessed.list({
      parent: popup,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-2',
      tags: true,
      keys: true,
      vi: true,
      style: { selected: { bg: '#1a3a5c', fg: 'white' } },
      items: markedItems
    });

    openPopup?.();

    function applyModel(idx) {
      const selected = ONBOARDING_MODELS[idx];
      if (!selected) return;

      const cfg = loadConfig();
      cfg.models = cfg.models || {};
      cfg.models.generation = selected;
      try {
        saveConfig(cfg);
        config.models = config.models || {};
        config.models.generation = selected;
        chosen.model = selected;    // only set if save succeeds
        completed[2] = true;         // only set if save succeeds
      } catch (err) {
        statusBar?.setContent?.(`{red-fg}⚠ Could not save config: ${err.message}{/red-fg}`);
        screen.render();
      }

      closePopup?.();
      popup.destroy();
      renderList();
      list.focus();
      screen.render();
    }

    modelList.on('select', (item, idx) => applyModel(idx));
    modelList.key(['escape', 'b'], () => {   // CORRECT - both on focused widget
      closePopup?.();
      popup.destroy();
      renderList();
      list.focus();
      screen.render();
    });
    modelList.focus();
    screen.render();
  }

  function handleLaunch() {
    if (!completed[0]) {
      // Show error — API key is required
      const errorBox = blessed.message({
        parent: screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' Setup Required ',
        tags: true,
        keys: true,
        style: { border: { fg: 'red' } }
      });
      openPopup?.();
      errorBox.display('Please add an API key first. (Step 1)', 0, () => {
        closePopup?.();
        errorBox.destroy();
        list.focus();
        screen.render();
      });
      return;
    }

    // Write forge.config.json if it doesn't exist yet, or merge defaults
    const existingCfg = loadConfig();
    const merged = Object.assign({}, DEFAULT_CONFIG, existingCfg);

    // Ensure all required model fields exist
    merged.models = Object.assign({}, DEFAULT_CONFIG.models, existingCfg.models || {});
    merged.project = Object.assign({}, DEFAULT_CONFIG.project, existingCfg.project || {});
    merged.multiModel = Object.assign({}, DEFAULT_CONFIG.multiModel, existingCfg.multiModel || {});

    // Apply session choices
    if (chosen.toolsDir) merged.project.toolsDir = chosen.toolsDir;
    if (chosen.model)    merged.models.generation = chosen.model;

    try {
      saveConfig(merged);
    } catch (err) {
      statusBar?.setContent?.(`{red-fg}⚠ Could not save config: ${err.message}{/red-fg}`);
      screen.render();
      return;
    }

    // Reload config in-place
    Object.assign(config, merged);

    navigate('main-menu');
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  // Divider at index 3 is not selectable — skip over it
  list.on('select', (item, index) => {
    switch (index) {
      case 0: handleStep1(); break;
      case 1: handleStep2(); break;
      case 2: handleStep3(); break;
      case 3: break; // divider — ignore
      case 4: handleLaunch(); break;
    }
  });

  // 'b' skips setup and goes straight to main-menu (without writing config)
  screenKey('b', () => navigate('main-menu'));

  list.focus();
  screen.render();

  return list;
}
