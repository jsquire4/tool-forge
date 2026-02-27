/**
 * Verifier Coverage View — Tool-by-tool verifier gap analysis as a blessed table.
 */

import blessed from 'blessed';
import { getToolsWithMetadata } from '../tools-scanner.js';
import { getExistingVerifiers } from '../verifier-scanner.js';
import { inferOutputGroups, getVerifiersForGroups } from '../output-groups.js';

async function loadData(config) {
  const project = config?.project || {};
  const verification = config?.verification || {};

  if (!verification?.enabled) return { enabled: false, rows: [] };

  const tools = getToolsWithMetadata(project);
  const verifiers = getExistingVerifiers(verification);

  const rows = tools.map((tool) => {
    const groups = inferOutputGroups(tool);
    const covering = getVerifiersForGroups(groups).filter((v) => verifiers.includes(v));
    return {
      tool: tool.name,
      outputGroups: groups.join(', ') || '—',
      coverage: covering.length > 0 ? covering.join(', ') : '—',
      hasGap: covering.length === 0
    };
  });

  return { enabled: true, rows };
}

export function createView({ screen, content, config, navigate, setFooter, screenKey }) {
  const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });

  const table = blessed.listtable({
    parent: container,
    top: 0, left: 0, width: '100%', height: '100%-1',
    tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' }, align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: '#1a3a5c', fg: 'white' } },
      border: { fg: '#333333' }
    },
    pad: 1
  });

  const summaryBar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 1, tags: true
  });

  setFooter(
    ' {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back  ' +
    '— run /forge-verifier in Claude to fill gaps'
  );

  container.refresh = async () => {
    try {
      const { enabled, rows } = await loadData(config);

      if (!enabled) {
        table.setData([
          ['Tool', 'Output Groups', 'Verifier Coverage', 'Gap?'],
          ['Verification disabled in forge.config.json', '', '', '']
        ]);
        summaryBar.setContent('');
        screen.render();
        return;
      }

      if (rows.length === 0) {
        table.setData([
          ['Tool', 'Output Groups', 'Verifier Coverage', 'Gap?'],
          ['No tools found', '', '', '']
        ]);
        summaryBar.setContent('');
        screen.render();
        return;
      }

      table.setData([
        ['Tool', 'Output Groups', 'Verifier Coverage', 'Gap?'],
        ...rows.map((r) => [
          r.tool,
          r.outputGroups,
          r.hasGap
            ? '{yellow-fg}' + r.coverage + '{/yellow-fg}'
            : '{green-fg}' + r.coverage + '{/green-fg}',
          r.hasGap ? '{yellow-fg}⚠ gap{/yellow-fg}' : '{green-fg}✓{/green-fg}'
        ])
      ]);

      const gapCount = rows.filter((r) => r.hasGap).length;
      summaryBar.setContent(gapCount > 0
        ? ` {yellow-fg}${gapCount} tool(s) missing verifier coverage. Run /forge-verifier in Claude.{/yellow-fg}`
        : ' {green-fg}All tools have verifier coverage.{/green-fg}'
      );
    } catch (err) {
      table.setData([
        ['Tool', 'Output Groups', 'Verifier Coverage', 'Gap?'],
        ['Error: ' + err.message, '', '', '']
      ]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

export async function refresh(viewBox, config) {
  if (typeof viewBox.refresh === 'function') await viewBox.refresh();
}
