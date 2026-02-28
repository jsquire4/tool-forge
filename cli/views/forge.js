/**
 * Forge View — 10-phase tool generation dialogue (split-panel TUI).
 */

import blessed from 'blessed';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveModelConfig } from '../api-client.js';
import { forgeStep, createInitialState, getPhaseIndex, PHASES } from '../forge-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

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

export function createView({
  screen, content, config, navigate, setFooter,
  screenKey, openPopup, closePopup, startService
}) {
  const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });
  // Escape/b navigates back immediately — session state is auto-persisted.

  const phaseBar = blessed.box({
    parent: container, top: 0, left: 0, width: '100%', height: 1,
    tags: true, style: { fg: '#888888' }
  });

  const log = blessed.log({
    parent: container, top: 1, left: 0, width: '55%', height: '100%-5',
    tags: true, scrollable: true, alwaysScroll: true, keys: true, mouse: true,
    border: { type: 'line' }, label: ' Dialogue ',
    style: { border: { fg: '#333333' }, focus: { border: { fg: 'cyan' } } },
    scrollbar: { ch: '│', style: { fg: '#555555' } }
  });

  const specPanel = blessed.scrollablebox({
    parent: container, top: 1, left: '55%', width: '45%', height: '100%-5',
    tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' }, label: ' Live Spec ',
    style: { border: { fg: '#333333' }, focus: { border: { fg: 'cyan' } } },
    scrollbar: { ch: '│', style: { fg: '#555555' } }
  });

  const statusBar = blessed.box({
    parent: container, bottom: 3, left: 0, width: '100%', height: 1, tags: true,
    style: { fg: '#888888' }
  });

  const inputBox = blessed.textbox({
    parent: container, bottom: 0, left: 0, width: '100%', height: 3,
    border: { type: 'line' },
    label: ' Message (Enter send, Esc shortcuts, Tab panel) ',
    style: { border: { fg: '#333333' }, focus: { border: { fg: 'cyan' } } }
  });

  setFooter(
    ' {cyan-fg}Enter{/cyan-fg} send  {cyan-fg}Esc{/cyan-fg} shortcuts  ' +
    '{cyan-fg}e{/cyan-fg} edit  {cyan-fg}s{/cyan-fg} skip  {cyan-fg}m{/cyan-fg} compare  {cyan-fg}b{/cyan-fg} back'
  );

  // ── Explicit input mode management ──────────────────────────────────────
  let inputActive = false;

  function startInput() {
    inputActive = true;
    inputBox.focus();
    inputBox.style.border = { fg: 'cyan' };
    log.style.border = { fg: '#333333' };
    specPanel.style.border = { fg: '#333333' };
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
        doStep(text);
      } else {
        startInput();
      }
    });
  }

  let forgeState = createInitialState();
  let busy = false;
  let previewPending = false;
  let currentModelConfig = null;
  let db = null;
  let updateToolGenerationFn = null;

  // ── Log helpers ────────────────────────────────────────────────────────
  const appendSystem   = (t) => log.log(`{#555555-fg}── ${t} ──{/#555555-fg}`);
  const appendUser     = (t) => { log.log(''); log.log(`{cyan-fg}{bold}You:{/bold}{/cyan-fg}  ${t}`); };
  const appendAssistant = (t) => {
    if (!t?.trim()) return;
    log.log(`{green-fg}{bold}Forge:{/bold}{/green-fg} ${t.replace(/\n/g, '\n        ')}`);
  };
  const setStatus = (t) => {
    statusBar.setContent(t ? ` {#888888-fg}${t}{/#888888-fg}` : '');
    screen.render();
  };

  function updateSpecPanel() {
    const raw = JSON.stringify(forgeState.spec, null, 2);
    specPanel.setContent(raw.replace(/: null/g, ': {#444444-fg}null{/#444444-fg}'));
  }

  function updatePhaseBar() {
    const idx = getPhaseIndex(forgeState.phase);
    const n = idx === -1 ? '?' : idx + 1;
    phaseBar.setContent(
      ` {cyan-fg}Phase ${n}/${PHASES.length}: ${forgeState.phase}{/cyan-fg}` +
      `  {#888888-fg}Model: ${currentModelConfig?.model || 'n/a'}{/#888888-fg}`
    );
  }

  function saveToDb() {
    if (!db || !forgeState.generationId || !updateToolGenerationFn) return;
    try {
      updateToolGenerationFn(db, forgeState.generationId, {
        phases_completed: getPhaseIndex(forgeState.phase),
        spec_json: JSON.stringify(forgeState.spec),
        status: forgeState.phase === 'done' ? 'complete' : 'in_progress'
      });
    } catch (_) { /* non-fatal */ }
  }

  // ── File preview popup ─────────────────────────────────────────────────
  function showFilePreview(files) {
    previewPending = true;
    const lines = [];
    for (const key of ['toolFile', 'testFile']) {
      const f = files[key];
      if (!f) continue;
      lines.push(`{bold}{cyan-fg}${key === 'toolFile' ? 'Tool' : 'Test'}: ${f.path}{/cyan-fg}{/bold}`);
      lines.push('{#333333-fg}' + '─'.repeat(60) + '{/#333333-fg}');
      lines.push(f.content);
      lines.push('');
    }
    if (files.barrelDiff) {
      lines.push(`{bold}{cyan-fg}Barrel: ${files.barrelDiff.path}{/cyan-fg}{/bold}`);
      lines.push(files.barrelDiff.lineToAdd);
    }

    const popup = blessed.scrollablebox({
      parent: screen, border: 'line',
      top: 1, left: 2, right: 2, bottom: 3,
      label: ' Generated Files — [y] write  [e] editor  [n] abort ',
      tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true, mouse: true,
      content: lines.join('\n'),
      scrollbar: { ch: '│', style: { fg: '#555555' } },
      style: { border: { fg: 'cyan' } }
    });

    openPopup?.();
    popup.focus();
    screen.render();

    function closePreview() {
      closePopup?.();
      popup.destroy();
      screen.render();
      startInput();
    }

    popup.key('y', async () => {
      previewPending = false;
      closePreview();
      try {
        if (files.toolFile) {
          mkdirSync(dirname(files.toolFile.path), { recursive: true });
          writeFileSync(files.toolFile.path, files.toolFile.content, 'utf-8');
        }
        if (files.testFile) {
          mkdirSync(dirname(files.testFile.path), { recursive: true });
          writeFileSync(files.testFile.path, files.testFile.content, 'utf-8');
        }
        if (files.barrelDiff) {
          let barrel = existsSync(files.barrelDiff.path)
            ? readFileSync(files.barrelDiff.path, 'utf-8') : '';
          if (!barrel.includes(files.barrelDiff.lineToAdd)) {
            writeFileSync(
              files.barrelDiff.path,
              barrel + (barrel.endsWith('\n') ? '' : '\n') + files.barrelDiff.lineToAdd + '\n',
              'utf-8'
            );
          }
        }
        appendSystem('Files written successfully.');
      } catch (err) {
        appendSystem(`Write error: ${err.message}`);
      }
      await doStep(null);
    });

    popup.key('n', () => {
      previewPending = false;
      closePreview();
      appendSystem("File write aborted. Describe changes and I'll regenerate.");
    });

    popup.key('e', async () => {
      if (!files.toolFile?.path) {
        previewPending = false;
        closePreview();
        appendSystem('No tool file path to open in editor.');
        return;
      }
      const { spawn } = await import('child_process');
      screen.program.disableMouse();
      screen.program.normalBuffer();
      const child = spawn(process.env.EDITOR || 'vi', [files.toolFile.path], { stdio: 'inherit' });
      child.on('exit', () => {
        screen.program.alternateBuffer();
        screen.program.enableMouse();
        previewPending = false;
        closePreview();
      });
    });

    popup.key(['escape', 'b'], () => { previewPending = false; closePreview(); appendSystem('File preview closed.'); });
  }

  // ── Action handler ─────────────────────────────────────────────────────
  async function handleAction(action) {
    if (action.type === 'write_file') {
      setStatus('Generating files…');
      try {
        const { generateToolFiles } = await import('../forge-file-writer.js');
        const files = await generateToolFiles({
          spec: forgeState.spec, projectConfig: config,
          projectRoot: process.cwd(), modelConfig: currentModelConfig, existingTools: []
        });
        showFilePreview(files);
      } catch (err) { appendSystem(`File generation failed: ${err.message}`); }

    } else if (action.type === 'run_tests') {
      appendSystem('Run tests manually: ' + (action.payload?.command || 'npm test'));

    } else if (action.type === 'write_evals') {
      appendSystem('Eval generation starting…');
      try {
        const { generateEvals } = await import('../forge-eval-generator.js');
        const r = await generateEvals({
          spec: forgeState.spec, allTools: [], projectConfig: config,
          projectRoot: process.cwd(), modelConfig: currentModelConfig
        });
        mkdirSync(dirname(r.goldenPath), { recursive: true });
        writeFileSync(r.goldenPath, JSON.stringify(r.goldenCases, null, 2), 'utf-8');
        writeFileSync(r.labeledPath, JSON.stringify(r.labeledCases, null, 2), 'utf-8');
        appendSystem(`Evals written: ${r.goldenPath}, ${r.labeledPath}`);
      } catch (err) { appendSystem(`Eval generation failed: ${err.message}`); }

    } else if (action.type === 'write_verifiers') {
      appendSystem('Verifier generation starting…');
      try {
        const { generateVerifiers } = await import('../forge-verifier-generator.js');
        const r = await generateVerifiers({
          spec: forgeState.spec, projectConfig: config,
          projectRoot: process.cwd(), modelConfig: currentModelConfig
        });
        for (const vf of r.verifierFiles) {
          mkdirSync(dirname(vf.path), { recursive: true });
          writeFileSync(vf.path, vf.content, 'utf-8');
        }
        appendSystem(`${r.verifierFiles.length} verifier(s) written.`);
      } catch (err) { appendSystem(`Verifier generation failed: ${err.message}`); }

    } else if (action.type === 'compare_models') {
      navigate('model-compare');
    }
  }

  // ── Core step ──────────────────────────────────────────────────────────
  async function doStep(userInput) {
    if (busy) return;
    busy = true;
    if (userInput) appendUser(userInput);
    setStatus('Thinking…');
    try {
      const result = await forgeStep({
        state: forgeState, userInput, modelConfig: currentModelConfig,
        existingTools: [], projectConfig: config, projectRoot: process.cwd()
      });
      forgeState = result.nextState;
      if (result.assistantText) appendAssistant(result.assistantText);
      updateSpecPanel();
      updatePhaseBar();
      for (const action of result.actions || []) await handleAction(action);
      saveToDb();
    } catch (err) {
      appendSystem(`Error: ${err.message}`);
    }
    setStatus('');
    busy = false;
    screen.render();
    if (!previewPending) {
      startInput();
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────
  setImmediate(async () => {
    const env = loadEnv();
    currentModelConfig = resolveModelConfig(config, env, 'generation');

    if (!currentModelConfig.apiKey) {
      appendSystem('No API key found. Add ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings → API Keys.');
      inputBox.style.border = { fg: 'red' };
      updatePhaseBar();
      updateSpecPanel();
      screen.render();
      return;
    }

    try {
      const dbMod = await import('../db.js');
      db = dbMod.getDb(resolve(process.cwd(), config?.dbPath || 'forge.db'));
      updateToolGenerationFn = dbMod.updateToolGeneration;
      forgeState.generationId = dbMod.insertToolGeneration(db, {
        tool_name: 'new_tool',
        started_at: new Date().toISOString(),
        generation_model: currentModelConfig.model
      });
    } catch (err) { appendSystem(`DB init failed (non-fatal): ${err.message}`); }

    if (config._forgeTarget) {
      const t = config._forgeTarget;
      forgeState.spec = { ...forgeState.spec, ...t.spec };
      forgeState.phase = 'confirm';
      appendSystem(`Re-forging: ${t.spec?.name || t.toolName || '(unknown)'}`);
    }

    // If returning from model-compare with a chosen spec, apply it
    if (config._chosenSpec) {
      forgeState = { ...forgeState, spec: { ...forgeState.spec, ...config._chosenSpec } };
      config._chosenSpec = null; // consume it
      appendSystem('Applied spec from model comparison.');
    }

    updatePhaseBar();
    updateSpecPanel();
    await doStep(null);
  });

  // ── Input (managed by startInput / readInput) ────────────────────────

  // ── Key bindings ───────────────────────────────────────────────────────

  // e/i = enter input mode (vim-style)
  screenKey(['e', 'i'], () => {
    if (inputActive) return;
    startInput();
  });

  screenKey('tab', () => {
    if (inputActive) {
      inputBox.cancel();
    } else if (screen.focused === log) {
      specPanel.focus();
      log.style.border = { fg: '#333333' };
      specPanel.style.border = { fg: 'cyan' };
      screen.render();
    } else {
      startInput();
    }
  });

  screenKey('s', () => {
    if (inputActive || busy || previewPending) return;
    doStep('skip');
  });

  screenKey('m', () => {
    if (inputActive || busy || previewPending) return;
    config._forgeState = forgeState;
    config._forgeInput = null;
    navigate('model-compare');
  });

  screenKey('b', () => {
    if (inputActive) return;
    navigate('main-menu');
  });

  container.refresh = () => { /* live view — no-op */ };
  return container;
}
