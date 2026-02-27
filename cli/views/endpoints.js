/**
 * Endpoints View — All endpoints with tool coverage status.
 */

import blessed from 'blessed';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadApis } from '../api-loader.js';
import { getExistingTools } from '../tools-scanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');
const PENDING_SPEC_FILE = resolve(PROJECT_ROOT, 'forge-pending-tool.json');

function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')); } catch (_) { return null; }
}

async function httpJson(method, path, port, body) {
  const { request } = await import('http');
  return new Promise((res, rej) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request({
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.setTimeout(5000, () => { req.destroy(); rej(new Error('timeout')); });
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadData(config) {
  const project = config?.project || {};
  const api = config?.api || {};
  const tools = getExistingTools(project);
  const toolSet = new Set(tools.map((t) => t.toLowerCase().replace(/-/g, '_')));
  const hasApiConfig = !!(api.manifestPath || api.discovery?.url || api.discovery?.file);
  let endpoints = [];
  if (hasApiConfig) {
    endpoints = await loadApis(api); // let errors propagate to the view's catch
  }
  return {
    hasApiConfig,
    endpoints: endpoints.map((e) => ({
      method: e.method || 'GET',
      path: e.path || '',
      toolName: e.name || '—',
      covered: toolSet.has((e.name || '').toLowerCase().replace(/-/g, '_'))
    }))
  };
}

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup }) {
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

  const statusBar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 1, tags: true
  });

  setFooter(
    ' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}a{/cyan-fg} add manually  ' +
    '{cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back'
  );

  async function enqueueAndReport(endpoint) {
    const lock = readLock();
    if (lock) {
      try {
        const enqRes = await httpJson('POST', '/enqueue', lock.port, { endpoint });
        const enqData = JSON.parse(enqRes.body);
        const healthRes = await httpJson('GET', '/health', lock.port, null);
        const health = JSON.parse(healthRes.body);
        const watching = (health.waiting ?? 0) > 0;
        statusBar.setContent(watching
          ? ` {green-fg}✓ Queued (pos ${enqData.position}) — Claude is watching{/green-fg}`
          : ` {yellow-fg}⏳ Queued (pos ${enqData.position}) — run /forge-tool in Claude to process{/yellow-fg}`
        );
      } catch (err) {
        try {
          writeFileSync(PENDING_SPEC_FILE, JSON.stringify(
            { _source: 'forge-api-tui', _createdAt: new Date().toISOString(), endpoint, project: config?.project || {} },
            null, 2
          ), 'utf-8');
          statusBar.setContent(` {yellow-fg}Queue error — wrote forge-pending-tool.json instead{/yellow-fg}`);
        } catch (_) {
          statusBar.setContent(` {red-fg}Error: ${err.message}{/red-fg}`);
        }
      }
    } else {
      writeFileSync(PENDING_SPEC_FILE, JSON.stringify(
        { _source: 'forge-api-tui', _createdAt: new Date().toISOString(), endpoint, project: config?.project || {} },
        null, 2
      ), 'utf-8');
      statusBar.setContent(
        ' {yellow-fg}No forge service — wrote forge-pending-tool.json. Run /forge-tool in Claude to process.{/yellow-fg}'
      );
    }
    screen.render();
    await container.refresh();
  }

  table.key('a', () => showManualAddPrompt(screen, openPopup, closePopup, enqueueAndReport));

  container.refresh = async () => {
    try {
      const { rows, hasApiConfig } = await loadData(config).then((d) => ({ rows: d.endpoints, hasApiConfig: d.hasApiConfig }));
      if (!hasApiConfig) {
        table.setData([['Method', 'Path', 'Tool Name', 'Status'],
          ['{yellow-fg}No API source configured{/yellow-fg}', 'Go to Settings → Configure API Source', '', '']]);
      } else if (rows.length === 0) {
        table.setData([['Method', 'Path', 'Tool Name', 'Status'], ['No endpoints found', '', '', '']]);
      } else {
        table.setData([
          ['Method', 'Path', 'Tool Name', 'Status'],
          ...rows.map((r) => [
            r.method, r.path, r.toolName,
            r.covered ? '{green-fg}✓ covered{/green-fg}' : '{yellow-fg}○ uncovered{/yellow-fg}'
          ])
        ]);
      }
    } catch (err) {
      table.setData([['Method', 'Path', 'Tool Name', 'Status'], ['Error: ' + err.message, '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

function showManualAddPrompt(screen, openPopup, closePopup, onAdd) {
  const form = blessed.form({
    parent: screen, border: 'line', height: 12, width: 60,
    top: 'center', left: 'center', label: ' Add Endpoint Manually ', keys: true, tags: true
  });

  blessed.text({ parent: form, top: 1, left: 2, content: 'Method: ' });
  const methodInput = blessed.textbox({
    parent: form, top: 1, left: 10, width: 10, height: 1, inputOnFocus: true,
    style: { fg: 'white', bg: 'blue' }
  });
  blessed.text({ parent: form, top: 3, left: 2, content: 'Path:   ' });
  const pathInput = blessed.textbox({
    parent: form, top: 3, left: 10, width: 40, height: 1, inputOnFocus: true,
    style: { fg: 'white', bg: 'blue' }
  });
  blessed.text({ parent: form, top: 5, left: 2, content: 'Name:   ' });
  const nameInput = blessed.textbox({
    parent: form, top: 5, left: 10, width: 40, height: 1, inputOnFocus: true,
    style: { fg: 'white', bg: 'blue' }
  });

  const submitBtn = blessed.button({
    parent: form, top: 8, left: 2, width: 10, height: 1, content: ' Submit ',
    style: { bg: 'green', fg: 'white', focus: { bg: 'blue' } }, keys: true, mouse: true
  });
  const cancelBtn = blessed.button({
    parent: form, top: 8, left: 14, width: 10, height: 1, content: ' Cancel ',
    style: { bg: 'red', fg: 'white', focus: { bg: 'blue' } }, keys: true, mouse: true
  });

  openPopup?.();
  submitBtn.on('press', () => {
    const endpoint = {
      method: methodInput.getValue().toUpperCase() || 'GET',
      path: pathInput.getValue() || '/',
      name: nameInput.getValue() || 'unnamed_tool'
    };
    closePopup?.();
    form.destroy();
    screen.render();
    Promise.resolve(onAdd(endpoint)).catch(() => {});
  });
  cancelBtn.on('press', () => { closePopup?.(); form.destroy(); screen.render(); });
  form.key(['escape'], () => { closePopup?.(); form.destroy(); screen.render(); });
  methodInput.focus();
  screen.render();
}

