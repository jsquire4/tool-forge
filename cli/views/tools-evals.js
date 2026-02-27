/**
 * Tools & Evals View — Table of tools with eval run counts and verifier coverage.
 */

import blessed from 'blessed';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { getToolsWithMetadata } from '../tools-scanner.js';
import { getExistingVerifiers } from '../verifier-scanner.js';
import { inferOutputGroups, getVerifiersForGroups } from '../output-groups.js';

async function loadData(config) {
  const project = config?.project || {};
  const verification = config?.verification || {};

  const tools = getToolsWithMetadata(project);
  const verifiers = getExistingVerifiers(verification);

  let evalMap = {};
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getEvalSummary } = await import('../db.js');
      const db = getDb(dbPath);
      const summary = getEvalSummary(db);
      evalMap = Object.fromEntries(summary.map((r) => [r.tool_name, r]));
    }
  } catch (_) { /* sqlite not available */ }

  return tools.map((t) => {
    const groups = inferOutputGroups(t);
    const covering = getVerifiersForGroups(groups).filter((v) => verifiers.includes(v));
    const evalRow = evalMap[t.name];
    return {
      name: t.name,
      category: (t.tags || []).join(',') || '—',
      status: 'active',
      evalRuns: evalRow ? String(evalRow.total_cases) : '0',
      verifiers: covering.length > 0 ? covering.join(', ') : '—'
    };
  });
}

export function createView({ screen, content, config, navigate, setFooter, screenKey }) {
  const container = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true
  });

  const table = blessed.listtable({
    parent: container,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-1',
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    border: { type: 'line' },
    align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: '#1a3a5c', fg: 'white' } }
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

  setFooter(' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}Enter{/cyan-fg} actions  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back');

  let rowData = [];

  table.key('enter', () => {
    const idx = table.selected;
    if (idx < 1 || !rowData[idx - 1]) return;
    showActionMenu(screen, rowData[idx - 1], navigate, config, (msg, isError) => {
      statusBar.setContent(isError ? ` {red-fg}${msg}{/red-fg}` : ` {green-fg}${msg}{/green-fg}`);
      screen.render();
    });
  });

  container.refresh = async () => {
    try {
      rowData = await loadData(config);
      const headers = ['Name', 'Category', 'Status', 'Eval Cases', 'Verifiers'];
      const rows = rowData.map((r) => [r.name, r.category, r.status, r.evalRuns, r.verifiers]);
      table.setData([headers, ...rows]);
    } catch (err) {
      table.setData([['Name', 'Category', 'Status', 'Eval Cases', 'Verifiers'], ['Error loading: ' + err.message, '', '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

function showActionMenu(screen, tool, navigate, config, setStatus) {
  const items = [
    `{cyan-fg}▸{/cyan-fg} Run evals  {#888888-fg}(uses API key from .env){/#888888-fg}`,
    `  View eval results`,
    `  View tool file`,
    `  — Cancel —`
  ];

  const menu = blessed.list({
    parent: screen,
    border: 'line',
    height: items.length + 4,
    width: 46,
    top: 'center',
    left: 'center',
    label: ` ⚙ ${tool.name} `,
    tags: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: 'blue' },
      selected: { bg: '#1a3a5c', fg: 'white' }
    },
    items
  });

  menu.on('select', async (item, idx) => {
    menu.destroy();
    screen.render();

    if (idx === 0) {
      // Run evals locally — no forge service needed
      config._evalTarget = tool.name;
      navigate('eval-run');
    } else if (idx === 1) {
      navigate('performance');
    } else if (idx === 2) {
      // No-op for now — could open tool file path in a scrollable box
      setStatus(`Tool file: ${config?.project?.toolsDir || 'example/tools'}/${tool.name}.tool.*`, false);
    }
    // idx 3 = cancel, do nothing
  });

  menu.key(['escape', 'q'], () => { menu.destroy(); screen.render(); });
  menu.focus();
  screen.render();
}

export async function refresh(viewBox, config) {
  if (viewBox.refresh) await viewBox.refresh();
}
