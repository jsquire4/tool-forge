/**
 * Forge Agent View — Stage-aware LLM chat panel for building MCP tool definitions.
 *
 * Layout:
 *   phaseBar (1 row, top) — current stage indicator
 *   log (fills middle)    — chat history, auto-scroll
 *   inputBox (3 rows, bottom) — user input
 *
 * Stages: orient → report → name-describe → skeptic →
 *         tool-writing → eval-writing → verifier-creation → promote
 *
 * Stage skill files are loaded from context/forge-agent/stages/{name}.md.
 * Base system prompt from context/forge-agent/system-prompt.md.
 * Conversation history is persisted to SQLite via cli/db.js.
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const STAGES_DIR = resolve(PROJECT_ROOT, 'context/forge-agent/stages');
const BASE_PROMPT_PATH = resolve(PROJECT_ROOT, 'context/forge-agent/system-prompt.md');

// ── Stage registry ──────────────────────────────────────────────────────────

export const STAGES = [
  'orient',
  'report',
  'name-describe',
  'skeptic',
  'tool-writing',
  'eval-writing',
  'verifier-creation',
  'promote'
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load the base system prompt. Returns '' if file is missing.
 * @returns {string}
 */
export function loadBasePrompt() {
  try {
    if (!existsSync(BASE_PROMPT_PATH)) return '';
    return readFileSync(BASE_PROMPT_PATH, 'utf-8');
  } catch (_) {
    return '';
  }
}

/**
 * Load a stage skill file by stage name. Returns '' if missing or unreadable.
 * @param {string} stageName
 * @returns {string}
 */
export function loadStageSkill(stageName) {
  try {
    const filePath = resolve(STAGES_DIR, `${stageName}.md`);
    if (!existsSync(STAGES_DIR)) return '';
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

/**
 * Build the stage label string for the phase bar.
 * @param {string} stageName
 * @param {number} totalStages
 * @returns {string}
 */
export function computeStageLabel(stageName, totalStages) {
  if (!totalStages || totalStages === 0) {
    return `Stage ?/${totalStages || 0}: ${stageName}`;
  }
  const idx = STAGES.indexOf(stageName);
  const n = idx === -1 ? '?' : idx + 1;
  return `Stage ${n}/${totalStages}: ${stageName}`;
}

/**
 * Build the combined system prompt for a turn.
 * @param {string} baseContent
 * @param {string} stageContent
 * @returns {string}
 */
function buildSystemPrompt(baseContent, stageContent) {
  const parts = [];
  if (baseContent && baseContent.trim()) parts.push(baseContent.trim());
  if (stageContent && stageContent.trim()) parts.push(stageContent.trim());
  return parts.join('\n\n---\n\n');
}

/**
 * Load and parse .env file from project root.
 * @returns {object}
 */
function loadEnv() {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const out = {};
  try {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* ignore */ }
  return out;
}

// ── View ────────────────────────────────────────────────────────────────────

export function createView({
  screen, content, config, navigate, setFooter,
  screenKey, openPopup, closePopup, startService
}) {
  const container = blessed.box({
    top: 0, left: 0, width: '100%', height: '100%', tags: true
  });
  container.wantsBackConfirm = true;

  // ── Layout ──────────────────────────────────────────────────────────────

  const phaseBar = blessed.box({
    parent: container, top: 0, left: 0, width: '100%', height: 1,
    tags: true, style: { fg: '#888888' }
  });

  const log = blessed.log({
    parent: container, top: 1, left: 0, width: '100%', height: '100%-4',
    tags: true, scrollable: true, alwaysScroll: true, keys: true, mouse: true,
    border: { type: 'line' }, label: ' Forge Agent ',
    style: {
      border: { fg: '#333333' },
      focus: { border: { fg: 'cyan' } }
    },
    scrollbar: { ch: '│', style: { fg: '#555555' } }
  });

  const inputBox = blessed.textbox({
    parent: container, bottom: 0, left: 0, width: '100%', height: 3,
    inputOnFocus: true, border: { type: 'line' },
    label: ' Message (Enter send, Tab focus, ] next stage, [ prev stage) ',
    style: {
      border: { fg: '#333333' },
      focus: { border: { fg: 'cyan' } }
    }
  });

  setFooter(
    ' {cyan-fg}Enter{/cyan-fg} send  {cyan-fg}Tab{/cyan-fg} focus  ' +
    '{cyan-fg}]{/cyan-fg} next stage  {cyan-fg}[{/cyan-fg} prev stage  {cyan-fg}b{/cyan-fg} back'
  );

  // ── State ────────────────────────────────────────────────────────────────

  let currentStageIdx = 0;
  let busy = false;
  let modelConfig = null;
  let db = null;
  let sessionId = null;

  // apiMessages is the LLM conversation history (role/content pairs)
  let apiMessages = [];

  // ── Log helpers ──────────────────────────────────────────────────────────

  const appendSystem = (t) => {
    log.log(`{#555555-fg}── ${t} ──{/#555555-fg}`);
    screen.render();
  };

  const appendUser = (t) => {
    log.log('');
    log.log(`{cyan-fg}{bold}You:{/bold}{/cyan-fg}  ${t}`);
    screen.render();
  };

  const appendAssistant = (t) => {
    if (!t || !t.trim()) return;
    log.log(`{green-fg}{bold}Agent:{/bold}{/green-fg} ${t.replace(/\n/g, '\n        ')}`);
    screen.render();
  };

  // ── Phase bar ────────────────────────────────────────────────────────────

  function updatePhaseBar() {
    const stageName = STAGES[currentStageIdx] || 'unknown';
    const label = computeStageLabel(stageName, STAGES.length);
    phaseBar.setContent(
      ` {cyan-fg}${label}{/cyan-fg}` +
      `  {#888888-fg}Model: ${modelConfig?.model || 'n/a'}{/#888888-fg}`
    );
    screen.render();
  }

  // ── Stage navigation ─────────────────────────────────────────────────────

  function advanceStage() {
    if (busy) return;
    if (currentStageIdx < STAGES.length - 1) {
      currentStageIdx++;
      appendSystem(`Advanced to stage: ${STAGES[currentStageIdx]}`);
      updatePhaseBar();
    }
  }

  function rewindStage() {
    if (busy) return;
    if (currentStageIdx > 0) {
      currentStageIdx--;
      appendSystem(`Rewound to stage: ${STAGES[currentStageIdx]}`);
      updatePhaseBar();
    }
  }

  // ── Session persistence ──────────────────────────────────────────────────

  function persistMessage(role, content) {
    if (!db || !sessionId) return;
    try {
      const { insertConversationMessage } = require('../db.js'); // dynamic handled below
    } catch (_) { /* non-fatal */ }
    // Use the already-imported module (loaded in init)
    if (!db._insertMsg) return;
    try {
      db._insertMsg({ session_id: sessionId, stage: STAGES[currentStageIdx] || 'unknown', role, content });
    } catch (err) {
      process.stderr.write(`[forge-agent] DB write failed: ${err.message}\n`);
    }
  }

  // ── Core LLM step ────────────────────────────────────────────────────────

  async function doStep(userText) {
    if (busy) return;
    busy = true;

    if (!modelConfig || !modelConfig.apiKey) {
      appendSystem('No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings → API Keys.');
      busy = false;
      return;
    }

    if (userText) {
      appendUser(userText);
      apiMessages.push({ role: 'user', content: userText });
      persistMessage('user', userText);
    }

    // Build system prompt: base + current stage
    const baseContent = loadBasePrompt();
    const stageName = STAGES[currentStageIdx] || 'unknown';
    const stageContent = loadStageSkill(stageName);
    const systemPrompt = buildSystemPrompt(baseContent, stageContent);

    if (!stageContent && stageName !== 'unknown') {
      appendSystem(`Warning: stage file missing for '${stageName}' — using base prompt only.`);
    }

    try {
      // Ensure alternating messages: if last message is assistant, add [continue]
      let callMessages = [...apiMessages];
      if (
        callMessages.length > 0 &&
        callMessages[callMessages.length - 1].role === 'assistant' &&
        !userText
      ) {
        callMessages = [...callMessages, { role: 'user', content: '[continue]' }];
      }

      const { llmTurn } = await import('../api-client.js');
      const result = await llmTurn({
        provider: modelConfig.provider,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        system: systemPrompt,
        messages: callMessages,
        maxTokens: 4096
      });

      let text = result.text || '';

      // Check for [STAGE_COMPLETE] marker
      const stageCompletePattern = /^\[STAGE_COMPLETE\]\s*$/m;
      const hasComplete = stageCompletePattern.test(text);
      if (hasComplete) {
        text = text.replace(stageCompletePattern, '').trim();
      }

      if (text) {
        appendAssistant(text);
        apiMessages.push({ role: 'assistant', content: text });
        persistMessage('assistant', text);
      }

      // Advance stage after displaying text
      if (hasComplete) {
        if (currentStageIdx < STAGES.length - 1) {
          currentStageIdx++;
          appendSystem(`Stage complete. Moving to: ${STAGES[currentStageIdx]}`);
          updatePhaseBar();
        } else {
          appendSystem('All stages complete. Session finished.');
          persistMessage('system', '[COMPLETE]');
        }
      }

    } catch (err) {
      appendSystem(`Error: ${err.message}`);
    }

    busy = false;
    inputBox.focus();
    screen.render();
  }

  // ── Session resumption ───────────────────────────────────────────────────

  async function promptResume(sessions, dbMod) {
    return new Promise((resolve) => {
      openPopup();

      if (sessions.length === 1) {
        const s = sessions[0];
        const label = `Resume session at stage '${s.stage}'? (last: ${s.last_updated?.slice(0, 16) || '?'})`;
        const q = blessed.question({
          parent: screen, border: 'line', height: 'shrink', width: '60%',
          top: 'center', left: 'center',
          label: ' Resume Session? ', tags: true, keys: true
        });
        q.ask(`${label}\n[R]esume / [N]ew session (y=resume, n=new)`, (err, answer) => {
          q.destroy();
          closePopup();
          if (!err && /^y/i.test(answer)) {
            resolve(s.session_id);
          } else {
            resolve(null);
          }
        });
      } else {
        // Multiple sessions — show list
        const listLines = sessions.slice(0, 5).map((s, i) =>
          `${i + 1}. stage=${s.stage}  last=${s.last_updated?.slice(0, 16) || '?'}`
        ).join('\n');
        const q = blessed.question({
          parent: screen, border: 'line', height: 'shrink', width: '70%',
          top: 'center', left: 'center',
          label: ' Resume a Session? ', tags: true, keys: true
        });
        q.ask(
          `Incomplete sessions:\n${listLines}\n\nEnter session number to resume, or 0 for new:`,
          (err, answer) => {
            q.destroy();
            closePopup();
            if (err) { resolve(null); return; }
            const n = parseInt(answer, 10);
            if (n >= 1 && n <= sessions.length) {
              resolve(sessions[n - 1].session_id);
            } else {
              resolve(null);
            }
          }
        );
      }
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  setImmediate(async () => {
    try {
      const env = loadEnv();
      const { resolveModelConfig } = await import('../api-client.js');
      modelConfig = resolveModelConfig(config, env, 'generation');

      if (!modelConfig.apiKey) {
        appendSystem('No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings → API Keys.');
        inputBox.style.border = { fg: 'red' };
        updatePhaseBar();
        screen.render();
        return;
      }

      // Load DB
      let dbMod;
      try {
        dbMod = await import('../db.js');
        const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
        db = dbMod.getDb(dbPath);
        // Attach the insertConversationMessage helper directly to db for persistMessage
        db._insertMsg = (row) => dbMod.insertConversationMessage(db, row);
      } catch (err) {
        appendSystem(`DB init failed (non-fatal): ${err.message}`);
        dbMod = null;
      }

      // Check for incomplete sessions
      if (db && dbMod) {
        let incompleteSessions = [];
        try {
          incompleteSessions = dbMod.getIncompleteSessions(db);
        } catch (_) { /* ignore */ }

        if (incompleteSessions.length > 0) {
          const resumeId = await promptResume(incompleteSessions, dbMod);
          if (resumeId) {
            // Restore session
            sessionId = resumeId;
            const history = dbMod.getConversationHistory(db, sessionId);

            // Find the last stage used
            const lastRow = [...history].reverse().find((r) => r.stage);
            if (lastRow) {
              const stageIdx = STAGES.indexOf(lastRow.stage);
              if (stageIdx !== -1) currentStageIdx = stageIdx;
            }

            // Restore apiMessages (user + assistant only)
            apiMessages = history
              .filter((r) => r.role === 'user' || r.role === 'assistant')
              .map((r) => ({ role: r.role, content: r.content }));

            // Display history in log
            appendSystem(`Resumed session. Stage: ${STAGES[currentStageIdx]}`);
            for (const row of history.filter((r) => r.role !== 'system')) {
              if (row.role === 'user') appendUser(row.content);
              else if (row.role === 'assistant') appendAssistant(row.content);
            }

            updatePhaseBar();
            inputBox.focus();
            screen.render();
            return;
          }
        }
      }

      // Start fresh session
      if (dbMod) {
        sessionId = dbMod.createSession();
      }

      updatePhaseBar();

      // Kick off first LLM turn to greet the user
      await doStep(null);

    } catch (err) {
      appendSystem(`Init error: ${err.message}`);
    }

    inputBox.focus();
    screen.render();
  });

  // ── Input handling ────────────────────────────────────────────────────────

  inputBox.on('submit', (value) => {
    const text = (value || '').trim();
    inputBox.clearValue();
    if (text) doStep(text);
    else inputBox.focus();
    screen.render();
  });

  // ── Key bindings ──────────────────────────────────────────────────────────

  screenKey('tab', () => {
    if (screen.focused === inputBox) {
      log.focus();
      log.style.border = { fg: 'cyan' };
      inputBox.style.border = { fg: '#333333' };
    } else {
      inputBox.focus();
      inputBox.style.border = { fg: 'cyan' };
      log.style.border = { fg: '#333333' };
    }
    screen.render();
  });

  screenKey(']', () => {
    if (busy) return;
    advanceStage();
  });

  screenKey('[', () => {
    if (busy) return;
    rewindStage();
  });

  screenKey('b', () => {
    const confirm = blessed.question({
      parent: screen, border: 'line', height: 'shrink', width: 'half',
      top: 'center', left: 'center', label: ' Leave Forge Agent? ', tags: true, keys: true
    });
    openPopup();
    confirm.ask('Leave? Session is saved and can be resumed. (y/n)', (err, answer) => {
      confirm.destroy();
      closePopup();
      if (!err && /^y/i.test(answer)) navigate('main-menu');
      else { inputBox.focus(); screen.render(); }
    });
  });

  container.refresh = () => { /* live view — no-op */ };
  return container;
}
