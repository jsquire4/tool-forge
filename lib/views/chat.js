/**
 * Chat View — Interactive chat to test model connection and tool routing.
 *
 * - Loads API key (Anthropic or OpenAI) from .env
 * - Loads tool definitions from toolsDir so the model sees the actual tools
 * - Loads system prompt from config.systemPromptPath if set
 * - Handles multi-turn tool calling: shows what was called, sends stub results back,
 *   then continues so you can see the model's final response
 * - Tab: toggle focus between input and log (for scrolling history)
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { llmTurn } from '../api-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

// ── Helpers ────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const MAX_TOOL_DEPTH = 3;

// ── View ───────────────────────────────────────────────────────────────────

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup, startService }) {
  const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });

  // ── Info bar ──────────────────────────────────────────────────────────────
  const infoBar = blessed.box({
    parent: container,
    top: 0, left: 0, width: '100%', height: 1, tags: true,
    style: { bg: 'default' }
  });

  // ── Message log ───────────────────────────────────────────────────────────
  const log = blessed.log({
    parent: container,
    top: 1, left: 0, width: '100%', height: '100%-5',
    tags: true, scrollable: true, alwaysScroll: true,
    keys: true, vi: false, mouse: true,
    border: { type: 'line' },
    style: { border: { fg: '#333333' }, focus: { border: { fg: 'cyan' } } },
    scrollbar: { ch: '│', style: { fg: '#555555' } }
  });

  // ── Status bar (shows "Thinking..." etc.) ────────────────────────────────
  const statusBar = blessed.box({
    parent: container,
    bottom: 3, left: 0, width: '100%', height: 1,
    tags: true, style: { fg: '#888888' }
  });

  // ── Input box ─────────────────────────────────────────────────────────────
  const inputBox = blessed.textbox({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 3,
    border: { type: 'line' },
    style: {
      border: { fg: '#333333' },
      focus: { border: { fg: 'cyan' } }
    },
    label: ' Message (Enter send, Esc shortcuts, Tab scroll) '
  });

  setFooter(
    ' {cyan-fg}Enter{/cyan-fg} send  {cyan-fg}Esc{/cyan-fg} shortcuts  ' +
    '{cyan-fg}e{/cyan-fg} edit  {cyan-fg}c{/cyan-fg} clear  {cyan-fg}r{/cyan-fg} reset  {cyan-fg}b{/cyan-fg} back'
  );

  // ── Explicit input mode management ──────────────────────────────────────
  let inputActive = false;

  function startInput() {
    inputActive = true;
    inputBox.focus();
    inputBox.style.border = { fg: 'cyan' };
    log.style.border = { fg: '#333333' };
    screen.render();
    inputBox.readInput((err, value) => {
      inputActive = false;
      if (err || value === undefined || value === null) {
        // Escape — exit to command mode
        log.focus();
        log.style.border = { fg: 'cyan' };
        inputBox.style.border = { fg: '#333333' };
        screen.render();
        return;
      }
      // Enter — submit
      const text = (value || '').trim();
      inputBox.clearValue();
      screen.render();
      if (text) {
        sendMessage(text);
      } else {
        startInput();
      }
    });
  }

  // ── Conversation state ────────────────────────────────────────────────────
  let apiMessages = [];      // provider-format message history
  let busy = false;
  let provider = null;
  let apiKey = null;
  let model = null;
  let systemPrompt = '';
  let tools = [];
  let initialized = false;

  // ── Init: load config, key, tools ─────────────────────────────────────────
  async function init() {
    const env = loadEnv();
    if (env.ANTHROPIC_API_KEY) {
      provider = 'anthropic';
      apiKey = env.ANTHROPIC_API_KEY;
      const configModel = config?.models?.generation || config?.model;
      model = configModel?.startsWith('claude') ? configModel : 'claude-sonnet-4-6';
    } else if (env.OPENAI_API_KEY) {
      provider = 'openai';
      apiKey = env.OPENAI_API_KEY;
      const configModel = config?.models?.generation || config?.model;
      model = configModel && !configModel.startsWith('claude') ? configModel : 'gpt-4o-mini';
    } else {
      infoBar.setContent(
        ' {red-fg}⚠ No API key{/red-fg}  Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings → API Keys'
      );
      screen.render();
      startInput();
      return;
    }

    // Load system prompt
    if (config?.systemPromptPath) {
      const sp = resolve(PROJECT_ROOT, config.systemPromptPath);
      if (existsSync(sp)) {
        try { systemPrompt = readFileSync(sp, 'utf-8'); } catch (_) { /* ignore */ }
      }
    }

    // Load tools
    try {
      const { getToolsForEval } = await import('../eval-runner.js');
      tools = getToolsForEval(config);
    } catch (_) { tools = []; }

    infoBar.setContent(
      ` {cyan-fg}${model}{/cyan-fg}  via {white-fg}${provider}{/white-fg}` +
      `  {#888888-fg}${tools.length} tool${tools.length !== 1 ? 's' : ''} loaded` +
      `${systemPrompt ? '  system prompt active' : ''}{/#888888-fg}`
    );

    if (tools.length === 0) {
      appendSystem('No tools loaded. Configure toolsDir in forge.config.json to test tool routing.');
    } else {
      appendSystem(`Tools available: ${tools.map((t) => t.name).join(', ')}`);
    }
    if (systemPrompt) appendSystem('System prompt loaded.');
    appendSystem('Type a message and press Enter to chat.');

    initialized = true;
    screen.render();
    startInput();
  }

  // ── Log helpers ────────────────────────────────────────────────────────────
  function appendSystem(text) {
    log.log(`{#555555-fg}── ${text} ──{/#555555-fg}`);
  }

  function appendUser(text) {
    log.log('');
    log.log(`{cyan-fg}{bold}You:{/bold}{/cyan-fg}  ${text}`);
  }

  function appendAssistant(text) {
    if (!text.trim()) return;
    log.log(`{green-fg}{bold}Model:{/bold}{/green-fg} ${text.replace(/\n/g, '\n       ')}`);
  }

  function appendToolCall(name, input) {
    const args = Object.keys(input).length
      ? '  ' + Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')
      : '';
    log.log(`{yellow-fg}🔧 called:{/yellow-fg} {bold}${name}{/bold}${args}`);
    log.log(`{#555555-fg}   ↳ stub result returned (no real execution){/#555555-fg}`);
  }

  function setStatus(text) {
    statusBar.setContent(text ? ` {#888888-fg}${text}{/#888888-fg}` : '');
    screen.render();
  }

  // ── API call with multi-turn tool handling ─────────────────────────────────
  async function doTurn(depth = 0) {
    if (depth >= MAX_TOOL_DEPTH) {
      appendSystem('Max tool call depth reached.');
      return;
    }

    const turn = await llmTurn({
      provider,
      apiKey,
      model,
      system: systemPrompt,
      messages: apiMessages,
      tools,
      maxTokens: 1024
    });

    // Show text response (might be a preamble before tool calls)
    if (turn.text) appendAssistant(turn.text);

    if (turn.toolCalls.length > 0) {
      // Show each tool call
      for (const tc of turn.toolCalls) appendToolCall(tc.name, tc.input || {});

      if (provider === 'anthropic') {
        // Append assistant turn (with tool_use blocks)
        apiMessages.push({ role: 'assistant', content: turn.rawContent });
        // Append stub tool results
        apiMessages.push({
          role: 'user',
          content: turn.toolCalls.map((tc) => ({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Stub result for ${tc.name}. In production, this would return real data. Input was: ${JSON.stringify(tc.input)}`
          }))
        });
      } else {
        // OpenAI: append assistant message with tool_calls, then tool results
        apiMessages.push({ role: 'assistant', ...turn.rawContent });
        for (const tc of turn.toolCalls) {
          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Stub result for ${tc.name}. Input: ${JSON.stringify(tc.input)}`
          });
        }
      }

      // Continue conversation to get the final text response
      setStatus('Processing tool results…');
      await doTurn(depth + 1);
    } else {
      // Final text-only response — add to history
      if (provider === 'anthropic') {
        apiMessages.push({ role: 'assistant', content: turn.rawContent });
      } else {
        if (turn.text) {
          apiMessages.push({ role: 'assistant', content: turn.text });
        }
      }
    }
  }

  async function sendMessage(text) {
    if (busy) return;
    if (!initialized) {
      statusBar.setContent(' {yellow-fg}Not ready — add an API key in Settings → API Keys / Secrets{/yellow-fg}');
      screen.render();
      return;
    }
    busy = true;

    appendUser(text);

    apiMessages.push({ role: 'user', content: text });

    setStatus('Waiting for response…');
    try {
      await doTurn();
    } catch (err) {
      appendSystem(`Error: ${err.message}`);
    }

    setStatus('');
    log.log('');
    busy = false;
    screen.render();
    startInput();
  }

  // ── Input handling (managed by startInput / readInput) ───────────────────

  // e/i = enter input mode (vim-style)
  screenKey(['e', 'i'], () => {
    if (inputActive) return;
    startInput();
  });

  // Tab: toggle focus between input and log
  screenKey('tab', () => {
    if (inputActive) {
      inputBox.cancel();
    } else {
      startInput();
    }
  });

  // c = clear log (only in command mode)
  screenKey('c', () => {
    if (inputActive) return;
    log.setContent('');
    appendSystem('Log cleared.');
    screen.render();
  });

  // r = reset conversation (only in command mode)
  screenKey('r', () => {
    if (inputActive) return;
    apiMessages = [];
    log.setContent('');
    appendSystem('Conversation reset.');
    screen.render();
  });

  container.refresh = () => { /* no-op; chat state is live */ };

  // Defer init so tui.js can append container to the screen before log.log() writes
  setImmediate(() => { init(); });
  return container;
}

