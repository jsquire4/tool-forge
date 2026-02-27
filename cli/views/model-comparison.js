/**
 * Model Comparison View — side-by-side performance metrics across models for a single tool.
 *
 * Shows: pass rate, avg latency, token usage, estimated cost per 1k calls, value score.
 * Sources data from eval_run_cases (live DB) merged with in-session results.
 */

import blessed from 'blessed';
import { existsSync } from 'fs';
import { resolve } from 'path';

// ── Cost helpers ───────────────────────────────────────────────────────────

/**
 * Estimate cost for N calls given token averages and per-million rates.
 * Returns null if rates are unknown.
 *
 * @param {string} model
 * @param {number} avgInputTokens
 * @param {number} avgOutputTokens
 * @param {object} costsConfig  - { [model]: { input, output } } per million tokens
 * @param {number} [calls=1000]
 * @returns {string|null}  formatted dollar string e.g. "$0.042"
 */
function estimateCost(model, avgInputTokens, avgOutputTokens, costsConfig, calls = 1000) {
  const rates = costsConfig?.[model];
  if (!rates) return null;
  const cost = ((avgInputTokens * rates.input) + (avgOutputTokens * rates.output)) / 1_000_000 * calls;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Value score: pass_rate / cost_per_1k_normalized.
 * Higher = better value. Returns null if cost is unknown.
 */
function valueScore(passRate, avgInputTokens, avgOutputTokens, model, costsConfig) {
  const rates = costsConfig?.[model];
  if (!rates || passRate == null) return null;
  const costPer1k = ((avgInputTokens * rates.input) + (avgOutputTokens * rates.output)) / 1_000_000 * 1000;
  if (costPer1k === 0) return null;
  return passRate / costPer1k;
}

// ── Bar helper ─────────────────────────────────────────────────────────────

function passRateBar(rate, width = 10) {
  const filled = Math.round(rate * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  if (rate >= 0.9) return `{green-fg}${bar}{/green-fg}`;
  if (rate >= 0.7) return `{yellow-fg}${bar}{/yellow-fg}`;
  return `{red-fg}${bar}{/red-fg}`;
}

function latencyColor(ms) {
  if (!ms) return '{#888888-fg}—{/#888888-fg}';
  const s = (ms / 1000).toFixed(1) + 's';
  if (ms < 1000) return `{green-fg}${s}{/green-fg}`;
  if (ms < 3000) return `{yellow-fg}${s}{/yellow-fg}`;
  return `{red-fg}${s}{/red-fg}`;
}

// ── Data loader ────────────────────────────────────────────────────────────

async function loadComparisonData(toolName, perModelFromSession, config) {
  const costsConfig = config?.costs || {};
  const rows = [];

  // Merge session results with DB history
  const dbRows = [];
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb, getModelComparisonData } = await import('../db.js');
      const db = getDb(dbPath);
      const data = getModelComparisonData(db, toolName);
      dbRows.push(...data);
    }
  } catch (_) { /* db unavailable */ }

  // Build combined model set — session results take precedence for pass_rate
  const modelSet = new Set([
    ...Object.keys(perModelFromSession || {}),
    ...dbRows.map((r) => r.model)
  ]);

  for (const model of modelSet) {
    const sessionResult = perModelFromSession?.[model];
    const dbRow = dbRows.find((r) => r.model === model);

    const passRate = sessionResult?.error
      ? null
      : sessionResult
        ? (sessionResult.total > 0 ? sessionResult.passed / sessionResult.total : null)
        : dbRow
          ? (dbRow.case_count > 0 ? dbRow.passed / dbRow.case_count : null)
          : null;

    const avgLatency = dbRow?.avg_latency_ms ?? null;

    const avgInput = dbRow
      ? (dbRow.total_input_tokens / Math.max(1, dbRow.case_count))
      : 0;
    const avgOutput = dbRow
      ? (dbRow.total_output_tokens / Math.max(1, dbRow.case_count))
      : 0;

    const costPer1k = estimateCost(model, avgInput, avgOutput, costsConfig, 1000);
    const score = passRate != null ? valueScore(passRate, avgInput, avgOutput, model, costsConfig) : null;

    rows.push({
      model,
      passRate,
      avgLatency,
      avgInput,
      avgOutput,
      costPer1k,
      score,
      error: sessionResult?.error ?? null,
      caseCount: dbRow?.case_count ?? sessionResult?.total ?? 0
    });
  }

  // Sort: errors last, then by value score DESC (null score after scored rows), then pass_rate
  rows.sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    if (a.score != null && b.score != null) return b.score - a.score;
    if (a.score != null) return -1;
    if (b.score != null) return 1;
    return (b.passRate ?? -1) - (a.passRate ?? -1);
  });

  return rows;
}

// ── View ───────────────────────────────────────────────────────────────────

export function createView({ screen, config, navigate, setFooter, screenKey, openPopup, closePopup }) {
  const toolName = config._comparisonTarget?.toolName || null;
  const perModel = config._comparisonTarget?.perModel || {};
  config._comparisonTarget = null; // consume — prevent stale reads on re-entry

  const container = blessed.box({
    top: 0, left: 0, width: '100%', height: '100%', tags: true
  });

  const titleBar = blessed.box({
    parent: container,
    top: 0, left: 0, width: '100%', height: 1,
    tags: true,
    content: toolName
      ? ` {bold}{white-fg}Model Comparison:{/white-fg}{/bold} {cyan-fg}${toolName}{/cyan-fg}  {#888888-fg}— pass rate · latency · cost/1k calls · value score{/#888888-fg}`
      : ' {red-fg}No comparison target set{/red-fg}'
  });

  const table = blessed.listtable({
    parent: container,
    top: 1, left: 0,
    width: '100%', height: '100%-4',
    tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: '#1a3a5c', fg: 'white' } }
    },
    pad: 1
  });

  const summaryBar = blessed.box({
    parent: container,
    bottom: 1, left: 0, width: '100%', height: 2,
    tags: true, border: { type: 'line' },
    style: { border: { fg: '#555555' } }
  });

  setFooter(' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}d{/cyan-fg} difficulty breakdown  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back');

  let rowData = [];

  screenKey('d', () => {
    const idx = table.selected;
    if (idx >= 1 && rowData[idx - 1]) {
      showDifficultyBreakdown(screen, rowData[idx - 1], toolName, config, openPopup, closePopup);
    }
  });

  container.refresh = async () => {
    if (!toolName) {
      table.setData([['Model', 'Pass Rate', 'Latency', 'Cost/1k', 'Value', 'Cases'], ['No target', '', '', '', '', '']]);
      screen.render();
      return;
    }

    try {
      rowData = await loadComparisonData(toolName, perModel, config);

      if (rowData.length === 0) {
        table.setData([
          ['Model', 'Pass%', 'Bar', 'Latency', 'Cost/1k', 'Value', 'Cases'],
          ['No data yet — run Compare Models from Tools & Evals', '', '', '', '', '', '']
        ]);
        summaryBar.setContent('');
        screen.render();
        return;
      }

      const headers = ['Model', 'Pass%', 'Bar', 'Latency', 'Cost/1k', 'Value', 'Cases'];
      const tableRows = rowData.map((r) => {
        if (r.error) {
          return [r.model, '{red-fg}error{/red-fg}', '──────────', '—', '—', '—', '—'];
        }
        const pct = r.passRate != null ? `${Math.round(r.passRate * 100)}%` : '—';
        const bar = r.passRate != null ? passRateBar(r.passRate) : '{#888888-fg}──────────{/#888888-fg}';
        const lat = latencyColor(r.avgLatency);
        const cost = r.costPer1k ?? '{#888888-fg}—{/#888888-fg}';
        const score = r.score != null ? r.score.toFixed(1) : '{#888888-fg}—{/#888888-fg}';
        return [r.model, pct, bar, lat, cost, score, String(r.caseCount)];
      });

      table.setData([headers, ...tableRows]);

      // Build summary recommendation
      const bestValue = rowData.find((r) => !r.error && r.score != null);
      const bestPass  = rowData.find((r) => !r.error && r.passRate != null);
      const cheapest  = [...rowData]
        .filter((r) => !r.error && r.costPer1k != null)
        .sort((a, b) => {
          const ca = parseFloat(a.costPer1k?.replace('$', '') || 'Infinity');
          const cb = parseFloat(b.costPer1k?.replace('$', '') || 'Infinity');
          return ca - cb;
        })[0];

      const parts = [];
      if (bestValue) parts.push(`{green-fg}Best value:{/green-fg} ${bestValue.model} (score ${bestValue.score?.toFixed(1)})`);
      if (bestPass && bestPass.model !== bestValue?.model) {
        parts.push(`{cyan-fg}Highest pass rate:{/cyan-fg} ${bestPass.model} (${Math.round((bestPass.passRate ?? 0) * 100)}%)`);
      }
      if (cheapest && cheapest.model !== bestValue?.model) {
        parts.push(`{yellow-fg}Cheapest:{/yellow-fg} ${cheapest.model} (${cheapest.costPer1k}/1k)`);
      }
      summaryBar.setContent(' ' + (parts.join('   ') || '{#888888-fg}Add cost rates to forge.config.json for value scoring{/#888888-fg}'));

    } catch (err) {
      table.setData([['Model', 'Pass%', 'Bar', 'Latency', 'Cost/1k', 'Value', 'Cases'], [`Error: ${err.message}`, '', '', '', '', '', '']]);
    }

    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

// ── Difficulty breakdown popup ────────────────────────────────────────────

async function showDifficultyBreakdown(screen, row, toolName, config, openPopup, closePopup) {
  let content = `\n  {cyan-fg}${row.model}{/cyan-fg}  —  ${toolName}\n\n`;

  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      const { getDb } = await import('../db.js');
      const db = getDb(dbPath);

      const difficulties = ['straightforward', 'ambiguous', 'edge', 'adversarial', 'easy', 'medium', 'hard'];
      const breakdown = db.prepare(`
        SELECT
          erc.case_id,
          er.eval_type,
          erc.status,
          erc.latency_ms
        FROM eval_run_cases erc
        JOIN eval_runs er ON erc.eval_run_id = er.id
        WHERE erc.tool_name = ? AND erc.model = ?
        ORDER BY erc.run_at DESC
        LIMIT 200
      `).all(toolName, row.model);

      // Group by difficulty from case_id patterns
      const diffMap = {};
      for (const c of breakdown) {
        // Try to infer difficulty from case_id (e.g. "tool_labeled_001") or eval_type
        const diff = c.case_id?.match(/(straightforward|ambiguous|edge|adversarial|easy|medium|hard)/i)?.[1]?.toLowerCase()
          || c.eval_type || 'unknown';
        if (!diffMap[diff]) diffMap[diff] = { passed: 0, total: 0 };
        diffMap[diff].total++;
        if (c.status === 'passed') diffMap[diff].passed++;
      }

      if (Object.keys(diffMap).length === 0) {
        content += '  {#888888-fg}No per-case data yet. Run evals to populate.{/#888888-fg}';
      } else {
        for (const [diff, stats] of Object.entries(diffMap)) {
          const rate = stats.passed / stats.total;
          const bar = passRateBar(rate, 8);
          const pct = `${Math.round(rate * 100)}%`.padStart(4);
          content += `  ${diff.padEnd(16)} ${bar}  ${pct}  (${stats.passed}/${stats.total})\n`;
        }
      }

      // Token/cost summary
      if (row.avgInput > 0 || row.avgOutput > 0) {
        content += `\n  {#888888-fg}Avg tokens: ${Math.round(row.avgInput)} in / ${Math.round(row.avgOutput)} out{/#888888-fg}`;
      }
    } else {
      content += '  {#888888-fg}No database found.{/#888888-fg}';
    }
  } catch (err) {
    content += `  {red-fg}Error: ${err.message}{/red-fg}`;
  }

  openPopup?.();
  const popup = blessed.box({
    parent: screen,
    border: 'line',
    top: 'center', left: 'center',
    width: 62, height: 18,
    label: ` Difficulty Breakdown `,
    tags: true, scrollable: true,
    content
  });
  popup.key(['escape', 'q', 'enter', 'd'], () => {
    closePopup?.();
    popup.destroy();
    screen.render();
  });
  popup.focus();
  screen.render();
}
