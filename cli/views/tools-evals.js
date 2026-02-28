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
  let registryMap = {};
  let driftMap = {};
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getEvalSummary, getAllToolRegistry, getDriftAlerts } = await import('../db.js');
      const db = getDb(dbPath);
      const summary = getEvalSummary(db);
      evalMap = Object.fromEntries(summary.map((r) => [r.tool_name, r]));
      const registry = getAllToolRegistry(db);
      registryMap = Object.fromEntries(registry.map((r) => [r.tool_name, r]));
      const alerts = getDriftAlerts(db, null);
      for (const a of alerts) {
        driftMap[a.tool_name] = a;
      }
    }
  } catch (err) {
    // DB unavailable or schema mismatch — tools still display, just without eval/registry data
    // DB unavailable or schema mismatch — tools still display without eval/registry data
  }

  return tools.map((t) => {
    const groups = inferOutputGroups(t);
    const covering = getVerifiersForGroups(groups).filter((v) => verifiers.includes(v));
    const evalRow = evalMap[t.name];
    const regRow = registryMap[t.name];
    const hasDrift = !!driftMap[t.name];
    const lifecycle = regRow?.lifecycle_state || 'candidate';
    const passRate = evalRow && evalRow.total_cases > 0
      ? `${Math.round((evalRow.passed / evalRow.total_cases) * 100)}%`
      : '—';
    return {
      name: t.name,
      category: (t.tags || []).join(',') || '—',
      lifecycle,
      passRate,
      hasDrift,
      evalRuns: evalRow ? String(evalRow.total_cases) : '0',
      verifiers: covering.length > 0 ? covering.join(', ') : '—',
      _regRow: regRow,
      _driftAlert: driftMap[t.name] || null
    };
  });
}

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup, startService }) {
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
      const headers = ['Name', 'Category', 'Lifecycle', 'Pass Rate', 'Drift'];
      const rows = rowData.map((r) => {
        const lifecycleBadge = lifecycleBadgeFor(r.lifecycle);
        const driftBadge = r.hasDrift ? '{red-fg}⚠ drift{/red-fg}' : '{#555555-fg}—{/#555555-fg}';
        return [r.name, r.category, lifecycleBadge, r.passRate, driftBadge];
      });
      table.setData([headers, ...rows]);
    } catch (err) {
      table.setData([['Name', 'Category', 'Lifecycle', 'Pass Rate', 'Drift'], ['Error loading: ' + err.message, '', '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

function lifecycleBadgeFor(state) {
  switch (state) {
    case 'promoted':  return '{green-fg}promoted{/green-fg}';
    case 'flagged':   return '{yellow-fg}flagged{/yellow-fg}';
    case 'retired':   return '{#555555-fg}retired{/#555555-fg}';
    case 'swapped':   return '{#555555-fg}swapped{/#555555-fg}';
    default:          return '{#888888-fg}candidate{/#888888-fg}';
  }
}

function showActionMenu(screen, tool, navigate, config, openPopup, closePopup, setStatus) {
  const items = [
    `{cyan-fg}▸{/cyan-fg} Run evals  {#888888-fg}(uses API key from .env){/#888888-fg}`,
    `  Compare models`,
    `  View eval results`,
    `  View tool file`,
    `  Generate evals (AI)`,
    `  Generate verifiers (AI)`,
    `  Re-forge tool`,
    `  Promote to registry`,
    `  View drift report`,
    `  Mediate (fast-track)`,
    `  — Cancel —`
  ];

  const menu = blessed.list({
    parent: screen,
    border: 'line',
    height: items.length + 4,
    width: 54,
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
      // Compare models
      await compareModelsForTool(tool, config, screen, setStatus, navigate, openPopup, closePopup);
    } else if (idx === 2) {
      navigate('performance');
    } else if (idx === 3) {
      setStatus(`Tool file: ${config?.project?.toolsDir || 'example/tools'}/${tool.name}.tool.*`, false);
    } else if (idx === 4) {
      // Generate evals (AI)
      await generateEvalsForTool(tool, config, screen, setStatus, openPopup, closePopup);
    } else if (idx === 5) {
      // Generate verifiers (AI)
      await generateVerifiersForTool(tool, config, screen, setStatus, openPopup, closePopup);
    } else if (idx === 6) {
      // Re-forge tool
      config._forgeTarget = { toolName: tool.name, spec: null };
      navigate('forge');
    } else if (idx === 7) {
      // Promote to registry
      await promoteToolToRegistry(tool, config, screen, setStatus, openPopup, closePopup);
    } else if (idx === 8) {
      // View drift report
      await showDriftReport(tool, config, screen, openPopup, closePopup);
    } else if (idx === 9) {
      // Mediate (fast-track)
      config._mediationTarget = tool.name;
      navigate('mediation');
    }
    // idx 10 = cancel
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

async function compareModelsForTool(tool, config, screen, setStatus, navigate, openPopup, closePopup) {
  const matrix = config?.modelMatrix || [];
  if (matrix.length === 0) {
    setStatus('No model matrix configured. Go to Settings → Model Matrix to add models.', true);
    return;
  }

  const progressBox = blessed.box({
    parent: screen,
    border: 'line',
    top: 'center', left: 'center',
    width: 60, height: 8,
    label: ' Comparing Models ',
    tags: true,
    content: `\n  {yellow-fg}⟳ Running evals across ${matrix.length} model(s)…{/yellow-fg}\n\n  This may take a few minutes.`
  });
  openPopup?.();
  screen.render();

  try {
    const { runEvalsMultiPass } = await import('../eval-runner.js');

    let lastStatus = '';
    const result = await runEvalsMultiPass(
      tool.name,
      config,
      process.cwd(),
      {},
      (progress) => {
        const line = `  ${progress.model}: case ${progress.done}/${progress.total}`;
        if (line !== lastStatus) {
          lastStatus = line;
          progressBox.setContent(`\n{yellow-fg}⟳ Running…{/yellow-fg}\n\n${line}`);
          screen.render();
        }
      }
    );

    closePopup?.();
    progressBox.destroy();
    screen.render();

    // Warn if any models failed due to missing API keys
    const errorModels = Object.entries(result.perModel)
      .filter(([, v]) => v.error)
      .map(([k]) => k);
    if (errorModels.length > 0) {
      setStatus(`Warning: ${errorModels.join(', ')} skipped (no API key). Check Settings → Model Matrix.`, true);
    }

    // Navigate to model-comparison view with results
    config._comparisonTarget = { toolName: tool.name, perModel: result.perModel };
    navigate('model-comparison');

  } catch (err) {
    progressBox.setContent(`\n  {red-fg}⚠ ${err.message}{/red-fg}`);
    screen.render();
    setTimeout(() => {
      closePopup?.();
      progressBox.destroy();
      screen.render();
    }, 4000);
  }
}

async function promoteToolToRegistry(tool, config, screen, setStatus, openPopup, closePopup) {
  setStatus('Promoting tool to registry…', false);
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (!existsSync(dbPath)) {
      setStatus('No forge.db found — run evals first.', true);
      return;
    }
    const { getDb, upsertToolRegistry, getEvalSummary } = await import('../db.js');
    const db = getDb(dbPath);
    const summary = getEvalSummary(db);
    const evalRow = summary.find((r) => r.tool_name === tool.name);
    const baseline = evalRow && evalRow.total_cases > 0
      ? evalRow.passed / evalRow.total_cases
      : null;

    // Upsert the registry row (creates or updates in a single statement)
    upsertToolRegistry(db, {
      tool_name: tool.name,
      lifecycle_state: 'promoted',
      promoted_at: new Date().toISOString(),
      baseline_pass_rate: baseline
    });

    setStatus(`${tool.name} promoted. Baseline: ${baseline != null ? `${Math.round(baseline * 100)}%` : 'N/A'}`, false);
  } catch (err) {
    setStatus(`Promote failed: ${err.message}`, true);
  }
}

async function showDriftReport(tool, config, screen, openPopup, closePopup) {
  let content = '';
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getDriftAlerts } = await import('../db.js');
      const { computeSuspects } = await import('../drift-monitor.js');
      const db = getDb(dbPath);
      const alerts = getDriftAlerts(db, tool.name);
      if (alerts.length === 0) {
        content = '\n  {green-fg}No open drift alerts for this tool.{/green-fg}';
      } else {
        const alert = alerts[0];
        const suspects = computeSuspects(db, tool.name);
        content = `\n  {yellow-fg}Drift Detected{/yellow-fg}\n` +
          `  Detected: ${alert.detected_at?.slice(0, 19) || '?'}\n` +
          `  Baseline: ${alert.baseline_rate != null ? `${Math.round(alert.baseline_rate * 100)}%` : 'N/A'}\n` +
          `  Current:  ${alert.current_rate != null ? `${Math.round(alert.current_rate * 100)}%` : 'N/A'}\n` +
          `  Delta:    ${alert.delta != null ? `-${Math.round(alert.delta * 100)}pp` : '?'}\n\n` +
          `  {cyan-fg}Suspects:{/cyan-fg} ${suspects.length > 0 ? suspects.join(', ') : '(none identified)'}`;
      }
    } else {
      content = '\n  {#888888-fg}No database found.{/#888888-fg}';
    }
  } catch (err) {
    content = `\n  {red-fg}Error: ${err.message}{/red-fg}`;
  }

  const popup = blessed.box({
    parent: screen,
    border: 'line',
    top: 'center',
    left: 'center',
    width: 60,
    height: 14,
    label: ` Drift Report: ${tool.name} `,
    tags: true,
    content
  });
  openPopup?.();
  popup.key(['escape', 'q', 'enter'], () => {
    closePopup?.();
    popup.destroy();
    screen.render();
  });
  popup.focus();
  screen.render();
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
