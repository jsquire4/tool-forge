/**
 * Main Menu View — Title banner + navigable list with color-coded inline stats.
 */

import blessed from 'blessed';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');

function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')); } catch (_) { return null; }
}
import { loadApis } from '../api-loader.js';
import { getExistingTools, getToolsWithMetadata } from '../tools-scanner.js';
import { getExistingVerifiers } from '../verifier-scanner.js';
import { inferOutputGroups, getVerifiersForGroups } from '../output-groups.js';

const MENU_ITEMS = [
  { key: 'tools-evals',        label: 'Tools & Evals',       icon: '⚙' },
  { key: 'forge',              label: 'Forge Tool',          icon: '⚒' },
  { key: 'forge-agent',        label: 'Forge Agent',         icon: '◈' },
  { key: 'endpoints',          label: 'Endpoints',           icon: '⇄' },
  { key: 'verifier-coverage',  label: 'Verifier Coverage',   icon: '✔' },
  { key: 'performance',        label: 'Performance',         icon: '▲' },
  { key: 'chat',               label: 'Chat / Test Model',   icon: '◎' },
  { key: 'settings',           label: 'Settings',            icon: '⊙' }
];

const BANNER_HEIGHT = 5;

async function buildStats(config) {
  const project = config?.project || {};
  const api = config?.api || {};
  const verification = config?.verification || {};

  const tools = getExistingTools(project);

  let endpoints = [];
  let uncovered = 0;
  try {
    endpoints = await loadApis(api);
    const toolSet = new Set(tools.map((t) => t.toLowerCase().replace(/-/g, '_')));
    uncovered = endpoints.filter((e) => {
      const name = (e.name || '').toLowerCase().replace(/-/g, '_');
      return !toolSet.has(name);
    }).length;
  } catch (_) { /* no api config */ }

  let allCovered = false;
  try {
    const toolMeta = getToolsWithMetadata(project);
    const verifiers = getExistingVerifiers(verification);
    allCovered = toolMeta.length > 0 && toolMeta.every((t) => {
      const groups = inferOutputGroups(t);
      return getVerifiersForGroups(groups).some((v) => verifiers.includes(v));
    });
  } catch (_) { /* skip */ }

  let hasEvalHistory = false;
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getEvalSummary } = await import('../db.js');
      hasEvalHistory = getEvalSummary(getDb(dbPath)).length > 0;
    }
  } catch (_) { /* sqlite not available */ }

  let generationStats = { complete: 0, inProgress: 0 };
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getToolGenerations } = await import('../db.js');
      const generations = getToolGenerations(getDb(dbPath));
      generationStats.complete = generations.filter((g) => g.status === 'complete').length;
      generationStats.inProgress = generations.filter((g) => g.status === 'in_progress').length;
    }
  } catch (_) { /* sqlite not available */ }

  const model = config?.model || 'not set';

  let chatProvider = 'no key';
  try {
    const envPath = resolve(process.cwd(), '.env');
    if (existsSync(envPath)) {
      const envText = readFileSync(envPath, 'utf-8');
      if (/ANTHROPIC_API_KEY\s*=\s*\S/.test(envText)) chatProvider = 'anthropic';
      else if (/OPENAI_API_KEY\s*=\s*\S/.test(envText)) chatProvider = 'openai';
    }
  } catch (_) { /* skip */ }

  const serviceRunning = readLock() !== null;
  return { toolsCount: tools.length, uncovered, endpointsTotal: endpoints.length, allCovered, hasEvalHistory, model, chatProvider, serviceRunning, generationStats };
}

function colorStat(text, level) {
  // level: 'good' | 'warn' | 'neutral' | 'dim'
  if (level === 'good')    return `{green-fg}${text}{/green-fg}`;
  if (level === 'warn')    return `{yellow-fg}${text}{/yellow-fg}`;
  if (level === 'neutral') return `{white-fg}${text}{/white-fg}`;
  return `{#888888-fg}${text}{/#888888-fg}`;
}

function buildItems(stats) {
  const toolsStat    = colorStat(`${stats.toolsCount} tool${stats.toolsCount !== 1 ? 's' : ''}`, stats.toolsCount > 0 ? 'good' : 'dim');
  const forgeStat    = stats.generationStats.complete > 0 || stats.generationStats.inProgress > 0
    ? colorStat(`${stats.generationStats.complete} complete`, 'good') +
      (stats.generationStats.inProgress > 0 ? '  ' + colorStat(`${stats.generationStats.inProgress} in progress`, 'warn') : '')
    : colorStat('no sessions yet', 'dim');
  const epStat       = colorStat(`${stats.endpointsTotal} total`, 'neutral') +
    (stats.uncovered > 0 ? ', ' + colorStat(`${stats.uncovered} uncovered`, 'warn') : '');
  const verifStat    = stats.allCovered ? colorStat('✓ all covered', 'good') : colorStat('⚠ gaps detected', 'warn');
  const perfStat     = stats.hasEvalHistory ? colorStat('has history', 'good') : colorStat('no history', 'dim');
  const chatStat     = stats.chatProvider !== 'no key'
    ? colorStat(`via ${stats.chatProvider}`, 'good')
    : colorStat('no api key', 'dim');
  const modelStat    = colorStat(stats.model, 'neutral');

  // Column widths: icon (2) + num (2) + label (22) + stat
  const row = (num, icon, label, stat) =>
    ` {bold}${num}{/bold}  ${icon}  {white-fg}${label.padEnd(22)}{/white-fg}${stat}`;

  const agentStat = colorStat('stage-aware chat', 'dim');

  return [
    row('1', MENU_ITEMS[0].icon, MENU_ITEMS[0].label, toolsStat),
    row('2', MENU_ITEMS[1].icon, MENU_ITEMS[1].label, forgeStat),
    row('3', MENU_ITEMS[2].icon, MENU_ITEMS[2].label, agentStat),
    row('4', MENU_ITEMS[3].icon, MENU_ITEMS[3].label, epStat),
    row('5', MENU_ITEMS[4].icon, MENU_ITEMS[4].label, verifStat),
    row('6', MENU_ITEMS[5].icon, MENU_ITEMS[5].label, perfStat),
    row('7', MENU_ITEMS[6].icon, MENU_ITEMS[6].label, chatStat),
    row('8', MENU_ITEMS[7].icon, MENU_ITEMS[7].label, modelStat)
  ];
}

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup, startService }) {
  const container = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true
  });

  let serviceRunning = false;

  // ── Title banner ──────────────────────────────────────────────────────────
  const banner = blessed.box({
    parent: container,
    top: 0,
    left: 0,
    width: '100%',
    height: BANNER_HEIGHT,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    align: 'center',
    valign: 'middle',
    content: [
      '',
      ' {bold}{cyan-fg}⚒  T O O L   F O R G E{/cyan-fg}{/bold} ',
      ' {#555555-fg}Build · Test · Verify{/#555555-fg} ',
    ].join('\n')
  });

  // ── Divider between banner and list ───────────────────────────────────────
  const divider = blessed.box({
    parent: container,
    top: BANNER_HEIGHT,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: '{#333333-fg}' + '─'.repeat(screen.width || 200) + '{/#333333-fg}'
  });

  // ── Service notice bar (1 row, shown when service is not running) ─────────
  const noticeBar = blessed.box({
    parent: container,
    top: BANNER_HEIGHT + 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true
  });

  // ── Menu list ─────────────────────────────────────────────────────────────
  const list = blessed.list({
    parent: container,
    top: BANNER_HEIGHT + 2,
    left: 2,
    width: '100%-4',
    height: `100%-${BANNER_HEIGHT + 4}`,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: '#1a3a5c', bold: true },
      item: { fg: 'white' }
    }
  });

  list.on('select', (item, index) => {
    const target = MENU_ITEMS[index];
    if (target) navigate(target.key);
  });

  list.key(['1', '2', '3', '4', '5', '6', '7', '8'], (ch) => {
    const idx = parseInt(ch, 10) - 1;
    if (MENU_ITEMS[idx]) navigate(MENU_ITEMS[idx].key);
  });

  // ── s = toggle service (start / stop) ───────────────────────────────────
  screenKey('s', () => {
    if (serviceRunning) {
      const lock = readLock();
      if (lock?.pid) {
        try { process.kill(lock.pid); } catch (_) { /* already dead */ }
      }
      try { unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
      serviceRunning = false;
      lastStatsJson = ''; // force next refresh to re-render
    } else {
      startService?.();
    }
  });

  setFooter(
    ' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}Enter{/cyan-fg} select' +
    '  {cyan-fg}1-8{/cyan-fg} jump  {cyan-fg}s{/cyan-fg} service  {cyan-fg}q{/cyan-fg} quit'
  );

  let lastStatsJson = '';

  container.refresh = async () => {
    try {
      const stats = await buildStats(config);
      const statsJson = JSON.stringify(stats);
      if (statsJson === lastStatsJson) return; // no change — skip render
      lastStatsJson = statsJson;

      serviceRunning = stats.serviceRunning;
      list.setItems(buildItems(stats));

      if (!serviceRunning) {
        noticeBar.setContent(
          ' {yellow-fg}⚡ Service stopped{/yellow-fg}' +
          '  {cyan-fg}s{/cyan-fg} {#888888-fg}to start{/#888888-fg}'
        );
      } else {
        noticeBar.setContent(
          ' {green-fg}⚡ Service running{/green-fg}' +
          '  {cyan-fg}s{/cyan-fg} {#888888-fg}to stop{/#888888-fg}'
        );
      }
    } catch (_) {
      list.setItems(MENU_ITEMS.map((m, i) => ` ${i + 1}  ${m.icon}  ${m.label}`));
    }
    screen.render();
  };

  container.refresh();
  list.focus();

  return container;
}

