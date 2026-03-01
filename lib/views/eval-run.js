/**
 * Eval Run View — Live progress display for running evals via Anthropic/OpenAI.
 * No forge service required. The tool name to evaluate comes from config._evalTarget.
 */

import blessed from 'blessed';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

export function createView({ screen, content, config, navigate, setFooter, screenKey }) {
  const toolName = config._evalTarget;
  if (!toolName) {
    // Navigated here directly without selecting a tool — redirect back
    const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });
    blessed.box({
      parent: container, top: 'center', left: 'center', width: '60%', height: 3,
      tags: true, align: 'center',
      content: '{yellow-fg}No tool selected.\nGo to Tools & Evals and press Enter on a tool to run its evals.{/yellow-fg}'
    });
    setImmediate(() => { screen.render(); });
    return container;
  }

  const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });

  // ── Title strip ───────────────────────────────────────────────────────────
  const titleBar = blessed.box({
    parent: container,
    top: 0, left: 0, width: '100%', height: 1,
    tags: true, style: { bg: 'default' }
  });

  // ── Progress bar ──────────────────────────────────────────────────────────
  const progressBox = blessed.box({
    parent: container,
    top: 1, left: 1, width: '100%-2', height: 3,
    border: { type: 'line' }, tags: true,
    style: { border: { fg: '#333333' } }
  });

  // ── Results table ─────────────────────────────────────────────────────────
  const resultsTable = blessed.listtable({
    parent: container,
    top: 4, left: 0, width: '100%', height: '100%-7',
    tags: true, keys: true, vi: true,
    border: { type: 'line' }, align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: '#1a3a5c' } },
      border: { fg: '#333333' }
    },
    pad: 1
  });

  // ── Summary bar ───────────────────────────────────────────────────────────
  const summaryBar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 2,
    border: { type: 'line' }, tags: true,
    style: { border: { fg: '#333333' } }
  });

  setFooter(
    ' {cyan-fg}↑↓{/cyan-fg} scroll results  {cyan-fg}p{/cyan-fg} performance history  {cyan-fg}b{/cyan-fg} back'
  );

  // 'p' is view-specific — registered via screenKey so it's cleaned up on navigation.
  screenKey('p', () => navigate('performance'));

  // ── State ─────────────────────────────────────────────────────────────────
  let total = 0;
  let passedCount = 0;
  let skippedCount = 0;
  let doneCount = 0;
  const rows = [];

  function updateProgress() {
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    const barWidth = Math.max(10, (screen.width || 80) - 22);
    const filled = Math.round((pct / 100) * barWidth);
    const bar =
      '{green-fg}' + '█'.repeat(filled) + '{/green-fg}' +
      '{#333333-fg}' + '░'.repeat(barWidth - filled) + '{/#333333-fg}';
    progressBox.setContent(
      ` ${bar}\n` +
      ` {white-fg}${doneCount}/${total}{/white-fg}  ` +
      `{green-fg}${passedCount} passed{/green-fg}  ` +
      `{red-fg}${doneCount - passedCount - skippedCount} failed{/red-fg}  ` +
      `{#888888-fg}${skippedCount} skipped{/#888888-fg}  ` +
      `${pct}%`
    );
    screen.render();
  }

  function updateTable() {
    const data = rows.map((r) => [
      (r.id || '').slice(0, 22),
      r.status === 'passed'
        ? '{green-fg}✓ pass{/green-fg}'
        : r.status === 'skipped'
          ? '{#888888-fg}— skip{/#888888-fg}'
          : '{red-fg}✗ fail{/red-fg}',
      (r.toolsCalled || []).join(', ') || '—',
      (r.reason || r.description || '').slice(0, 38)
    ]);
    resultsTable.setData([
      ['ID', 'Status', 'Tools Called', 'Notes'],
      ...(data.length ? data : [['Running...', '', '', '']])
    ]);
    screen.render();
  }

  // ── Runner ────────────────────────────────────────────────────────────────
  async function startRun() {
    const { runEvals, findEvalFiles } = await import('../eval-runner.js');
    const { existsSync, readFileSync } = await import('fs');

    // Pre-flight: check API key
    const envPath = resolve(PROJECT_ROOT, '.env');
    let hasKey = false;
    if (existsSync(envPath)) {
      hasKey = /ANTHROPIC_API_KEY|OPENAI_API_KEY/.test(readFileSync(envPath, 'utf-8'));
    }
    if (!hasKey) {
      titleBar.setContent(` {red-fg}⚠ No API key{/red-fg}  {white-fg}${toolName}{/white-fg}`);
      summaryBar.setContent(
        ' Add {cyan-fg}ANTHROPIC_API_KEY{/cyan-fg} or {cyan-fg}OPENAI_API_KEY{/cyan-fg}' +
        ' in Settings → API Keys / Secrets, then press {cyan-fg}b{/cyan-fg} and retry.'
      );
      screen.render();
      return;
    }

    // Pre-flight: check eval files exist
    let evalFiles = [];
    try { evalFiles = findEvalFiles(toolName, config); } catch (_) { /* ignore */ }
    if (evalFiles.length === 0) {
      titleBar.setContent(` {yellow-fg}⚠ No eval files{/yellow-fg}  {white-fg}${toolName}{/white-fg}`);
      summaryBar.setContent(
        ' Run {cyan-fg}/forge-tool{/cyan-fg} in Claude to generate eval files for this tool.'
      );
      screen.render();
      return;
    }

    // Count cases for progress bar
    let caseCount = 0;
    for (const f of evalFiles) {
      try { caseCount += JSON.parse(readFileSync(f, 'utf-8')).length; } catch (_) { /* ignore */ }
    }
    total = caseCount;
    titleBar.setContent(
      ` Running evals for {cyan-fg}${toolName}{/cyan-fg}` +
      `  — ${total} cases across ${evalFiles.length} file(s)`
    );
    updateProgress();
    updateTable();

    let summary;
    try {
      summary = await runEvals(toolName, config, PROJECT_ROOT, (progress) => {
        doneCount = progress.done;
        if (progress.passed === null) skippedCount++;
        else if (progress.passed) passedCount++;
        rows.push({
          id: progress.caseId,
          status: progress.passed === null ? 'skipped' : progress.passed ? 'passed' : 'failed',
          toolsCalled: progress.toolsCalled,
          reason: progress.reason
        });
        updateProgress();
        updateTable();
      });
    } catch (err) {
      summaryBar.setContent(` {red-fg}Error: ${err.message}{/red-fg}`);
      screen.render();
      return;
    }

    const rate = summary.total > 0 ? Math.round((summary.passed / summary.total) * 100) : 0;
    const rateColor = rate >= 80 ? 'green' : rate >= 50 ? 'yellow' : 'red';
    titleBar.setContent(
      ` {bold}${toolName}{/bold}  complete  ` +
      `via {cyan-fg}${summary.provider}{/cyan-fg} / {cyan-fg}${summary.model}{/cyan-fg}`
    );
    summaryBar.setContent(
      ` {bold}Result:{/bold}  ` +
      `{${rateColor}-fg}${summary.passed}/${summary.total} passed (${rate}%){/${rateColor}-fg}` +
      `   ${summary.failed} failed  ${summary.skipped} skipped` +
      `   {#888888-fg}saved to forge.db{/#888888-fg}`
    );
    screen.render();
  }

  startRun();
  resultsTable.focus();
  return container;
}

