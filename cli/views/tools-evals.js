/**
 * Tools & Evals View — Table of tools with eval run counts and verifier coverage.
 */

import blessed from 'blessed';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
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

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup }) {
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
    showActionMenu(screen, rowData[idx - 1], navigate, config, openPopup, closePopup, (msg, isError) => {
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

function showActionMenu(screen, tool, navigate, config, openPopup, closePopup, setStatus) {
  const items = [
    `{cyan-fg}▸{/cyan-fg} Run evals  {#888888-fg}(uses API key from .env){/#888888-fg}`,
    `  View eval results`,
    `  View tool file`,
    `  Generate evals (AI)`,
    `  Generate verifiers (AI)`,
    `  Re-forge tool`,
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

  openPopup?.();
  menu.on('select', async (item, idx) => {
    closePopup?.();
    menu.destroy();
    screen.render();

    if (idx === 0) {
      config._evalTarget = tool.name;
      navigate('eval-run');
    } else if (idx === 1) {
      navigate('performance');
    } else if (idx === 2) {
      setStatus(`Tool file: ${config?.project?.toolsDir || 'example/tools'}/${tool.name}.tool.*`, false);
    } else if (idx === 3) {
      // Generate evals (AI)
      await generateEvalsForTool(tool, config, screen, setStatus, openPopup, closePopup);
    } else if (idx === 4) {
      // Generate verifiers (AI)
      await generateVerifiersForTool(tool, config, screen, setStatus, openPopup, closePopup);
    } else if (idx === 5) {
      // Re-forge tool
      config._forgeTarget = { toolName: tool.name, spec: null };
      navigate('forge');
    }
    // idx 6 = cancel
  });

  menu.key(['escape', 'q'], () => { closePopup?.(); menu.destroy(); screen.render(); });
  menu.focus();
  screen.render();
}

async function generateEvalsForTool(tool, config, screen, setStatus, openPopup, closePopup) {
  setStatus('Generating evals with AI…', false);

  const progressBox = blessed.box({
    parent: screen,
    border: 'line',
    top: 'center',
    left: 'center',
    width: 50,
    height: 5,
    label: ' Generating Evals ',
    tags: true,
    content: '\n  {yellow-fg}⟳ Calling AI…{/yellow-fg}'
  });
  openPopup?.();
  screen.render();

  try {
    const { resolveModelConfig } = await import('../api-client.js');
    const { generateEvals } = await import('../forge-eval-generator.js');

    // Load env
    const envPath = resolve(process.cwd(), '.env');
    const env = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }

    const modelConfig = resolveModelConfig(config, env, 'eval');
    if (!modelConfig.apiKey) {
      throw new Error('No API key found. Add one in Settings → API Keys.');
    }

    // Build a minimal spec from tool name
    const spec = { name: tool.name, description: '', triggerPhrases: [], tags: [] };

    const result = await generateEvals({
      spec,
      allTools: [],
      projectConfig: config,
      projectRoot: process.cwd(),
      modelConfig
    });

    // Write files
    mkdirSync(dirname(result.goldenPath), { recursive: true });
    writeFileSync(result.goldenPath, JSON.stringify(result.goldenCases, null, 2), 'utf-8');
    writeFileSync(result.labeledPath, JSON.stringify(result.labeledCases, null, 2), 'utf-8');

    progressBox.setContent(`\n  {green-fg}✓ Generated ${result.goldenCases.length} golden + ${result.labeledCases.length} labeled cases{/green-fg}`);
    screen.render();
    setTimeout(() => {
      closePopup?.();
      progressBox.destroy();
      screen.render();
      setStatus(`Evals written to ${result.goldenPath}`, false);
    }, 2000);

  } catch (err) {
    progressBox.setContent(`\n  {red-fg}⚠ ${err.message}{/red-fg}`);
    screen.render();
    setTimeout(() => {
      closePopup?.();
      progressBox.destroy();
      screen.render();
    }, 3000);
  }
}

async function generateVerifiersForTool(tool, config, screen, setStatus, openPopup, closePopup) {
  setStatus('Generating verifiers with AI…', false);

  const progressBox = blessed.box({
    parent: screen,
    border: 'line',
    top: 'center',
    left: 'center',
    width: 50,
    height: 5,
    label: ' Generating Verifiers ',
    tags: true,
    content: '\n  {yellow-fg}⟳ Calling AI…{/yellow-fg}'
  });
  openPopup?.();
  screen.render();

  try {
    const { resolveModelConfig } = await import('../api-client.js');
    const { generateVerifiers } = await import('../forge-verifier-generator.js');

    // Load env
    const envPath = resolve(process.cwd(), '.env');
    const env = {};
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }

    const modelConfig = resolveModelConfig(config, env, 'verifier');
    if (!modelConfig.apiKey) {
      throw new Error('No API key found. Add one in Settings → API Keys.');
    }

    const spec = { name: tool.name, description: '', tags: [] };
    const result = await generateVerifiers({
      spec,
      projectConfig: config,
      projectRoot: process.cwd(),
      modelConfig
    });

    // Write files
    for (const vf of result.verifierFiles) {
      mkdirSync(dirname(vf.path), { recursive: true });
      writeFileSync(vf.path, vf.content, 'utf-8');
    }

    progressBox.setContent(`\n  {green-fg}✓ Generated ${result.verifierFiles.length} verifier(s){/green-fg}`);
    screen.render();
    setTimeout(() => {
      closePopup?.();
      progressBox.destroy();
      screen.render();
      setStatus(`${result.verifierFiles.length} verifier(s) written`, false);
    }, 2000);

  } catch (err) {
    progressBox.setContent(`\n  {red-fg}⚠ ${err.message}{/red-fg}`);
    screen.render();
    setTimeout(() => {
      closePopup?.();
      progressBox.destroy();
      screen.render();
    }, 3000);
  }
}
