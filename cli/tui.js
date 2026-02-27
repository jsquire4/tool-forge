/**
 * TUI — Full-screen blessed interface for Tool-Forge.
 *
 * Layout:
 *   row 0:   header  (blue bg, logo + service status)
 *   row 1:   ─── divider ───
 *   rows 2…n-3: content area  (views rendered here)
 *   row n-2: ─── divider ───
 *   row n-1: footer  (key hints, updated per view)
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');
const HEADER_POLL_MS = 3000;

function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')); } catch (_) { return null; }
}

async function fetchHealth(port) {
  try {
    const { request } = await import('http');
    return new Promise((res) => {
      const req = request(
        { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
        (resp) => {
          let data = '';
          resp.on('data', (d) => { data += d; });
          resp.on('end', () => { try { res(JSON.parse(data)); } catch (_) { res(null); } });
        }
      );
      req.setTimeout(2000, () => { req.destroy(); res(null); });
      req.on('error', () => res(null));
      req.end();
    });
  } catch (_) { return null; }
}

export async function runTui(config) {
  const screen = blessed.screen({ smartCSR: true, title: 'Tool Forge', fullUnicode: true });

  // ── Chrome ────────────────────────────────────────────────────────────────
  const header = blessed.box({
    top: 0, left: 0, width: '100%', height: 1,
    tags: true, style: { bg: 'blue', fg: 'white', bold: true }
  });

  const headerRule = blessed.box({
    top: 1, left: 0, width: '100%', height: 1,
    tags: true, content: '{cyan-fg}' + '─'.repeat(400) + '{/cyan-fg}'
  });

  const footerRule = blessed.box({
    bottom: 1, left: 0, width: '100%', height: 1,
    tags: true, content: '{cyan-fg}' + '─'.repeat(400) + '{/cyan-fg}'
  });

  const footer = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1,
    tags: true,
    content: ' {cyan-fg}↑↓{/cyan-fg} navigate  {cyan-fg}Enter{/cyan-fg} select  {cyan-fg}b{/cyan-fg} back  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}q{/cyan-fg} quit',
    style: { bg: 'black', fg: 'white' }
  });

  // Content sits between the two rules (rows 2 … n-3).
  const content = blessed.box({
    top: 2, left: 0, width: '100%', height: screen.rows - 4, tags: true
  });

  screen.append(header);
  screen.append(headerRule);
  screen.append(content);
  screen.append(footerRule);
  screen.append(footer);

  // ── View management ───────────────────────────────────────────────────────
  let currentViewName = 'main-menu';
  let currentView = null;
  const moduleCache = {};   // module-level cache (ESM import cache still applies, but this avoids re-await)

  // View-specific screen key bindings: cleared each time we navigate away.
  const viewKeys = [];      // [{ keys, fn }, ...]

  /**
   * Register a screen-level key that belongs to the current view.
   * It will be automatically unregistered when the view is navigated away from.
   */
  function screenKey(keys, fn) {
    viewKeys.push({ keys, fn });
    screen.key(keys, fn);
  }

  async function loadModule(name) {
    if (!moduleCache[name]) {
      moduleCache[name] = await import(`./views/${name}.js`);
    }
    return moduleCache[name];
  }

  async function showView(name) {
    // 1. Unregister all view-local key bindings from the outgoing view.
    for (const { keys, fn } of viewKeys) {
      screen.unkey(keys, fn);
    }
    viewKeys.length = 0;

    // 2. Remove the outgoing view's DOM tree from the content node.
    if (currentView) {
      content.remove(currentView);
      currentView = null;
    }

    currentViewName = name;

    // 3. Create a fresh view instance.
    const mod = await loadModule(name);
    const viewBox = mod.createView({ screen, content, config, navigate, setFooter, screenKey });
    currentView = viewBox;
    content.append(viewBox);

    // 4. Trigger the view's initial data load if it has one.
    if (typeof viewBox.refresh === 'function') {
      await viewBox.refresh();
    }

    screen.render();
  }

  function navigate(viewName) {
    showView(viewName).catch((err) => setFooter(` {red-fg}⚠ ${err.message}{/red-fg}`));
  }

  function setFooter(text) {
    footer.setContent(text);
    screen.render();
  }

  // ── Header polling ────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8'));
  const version = pkg.version || '0.2.0';

  async function updateHeader() {
    const lock = readLock();
    let servicePart;
    if (lock) {
      const health = await fetchHealth(lock.port);
      if (health) {
        const qColor = health.queueLength > 0 ? 'yellow' : 'white';
        const workingBadge = health.working ? '  {yellow-fg}⟳ working{/yellow-fg}' : '';
        const waitingBadge = health.waiting > 0 ? `  {#888888-fg}${health.waiting} watching{/#888888-fg}` : '';
        servicePart =
          `{green-fg}◉{/green-fg} {bold}ACTIVE{/bold}` +
          `  queue:{${qColor}-fg}${health.queueLength}{/${qColor}-fg}` +
          workingBadge + waitingBadge;
      } else {
        servicePart = '{yellow-fg}◈ LOCK (no response){/yellow-fg}';
      }
    } else {
      servicePart = '{#888888-fg}○ no service{/#888888-fg}';
    }
    header.setContent(` {bold}{white-fg}▸▸ TOOL FORGE{/white-fg}{/bold}   ${servicePart}{|}  {blue-fg}v${version}{/blue-fg} `);
    screen.render();
  }

  updateHeader();
  const headerTimer = setInterval(updateHeader, HEADER_POLL_MS);
  headerTimer.unref?.();

  // ── Global key bindings (persist for the entire session) ──────────────────
  screen.key(['q', 'C-c'], () => {
    const lock = readLock();
    if (lock) {
      const confirm = blessed.question({
        parent: screen, border: 'line', height: 'shrink', width: 'half',
        top: 'center', left: 'center', label: ' {red-fg}Quit{/red-fg} ', tags: true, keys: true
      });
      confirm.ask('Forge service is active. Quit anyway? (y/n)', (err, answer) => {
        if (!err && /^y/i.test(answer)) cleanup();
      });
    } else {
      cleanup();
    }
  });

  screen.key(['b', 'escape'], () => {
    if (currentViewName !== 'main-menu') navigate('main-menu');
  });

  screen.key('r', () => {
    currentView?.refresh?.();
    screen.render();
  });

  function cleanup() {
    clearInterval(headerTimer);
    screen.destroy();
    process.exit(0);
  }

  screen.on('resize', () => {
    content.height = screen.rows - 4;
    screen.render();
  });

  await showView('main-menu');
  screen.render();
}
