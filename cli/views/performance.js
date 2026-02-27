/**
 * Performance View — Eval run history from SQLite, with sparklines and drift alerts.
 */

import blessed from 'blessed';
import { existsSync } from 'fs';
import { resolve } from 'path';

// ── ASCII sparkline ────────────────────────────────────────────────────────

function sparkline(values) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (!values || values.length === 0) return '—';
  return values.map((v) => blocks[Math.min(7, Math.floor((v || 0) * 8))]).join('');
}

// ── Data loader ────────────────────────────────────────────────────────────

async function loadData(config) {
  const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
  if (!existsSync(dbPath)) return { rows: [], driftMap: {}, historyMap: {} };

  try {
    const { getDb, getEvalSummary, getDriftAlerts, getPerToolRunHistory } = await import('../db.js');
    const db = getDb(dbPath);
    const rows = getEvalSummary(db);
    const alerts = getDriftAlerts(db, null);
    const driftMap = {};
    for (const a of alerts) driftMap[a.tool_name] = a;

    // Load per-tool history for sparklines
    const historyMap = {};
    for (const r of rows) {
      const history = getPerToolRunHistory(db, r.tool_name, 10);
      // history is DESC order — reverse for sparkline (oldest first)
      historyMap[r.tool_name] = history.reverse().map((h) => h.pass_rate || 0);
    }

    return { rows, driftMap, historyMap, db };
  } catch (_) {
    return { rows: [], driftMap: {}, historyMap: {} };
  }
}

// ── View ───────────────────────────────────────────────────────────────────

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
    height: '100%-2',
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    border: { type: 'line' },
    align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: 'blue', fg: 'white' } }
    },
    pad: 1
  });

  const emptyMsg = blessed.box({
    parent: container,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 3,
    tags: true,
    align: 'center',
    content: '{gray-fg}No eval history yet.\nEval results will appear here when forge-eval runs are logged.{/gray-fg}',
    hidden: true
  });

  setFooter(' {bold}r{/bold} refresh  {bold}c{/bold} clear history  {bold}d{/bold} drift suspects  {bold}b{/bold} back');

  let cachedData = { rows: [], driftMap: {}, historyMap: {}, db: null };
  let suspectsOpen = false;

  table.key('c', () => {
    if (!existsSync(resolve(process.cwd(), config?.dbPath || 'forge.db'))) return;
    showClearConfirm(screen, config, openPopup, closePopup, container.refresh);
  });

  screenKey('d', () => {
    if (suspectsOpen) return; // prevent double-open from rapid keypresses
    if (openPopup && cachedData.rows.length > 0) {
      const idx = table.selected;
      if (idx >= 1 && cachedData.rows[idx - 1]) {
        suspectsOpen = true;
        showSuspectsPopup(screen, cachedData.rows[idx - 1], cachedData, config, openPopup, closePopup)
          .finally(() => { suspectsOpen = false; });
      }
    }
  });

  container.refresh = async () => {
    try {
      cachedData = await loadData(config);
      const { rows, driftMap, historyMap } = cachedData;

      if (rows.length === 0) {
        table.hide();
        emptyMsg.show();
        screen.render();
        return;
      }

      table.show();
      emptyMsg.hide();

      const data = rows.map((r) => {
        const history = historyMap[r.tool_name] || [];
        const trend = sparkline(history);
        const driftCell = driftMap[r.tool_name]
          ? '{red-fg}⚠ drift{/red-fg}'
          : '{#555555-fg}—{/#555555-fg}';
        return [
          r.tool_name,
          trend,
          r.last_run ? r.last_run.slice(0, 19).replace('T', ' ') : '—',
          r.pass_rate,
          driftCell
        ];
      });

      table.setData([
        ['Tool', 'Trend', 'Last Run', 'Pass Rate', 'Alert'],
        ...data
      ]);
    } catch (err) {
      table.show();
      emptyMsg.hide();
      table.setData([['Tool', 'Trend', 'Last Run', 'Pass Rate', 'Alert'], ['Error: ' + err.message, '', '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

// ── Suspects popup ─────────────────────────────────────────────────────────

async function showSuspectsPopup(screen, toolRow, cachedData, config, openPopup, closePopup) {
  let content = '';
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { computeSuspects } = await import('../drift-monitor.js');
      const db = cachedData.db;
      if (db) {
        const suspects = computeSuspects(db, toolRow.tool_name);
        const alert = cachedData.driftMap[toolRow.tool_name];
        if (!alert) {
          content = '\n  {green-fg}No drift detected for this tool.{/green-fg}';
        } else {
          content = `\n  {yellow-fg}Drift suspects for: ${toolRow.tool_name}{/yellow-fg}\n\n` +
            (suspects.length > 0
              ? suspects.map((s) => `  • ${s}`).join('\n')
              : '  {#888888-fg}(no suspects identified){/#888888-fg}') +
            `\n\n  {#888888-fg}Delta: -${Math.round((alert.delta || 0) * 100)}pp` +
            `  Baseline: ${alert.baseline_rate != null ? Math.round(alert.baseline_rate * 100) + '%' : '?'}{/#888888-fg}`;
        }
      } else {
        content = '\n  {#888888-fg}DB not available.{/#888888-fg}';
      }
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
    label: ` Drift Suspects `,
    tags: true,
    content
  });
  openPopup?.();
  popup.key(['escape', 'q', 'enter', 'd'], () => {
    closePopup?.();
    popup.destroy();
    screen.render();
  });
  popup.focus();
  screen.render();
}

// ── Clear confirm ──────────────────────────────────────────────────────────

function showClearConfirm(screen, config, openPopup, closePopup, onClear) {
  const confirm = blessed.question({
    parent: screen,
    border: 'line',
    height: 'shrink',
    width: 'half',
    top: 'center',
    left: 'center',
    label: ' Clear Eval History ',
    tags: true,
    keys: true
  });

  openPopup?.();
  confirm.ask('Clear all eval history? This cannot be undone. (y/n)', async (err, answer) => {
    closePopup?.();
    confirm.destroy();
    if (!err && /^y/i.test(answer)) {
      try {
        const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
        const { getDb } = await import('../db.js');
        const db = getDb(dbPath);
        db.prepare('DELETE FROM eval_runs').run();
        db.prepare('DELETE FROM eval_run_cases').run();
      } catch (_) { /* ignore */ }
      onClear();
    }
  });
}
