/**
 * Performance View — Eval run history from SQLite.
 */

import blessed from 'blessed';
import { existsSync } from 'fs';
import { resolve } from 'path';

async function loadData(config) {
  const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
  if (!existsSync(dbPath)) return [];

  try {
    const { getDb, getEvalSummary } = await import('../db.js');
    const db = getDb(dbPath);
    return getEvalSummary(db);
  } catch (_) {
    return [];
  }
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

  setFooter(' {bold}r{/bold} refresh  {bold}c{/bold} clear history  {bold}b{/bold} back');

  table.key('c', () => {
    showClearConfirm(screen, config, container.refresh);
  });

  container.refresh = async () => {
    try {
      const rows = await loadData(config);

      if (rows.length === 0) {
        table.hide();
        emptyMsg.show();
        screen.render();
        return;
      }

      table.show();
      emptyMsg.hide();

      const data = rows.map((r) => [
        r.tool_name,
        r.last_run ? r.last_run.slice(0, 19).replace('T', ' ') : '—',
        String(r.total_cases),
        String(r.passed),
        String(r.failed),
        r.pass_rate
      ]);

      table.setData([
        ['Tool', 'Last Run', 'Total Cases', 'Passed', 'Failed', 'Pass Rate'],
        ...data
      ]);
    } catch (err) {
      table.show();
      emptyMsg.hide();
      table.setData([['Tool', 'Last Run', 'Total Cases', 'Passed', 'Failed', 'Pass Rate'], ['Error: ' + err.message, '', '', '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

function showClearConfirm(screen, config, onClear) {
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

  confirm.ask('Clear all eval history? This cannot be undone. (y/n)', async (err, answer) => {
    if (!err && /^y/i.test(answer)) {
      try {
        const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
        const { getDb } = await import('../db.js');
        const db = getDb(dbPath);
        db.prepare('DELETE FROM eval_runs').run();
      } catch (_) { /* ignore */ }
      onClear();
    }
  });
}

export async function refresh(viewBox, config) {
  if (viewBox.refresh) await viewBox.refresh();
}
