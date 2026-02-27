/**
 * Settings View — Model selector, system prompt editor, forge skill prompt, .env manager.
 */

import blessed from 'blessed';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'forge.config.json');
const ENV_FILE = resolve(PROJECT_ROOT, '.env');
const SKILL_FILE = resolve(PROJECT_ROOT, 'skills/forge-tool/SKILL.md');

const CLAUDE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001'
];

const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini'
];

const GOOGLE_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.5-pro-exp'
];

/**
 * Build the model list based on which API keys are present in .env.
 * Always includes Claude models (forge-tool always uses Claude).
 * Adds provider sections when matching keys are detected.
 * Always ends with a "Custom..." entry.
 */
function buildModelList(envMap) {
  const sections = [
    { header: '── Anthropic (forge-tool) ──────────────', models: CLAUDE_MODELS }
  ];

  const hasOpenAI  = Object.keys(envMap).some((k) => /OPENAI/i.test(k));
  const hasGoogle  = Object.keys(envMap).some((k) => /GOOGLE|GEMINI/i.test(k));

  if (hasOpenAI)  sections.push({ header: '── OpenAI ──────────────────────────────', models: OPENAI_MODELS });
  if (hasGoogle)  sections.push({ header: '── Google ──────────────────────────────', models: GOOGLE_MODELS });

  // Flat list with divider labels (not selectable) interleaved
  const items = [];   // display strings
  const values = [];  // corresponding model strings (null for divider rows)

  for (const section of sections) {
    items.push(`{#555555-fg}${section.header}{/#555555-fg}`);
    values.push(null); // divider — not selectable
    for (const m of section.models) {
      items.push(m);
      values.push(m);
    }
  }

  items.push('{#555555-fg}────────────────────────────────────────{/#555555-fg}');
  values.push(null);
  items.push('  Custom model...');
  values.push('__custom__');

  return { items, values };
}

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

function maskValue(val) {
  if (!val || val.length <= 4) return '****';
  return val.slice(0, 3) + '****';
}

export function createView({ screen, content, config, navigate, setFooter, screenKey }) {
  const list = blessed.list({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' }
    },
    padding: { top: 1, left: 2 }
  });

  setFooter(' {bold}↑↓{/bold} navigate  {bold}Enter{/bold} select section  {bold}r{/bold} refresh  {bold}b{/bold} back');

  list.on('select', (item, index) => {
    switch (index) {
      case 0: showModelSelector(screen, config); break;
      case 1: showPromptEditor(screen, config, 'agent'); break;
      case 2: showPromptEditor(screen, config, 'skill'); break;
      case 3: showEnvManager(screen, config); break;
    }
  });

  list.refresh = () => {
    const cfg = loadConfig();
    const envMap = loadEnv();
    const envCount = Object.keys(envMap).length;

    const systemPromptStatus = cfg.systemPromptPath
      ? `{green-fg}${cfg.systemPromptPath}{/green-fg}`
      : '{#888888-fg}not configured{/#888888-fg}';

    const skillStatus = existsSync(SKILL_FILE)
      ? '{green-fg}skills/forge-tool/SKILL.md{/green-fg}'
      : '{red-fg}not found{/red-fg}';

    const modelDisplay = cfg.model
      ? `{cyan-fg}${cfg.model}{/cyan-fg}`
      : '{yellow-fg}not set{/yellow-fg}';

    // Detect which API providers have keys
    const providers = [];
    if (Object.keys(envMap).some((k) => /ANTHROPIC/i.test(k))) providers.push('{green-fg}Anthropic{/green-fg}');
    if (Object.keys(envMap).some((k) => /OPENAI/i.test(k)))    providers.push('{green-fg}OpenAI{/green-fg}');
    if (Object.keys(envMap).some((k) => /GOOGLE|GEMINI/i.test(k))) providers.push('{green-fg}Google{/green-fg}');
    const keysSummary = envCount === 0
      ? '{#888888-fg}no keys{/#888888-fg}'
      : `${envCount} key(s)${providers.length ? '  ' + providers.join(' ') : ''}`;

    const row = (num, label, val) =>
      `  {bold}${num}.{/bold} {white-fg}${label.padEnd(22)}{/white-fg}${val}`;

    list.setItems([
      row('1', 'Model', modelDisplay),
      row('2', 'Agent System Prompt', systemPromptStatus),
      row('3', 'Forge Skill Prompt', skillStatus),
      row('4', 'API Keys / Secrets', keysSummary)
    ]);
    screen.render();
  };

  list.refresh();
  list.focus();
  return list;
}

function showModelSelector(screen, config) {
  const cfg = loadConfig();
  const current = cfg.model || 'claude-sonnet-4-6';
  const envMap = loadEnv();
  const { items, values } = buildModelList(envMap);

  // Mark current selection
  const markedItems = items.map((label, i) => {
    const val = values[i];
    if (!val || val === '__custom__') return `  ${label}`;
    return val === current
      ? `  {green-fg}● ${val}{/green-fg}`
      : `    ${val}`;
  });

  const noteHeight = 2;
  const listHeight = Math.min(items.length + noteHeight + 4, 24);

  const popup = blessed.box({
    parent: screen,
    border: 'line',
    height: listHeight,
    width: 54,
    top: 'center',
    left: 'center',
    label: ' Select Model ',
    tags: true,
    style: { border: { fg: 'blue' } }
  });

  // Note about what this field controls
  blessed.box({
    parent: popup,
    top: 0,
    left: 1,
    width: '100%-2',
    height: 1,
    tags: true,
    content: '{#888888-fg}Controls which model forge-tool uses (Claude models recommended){/#888888-fg}'
  });

  const list = blessed.list({
    parent: popup,
    top: noteHeight,
    left: 0,
    width: '100%',
    height: listHeight - noteHeight - 2,
    tags: true,
    keys: true,
    vi: true,
    style: { selected: { bg: '#1a3a5c', fg: 'white' } },
    items: markedItems
  });

  function applySelection(idx) {
    const val = values[idx];
    if (val === null) return; // divider row — skip
    if (val === '__custom__') {
      popup.destroy();
      screen.render();
      const prompt = blessed.prompt({
        parent: screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' Custom Model Name ',
        tags: true,
        keys: true
      });
      prompt.input('Enter model ID (e.g. gpt-4o, gemini-2.0-flash):', current, (err, val) => {
        if (!err && val && val.trim()) {
          cfg.model = val.trim();
          saveConfig(cfg);
          config.model = cfg.model;
        }
        screen.render();
      });
      return;
    }
    cfg.model = val;
    saveConfig(cfg);
    config.model = val;
    popup.destroy();
    screen.render();
  }

  list.on('select', (item, idx) => applySelection(idx));
  list.key(['escape', 'b'], () => { popup.destroy(); screen.render(); });
  list.focus();
  screen.render();
}

function showPromptEditor(screen, config, type) {
  const cfg = loadConfig();
  let filePath, label;

  if (type === 'agent') {
    filePath = cfg.systemPromptPath ? resolve(PROJECT_ROOT, cfg.systemPromptPath) : null;
    label = ' Agent System Prompt ';
  } else {
    filePath = SKILL_FILE;
    label = ' Forge Skill Prompt ';
  }

  let content = '';
  if (filePath && existsSync(filePath)) {
    try { content = readFileSync(filePath, 'utf-8'); } catch (_) { content = '(could not read file)'; }
  } else if (type === 'agent' && !cfg.systemPromptPath) {
    content = '(systemPromptPath not set in forge.config.json)';
  } else {
    content = '(file not found: ' + filePath + ')';
  }

  const box = blessed.scrollablebox({
    parent: screen,
    border: 'line',
    top: 1,
    left: 2,
    right: 2,
    bottom: 3,
    label,
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    content,
    scrollbar: { ch: '│', style: { fg: 'white' } }
  });

  const helpBar = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: ' {bold}e{/bold} edit in $EDITOR  {bold}p{/bold} change path  {bold}Escape{/bold} close',
    style: { bg: 'black', fg: 'white' }
  });

  box.key('e', async () => {
    if (!filePath) return;
    const editor = process.env.EDITOR || 'vi';
    const { spawn } = await import('child_process');
    screen.program.disableMouse();
    screen.program.normalBuffer();
    const child = spawn(editor, [filePath], { stdio: 'inherit' });
    child.on('exit', () => {
      screen.program.alternateBuffer();
      screen.program.enableMouse();
      screen.render();
    });
  });

  box.key('p', () => {
    if (type !== 'agent') return; // Only agent path is changeable
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 'shrink',
      width: 'half',
      top: 'center',
      left: 'center',
      label: ' Set System Prompt Path ',
      tags: true,
      keys: true
    });
    prompt.input('Enter path to system prompt file:', cfg.systemPromptPath || '', (err, val) => {
      if (!err && val) {
        cfg.systemPromptPath = val;
        saveConfig(cfg);
        config.systemPromptPath = val;
      }
    });
  });

  box.key(['escape', 'b', 'q'], () => {
    box.destroy();
    helpBar.destroy();
    screen.render();
  });

  box.focus();
  screen.render();
}

function showEnvManager(screen, config) {
  let envMap = loadEnv();
  let unsaved = false;

  const container = blessed.box({
    parent: screen,
    border: 'line',
    top: 1,
    left: 2,
    right: 2,
    bottom: 3,
    label: ' API Keys / Secrets ',
    tags: true
  });

  const table = blessed.listtable({
    parent: container,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-2',
    tags: true,
    keys: true,
    vi: true,
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: 'blue', fg: 'white' } }
    },
    pad: 1
  });

  const statusBar = blessed.box({
    parent: container,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true
  });

  const helpBar = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: ' {bold}Enter{/bold} edit  {bold}n{/bold} new key  {bold}d{/bold} delete  {bold}s{/bold} save  {bold}Escape{/bold} close',
    style: { bg: 'black', fg: 'white' }
  });

  function renderTable() {
    const entries = Object.entries(envMap);
    if (entries.length === 0) {
      table.setData([['Key', 'Value'], ['(no keys)', '']]);
    } else {
      table.setData([['Key', 'Value'], ...entries.map(([k, v]) => [k, maskValue(v)])]);
    }
    statusBar.setContent(unsaved ? ' {yellow-fg}⚠ Unsaved changes — press s to save{/yellow-fg}' : ' {green-fg}Saved{/green-fg}');
    screen.render();
  }

  renderTable();

  table.key('enter', () => {
    const idx = table.selected;
    if (idx < 1) return;
    const entries = Object.entries(envMap);
    if (!entries[idx - 1]) return;
    const [key, currentVal] = entries[idx - 1];

    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 'shrink',
      width: 'half',
      top: 'center',
      left: 'center',
      label: ` Edit ${key} `,
      tags: true,
      keys: true
    });
    prompt.input(`New value for ${key}:`, currentVal, (err, val) => {
      if (!err && val !== null && val !== undefined) {
        envMap[key] = val;
        unsaved = true;
        renderTable();
      }
    });
  });

  table.key('n', () => {
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 'shrink',
      width: 'half',
      top: 'center',
      left: 'center',
      label: ' New Key ',
      tags: true,
      keys: true
    });
    prompt.input('Key name:', '', (err, key) => {
      if (!err && key) {
        const prompt2 = blessed.prompt({
          parent: screen,
          border: 'line',
          height: 'shrink',
          width: 'half',
          top: 'center',
          left: 'center',
          label: ` Value for ${key} `,
          tags: true,
          keys: true
        });
        prompt2.input('Value:', '', (err2, val) => {
          if (!err2) {
            envMap[key] = val || '';
            unsaved = true;
            renderTable();
          }
        });
      }
    });
  });

  table.key('d', () => {
    const idx = table.selected;
    if (idx < 1) return;
    const entries = Object.entries(envMap);
    if (!entries[idx - 1]) return;
    const [key] = entries[idx - 1];
    delete envMap[key];
    unsaved = true;
    renderTable();
  });

  table.key('s', () => {
    saveEnv(envMap);
    unsaved = false;
    renderTable();
  });

  function closeEnvManager() {
    if (unsaved) {
      const confirm = blessed.question({
        parent: screen,
        border: 'line',
        height: 'shrink',
        width: 'half',
        top: 'center',
        left: 'center',
        label: ' Discard Changes? ',
        tags: true,
        keys: true
      });
      confirm.ask('Discard unsaved changes? (y/n)', (err, answer) => {
        if (!err && /^y/i.test(answer)) {
          container.destroy();
          helpBar.destroy();
          screen.render();
        }
      });
    } else {
      container.destroy();
      helpBar.destroy();
      screen.render();
    }
  }

  container.key(['escape'], closeEnvManager);
  table.key(['escape'], closeEnvManager);

  table.focus();
  screen.render();
}

export async function refresh(viewBox, config) {
  if (viewBox.refresh) await viewBox.refresh();
}
