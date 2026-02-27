/**
 * Create Tool View — Shows uncovered endpoints; queues them via forge service or writes pending spec.
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
    }, (resp) => {
      let data = '';
      resp.on('data', (d) => { data += d; });
      resp.on('end', () => res({ status: resp.statusCode, body: data }));
    });
    req.setTimeout(5000, () => { req.destroy(); rej(new Error('timeout')); });
    req.on('error', rej);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadUncovered(config) {
  const project = config?.project || {};
  const api = config?.api || {};
  const tools = getExistingTools(project);
  const toolSet = new Set(tools.map((t) => t.toLowerCase().replace(/-/g, '_')));
  const hasApiConfig = !!(api.manifestPath || api.discovery?.url || api.discovery?.file);
  let endpoints = [];
  if (hasApiConfig) {
    const all = await loadApis(api); // let errors propagate to the view's catch
    endpoints = all.filter((e) => {
      const name = (e.name || '').toLowerCase().replace(/-/g, '_');
      return !toolSet.has(name);
    });
  }
  return { endpoints, hasApiConfig };
}

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup }) {
  // ── Container holds everything ────────────────────────────────────────────
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
    ' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}Enter{/cyan-fg} queue  ' +
    '{cyan-fg}a{/cyan-fg} add manually  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back'
  );

  let endpoints = [];

  async function doEnqueue(endpoint) {
    const lock = readLock();
    if (lock) {
      try {
        const enqRes = await httpJson('POST', '/enqueue', lock.port, { endpoint });
        const enqData = JSON.parse(enqRes.body);
        const position = enqData.position ?? 1;
        const healthRes = await httpJson('GET', '/health', lock.port, null);
        const health = JSON.parse(healthRes.body);
        const claudeWatching = (health.waiting ?? 0) > 0;
        if (claudeWatching) {
          statusBar.setContent(
            ` {green-fg}✓ Queued (position ${position}) — Claude is watching and will pick it up now{/green-fg}`
          );
        } else {
          statusBar.setContent(
            ` {yellow-fg}⏳ Queued (position ${position}) — no Claude session watching yet.` +
            ` Run /forge-tool in Claude to start the watch loop.{/yellow-fg}`
          );
        }
      } catch (err) {
        statusBar.setContent(` {red-fg}Queue error: ${err.message}{/red-fg}`);
      }
    } else {
      const spec = {
        _source: 'forge-api-tui', _createdAt: new Date().toISOString(),
        endpoint, project: config?.project || {}
      };
      writeFileSync(PENDING_SPEC_FILE, JSON.stringify(spec, null, 2), 'utf-8');
      statusBar.setContent(
        ' {yellow-fg}No forge service running — wrote forge-pending-tool.json.' +
        ' Run /forge-tool in Claude to process it.{/yellow-fg}'
      );
    }
    screen.render();
  }

  table.key('enter', () => {
    const idx = table.selected;
    if (idx < 1 || !endpoints[idx - 1]) return;
    doEnqueue(endpoints[idx - 1]);
  });

  table.key('a', () => showManualAddPrompt(screen, openPopup, closePopup, doEnqueue));

  container.refresh = async () => {
    try {
      const result = await loadUncovered(config);
      endpoints = result.endpoints;
      const lock = readLock();
      const svcNote = lock ? '{green-fg}[service active]{/green-fg}' : '{#888888-fg}[no service — will write pending spec]{/#888888-fg}';

      if (!result.hasApiConfig) {
        table.setData([['#', 'Method', 'Path', 'Suggested Name'],
          ['', '{yellow-fg}No API source configured{/yellow-fg}', 'Go to Settings → Configure API Source', '']]);
        statusBar.setContent(` ${svcNote}`);
      } else if (endpoints.length === 0) {
        table.setData([['#', 'Method', 'Path', 'Suggested Name'], ['', 'All endpoints have tools ✓', '', '']]);
        statusBar.setContent(` ${svcNote}`);
      } else {
        table.setData([
          ['#', 'Method', 'Path', 'Suggested Name'],
          ...endpoints.map((e, i) => [String(i + 1), e.method || 'GET', e.path || '', e.name || ''])
        ]);
        statusBar.setContent(` ${svcNote}  Press Enter to queue an endpoint`);
      }
    } catch (err) {
      table.setData([['#', 'Method', 'Path', 'Suggested Name'], ['Error: ' + err.message, '', '', '']]);
    }
    screen.render();
  };

  container.refresh();
  table.focus();
  return container;
}

function showManualAddPrompt(screen, openPopup, closePopup, onAdd) {
  const form = blessed.form({
    parent: screen, border: 'line', height: 13, width: 60,
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

