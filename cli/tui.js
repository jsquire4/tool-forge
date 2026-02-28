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

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LOCK_FILE = resolve(PROJECT_ROOT, '.forge-service.lock');

function readLock() {
  if (!existsSync(LOCK_FILE)) return null;
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf-8')); } catch (_) { return null; }
}

export async function runTui(config) {
  let blessed;
  try {
    blessed = (await import('blessed')).default;
  } catch {
    throw new Error(
      'The "blessed" package is required for the TUI but is not installed. ' +
      'Install it with: npm install blessed'
    );
  }

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

  // Chrome elements that should never be destroyed during view transitions.
  const chromeElements = new Set([header, headerRule, content, footerRule, footer]);

  // ── View management ───────────────────────────────────────────────────────
  let currentViewName = 'main-menu';
  let currentView = null;
  const moduleCache = {};   // avoids re-awaiting the same ESM module import
  let popupDepth = 0;       // incremented by openPopup(), decremented by closePopup()

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

  /** Call before showing any popup overlay. Prevents global 'b'/'escape' from navigating away. */
  function openPopup() { popupDepth++; }

  /** Call when a popup overlay is closed/destroyed. */
  function closePopup() { popupDepth = Math.max(0, popupDepth - 1); }

  /**
   * Start the forge service if it is not already running.
   * Spawns forge-service.js detached. The header poll picks up the new lock within 3s.
   */
  async function startService() {
    const lock = readLock();
    if (lock) {
      // Stale lock — remove before spawning
      try { unlinkSync(LOCK_FILE); } catch (_) { /* ignore */ }
    }
    const { spawn } = await import('child_process');
    const child = spawn('node', [resolve(__dirname, 'forge-service.js')], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  }

  async function loadModule(name) {
    if (!moduleCache[name]) {
      moduleCache[name] = await import(`./views/${name}.js`);
    }
    return moduleCache[name];
  }

  // ── Auto-refresh timer ────────────────────────────────────────────────────
  const VIEW_REFRESH_MS = 100;
  let refreshTimer = null;
  let refreshGeneration = 0;  // bumped on navigation to cancel in-flight refreshes

  function scheduleViewRefresh() {
    clearTimeout(refreshTimer);
    const gen = refreshGeneration;
    refreshTimer = setTimeout(async () => {
      if (gen !== refreshGeneration) return; // navigation happened — abort
      if (popupDepth === 0 && currentView?.refresh) {
        try { await currentView.refresh(); } catch (_) { /* swallow */ }
      }
      if (gen !== refreshGeneration) return; // navigation during refresh — don't reschedule
      scheduleViewRefresh();
    }, VIEW_REFRESH_MS);
    refreshTimer.unref?.();
  }

  async function showView(name) {
    // 0. Stop the auto-refresh timer and invalidate any in-flight refresh.
    clearTimeout(refreshTimer);
    refreshGeneration++;

    // 1. Unregister all view-local key bindings from the outgoing view.
    for (const { keys, fn } of viewKeys) {
      screen.unkey(keys, fn);
    }
    viewKeys.length = 0;

    // 2. Reset popup depth — any orphaned popups from the outgoing view are gone.
    popupDepth = 0;

    // 3. Remove the outgoing view's DOM tree from the content node.
    if (currentView) {
      content.remove(currentView);
      currentView = null;
    }

    // 3b. Destroy any orphaned overlays (popups parented directly to screen).
    for (const child of [...screen.children]) {
      if (!chromeElements.has(child)) {
        try { child.destroy(); } catch (_) { /* ignore */ }
      }
    }

    // 3c. Force full screen buffer reallocation so smartCSR doesn't leave
    //     stale characters from the outgoing view (e.g. noticeBar text).
    screen.realloc();

    currentViewName = name;

    // 4. Create a fresh view instance.
    const mod = await loadModule(name);
    const viewBox = mod.createView({
      screen, content, config, navigate, setFooter, screenKey,
      openPopup, closePopup, startService
    });
    currentView = viewBox;
    content.append(viewBox);

    // 5. Trigger the view's initial data load if it has one.
    if (typeof viewBox.refresh === 'function') {
      await viewBox.refresh();
    }

    screen.render();

    // 6. Start auto-refresh cycle for this view.
    scheduleViewRefresh();
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
    const modelName = config?.models?.generation || config?.model || 'claude-sonnet-4-6';
    header.setContent(
      ` {bold}{white-fg}▸▸ TOOL FORGE{/white-fg}{/bold}` +
      `  {#888888-fg}build · test · verify{/#888888-fg}` +
      `{|}  {cyan-fg}${modelName}{/cyan-fg}  {blue-fg}v${version}{/blue-fg} `
    );
    screen.render();
  }

  updateHeader();
  const headerTimer = setInterval(updateHeader, 30_000); // refresh every 30s for model changes
  headerTimer.unref?.();

  // ── Global key bindings (persist for the entire session) ──────────────────
  screen.key(['q', 'C-c'], () => {
    cleanup();
  });

  screen.key(['b', 'escape'], () => {
    if (popupDepth > 0) return; // a popup is open — let it handle the key
    if (currentViewName !== 'main-menu') navigate('main-menu');
  });

  screen.key('r', () => {
    if (popupDepth > 0) return;
    currentView?.refresh?.();
    screen.render();
  });

  function cleanup() {
    clearTimeout(refreshTimer);
    clearInterval(headerTimer);
    try { screen.destroy(); } catch (_) {}
    process.exit(0);
  }

  screen.on('resize', () => {
    content.height = screen.rows - 4;
    screen.render();
  });

  await showView(config._startOnOnboarding ? 'onboarding' : 'main-menu');
  screen.render();
}
