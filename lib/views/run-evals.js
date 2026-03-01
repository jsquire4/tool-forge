/**
 * Run Evals View — Browse and run eval files directly from the TUI.
 */

import blessed from 'blessed';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

/**
 * Find eval files in the configured evalsDir.
 * @param {object} config
 * @returns {string[]} - array of file paths
 */
function findEvalFiles(config) {
  const evalsDir = resolve(process.cwd(), config?.project?.evalsDir || 'docs/examples');
  if (!existsSync(evalsDir)) return [];
  try {
    return readdirSync(evalsDir)
      .filter(f => f.endsWith('.golden.json') || f.endsWith('.labeled.json'))
      .map(f => resolve(evalsDir, f));
  } catch {
    return [];
  }
}

export function createView({ screen, content, config, navigate, setFooter }) {
  const container = blessed.box({
    top: 0, left: 0, width: '100%', height: '100%', tags: true
  });

  // Title
  const title = blessed.box({
    parent: container,
    top: 0, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    align: 'center',
    valign: 'middle',
    content: ' {bold}{cyan-fg}▲  Run Evals{/cyan-fg}{/bold} '
  });

  // Eval file list
  const list = blessed.list({
    parent: container,
    top: 3, left: 2,
    width: '50%-2', height: '100%-6',
    tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'blue' },
      selected: { bg: '#1a3a5c', bold: true },
      item: { fg: 'white' }
    },
    label: ' Eval Files '
  });

  // Results pane
  const resultsBox = blessed.box({
    parent: container,
    top: 3, left: '50%',
    width: '50%', height: '100%-6',
    tags: true, scrollable: true, alwaysScroll: true,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    label: ' Results ',
    padding: { left: 1, right: 1 }
  });

  const statusBar = blessed.box({
    parent: container,
    bottom: 2, left: 0, width: '100%', height: 1,
    tags: true,
    content: ''
  });

  setFooter(
    ' {cyan-fg}↑↓{/cyan-fg} select  {cyan-fg}Enter{/cyan-fg} run  {cyan-fg}r{/cyan-fg} record  {cyan-fg}p{/cyan-fg} replay  {cyan-fg}b{/cyan-fg} back'
  );

  let evalFiles = [];
  let running = false;

  function loadFiles() {
    evalFiles = findEvalFiles(config);
    if (evalFiles.length === 0) {
      list.setItems([' {#888888-fg}No eval files found{/#888888-fg}']);
    } else {
      list.setItems(evalFiles.map(f => {
        const name = basename(f);
        return ` ${name}`;
      }));
    }
    screen.render();
  }

  async function runSelected(mode) {
    if (running || evalFiles.length === 0) return;
    const idx = list.selected;
    if (idx < 0 || idx >= evalFiles.length) return;

    const evalPath = evalFiles[idx];
    const fileName = basename(evalPath);

    running = true;
    statusBar.setContent(` {yellow-fg}⟳ Running ${fileName}...{/yellow-fg}`);
    resultsBox.setContent('Running...');
    screen.render();

    try {
      const { runEvalSuite } = await import('../runner/index.js');
      const agentConfig = config?.agent ?? {};

      if (!agentConfig.endpoint) {
        resultsBox.setContent(
          '{red-fg}No agent.endpoint configured.{/red-fg}\n\n' +
          'Add to forge.config.json:\n' +
          '{\n  "agent": {\n    "endpoint": "http://localhost:8001/agent-api/chat-sync"\n  }\n}'
        );
        statusBar.setContent(' {red-fg}✗ Configuration error{/red-fg}');
        screen.render();
        return;
      }

      const method = agentConfig.method ?? 'POST';
      const headers = { 'Content-Type': 'application/json', ...(agentConfig.headers ?? {}) };
      const inputField = agentConfig.inputField ?? 'message';
      const outputField = agentConfig.outputField ?? 'text';

      const agentFn = async (message) => {
        const t0 = Date.now();
        const res = await fetch(agentConfig.endpoint, {
          method, headers, body: JSON.stringify({ [inputField]: message })
        });
        if (!res.ok) throw new Error(`Agent returned ${res.status}`);
        const data = await res.json();
        return { responseText: data[outputField] ?? '', toolsCalled: data.toolsCalled ?? [], latencyMs: Date.now() - t0 };
      };

      const fixturesDir = resolve(process.cwd(), config?.fixtures?.dir ?? '.forge-fixtures');
      const ttlDays = config?.fixtures?.ttlDays ?? 30;
      const gates = config?.gates ?? {};

      const summary = await runEvalSuite(evalPath, agentFn, {
        record: mode === 'record',
        replay: mode === 'replay',
        fixturesDir,
        ttlDays,
        gates,
      });

      const { total, passed, failed, skipped, passRate } = summary;
      const pct = (passRate * 100).toFixed(1);
      const passIcon = failed === 0 ? '{green-fg}✓{/green-fg}' : '{red-fg}✗{/red-fg}';

      const lines = [
        `${passIcon} {bold}${passed}/${total} passed (${pct}%){/bold}`,
        skipped > 0 ? `{#888888-fg}${skipped} skipped{/#888888-fg}` : null,
        summary.p95LatencyMs > 0 ? `p95 latency: ${summary.p95LatencyMs}ms` : null,
        '',
      ].filter(l => l !== null);

      if (summary.gates?.results?.length > 0) {
        lines.push('{bold}Gates:{/bold}');
        for (const r of summary.gates.results) {
          const gi = r.pass ? '{green-fg}✓{/green-fg}' : '{red-fg}✗{/red-fg}';
          lines.push(`${gi} ${r.gate}: ${r.actual} (≥ ${r.threshold})`);
        }
        lines.push('');
      }

      const failingCases = summary.cases.filter(c => c.status === 'failed');
      if (failingCases.length > 0) {
        lines.push('{bold}Failures:{/bold}');
        for (const f of failingCases) {
          lines.push(`{red-fg}✗{/red-fg} ${f.id ?? '(unnamed)'}: ${f.reason}`);
        }
      } else if (failed === 0) {
        lines.push('{green-fg}All cases passed!{/green-fg}');
      }

      resultsBox.setContent(lines.join('\n'));
      statusBar.setContent(` ${failed === 0 ? '{green-fg}✓ Passed{/green-fg}' : '{red-fg}✗ Failed{/red-fg}'}  ${fileName}`);
    } catch (err) {
      resultsBox.setContent(`{red-fg}Error: ${err.message}{/red-fg}`);
      statusBar.setContent(' {red-fg}✗ Error{/red-fg}');
    } finally {
      running = false;
      screen.render();
    }
  }

  list.key('enter', () => runSelected('normal'));
  list.key('r', () => runSelected('record'));
  list.key('p', () => runSelected('replay'));
  list.key('b', () => navigate('main-menu'));

  container.refresh = () => {
    loadFiles();
  };

  loadFiles();
  list.focus();
  return container;
}
