/**
 * Model Compare View — side-by-side model spec comparison.
 *
 * Runs the current forge state against two models in parallel (config.models.generation
 * and config.models.secondary) and shows the resulting specs side by side so the user
 * can choose which result to carry forward into the forge dialogue.
 *
 * Key bindings:
 *   a / 1  — use Model A result
 *   b / 2  — use Model B result
 *   m      — merge (Model A base, overlay non-null fields from Model B)
 *   Escape — cancel, navigate back to forge
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { forgeStep, createInitialState } from '../forge-engine.js';
import { resolveModelConfig } from '../api-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE   = resolve(__dirname, '../../.env');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read key=value pairs from .env into a plain object.
 * Skips blank lines and comments. Strips surrounding quotes from values.
 *
 * @returns {Record<string, string>}
 */
function loadEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const lines = readFileSync(ENV_FILE, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

/**
 * Deep-merge two spec objects: use specA as the base and overlay any non-null,
 * non-undefined top-level field from specB.
 *
 * @param {object} specA
 * @param {object} specB
 * @returns {object}
 */
function mergeSpecs(specA, specB) {
  const merged = { ...specA };
  for (const [key, val] of Object.entries(specB)) {
    if (val !== null && val !== undefined) {
      merged[key] = val;
    }
  }
  return merged;
}

/**
 * Format a forgeStep result for display in a panel.
 * Shows the assistant text (if any) followed by the spec as pretty-printed JSON.
 *
 * @param {{ assistantText: string, nextState: { spec: object } }} result
 * @returns {string}
 */
function formatResult(result) {
  const parts = [];
  if (result.assistantText && result.assistantText.trim()) {
    parts.push(result.assistantText.trim());
    parts.push('');
    parts.push('─'.repeat(40));
    parts.push('');
  }
  parts.push('Spec:');
  try {
    parts.push(JSON.stringify(result.nextState.spec, null, 2));
  } catch (_) {
    parts.push('(could not serialise spec)');
  }
  return parts.join('\n');
}

// ── createView ─────────────────────────────────────────────────────────────

export function createView({
  screen,
  content,
  config,
  navigate,
  setFooter,
  screenKey,
  openPopup,
  closePopup,
  startService
}) {
  // ── Root container (fills the content area) ─────────────────────────────

  const root = blessed.box({
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true
  });
  // Escape/b navigates back immediately.

  // ── Header row ──────────────────────────────────────────────────────────

  const header = blessed.box({
    parent: root,
    top: 0, left: 0, width: '100%', height: 1,
    tags: true,
    content: '{bold}{cyan-fg} Model Comparison{/cyan-fg}{/bold}',
    style: { bg: 'black' }
  });

  // ── Status bar (below header, above panels) ──────────────────────────────

  const statusBar = blessed.box({
    parent: root,
    top: 1, left: 0, width: '100%', height: 1,
    tags: true,
    content: '{yellow-fg} Initialising…{/yellow-fg}',
    style: { bg: 'black' }
  });

  // ── Panel labels row ─────────────────────────────────────────────────────

  const labelRow = blessed.box({
    parent: root,
    top: 2, left: 0, width: '100%', height: 2,
    tags: true,
    style: { bg: 'black' }
  });

  const labelA = blessed.box({
    parent: labelRow,
    top: 0, left: 0, width: '50%', height: 2,
    tags: true,
    content: '{bold} Model A:{/bold} {cyan-fg}loading…{/cyan-fg}\n {#555555-fg}───────────────────────────────────{/#555555-fg}',
    style: { bg: 'black' }
  });

  const labelB = blessed.box({
    parent: labelRow,
    top: 0, left: '50%', width: '50%', height: 2,
    tags: true,
    content: '{bold} Model B:{/bold} {cyan-fg}loading…{/cyan-fg}\n {#555555-fg}───────────────────────────────────{/#555555-fg}',
    style: { bg: 'black' }
  });

  // ── Panel boxes (scrollable) ─────────────────────────────────────────────

  const panelTop  = 4;   // header(1) + status(1) + labelRow(2)
  const panelHeight = `100%-${panelTop + 1}`;  // leave 1 row for footer

  const panelA = blessed.scrollablebox({
    parent: root,
    top: panelTop, left: 0, width: '50%', height: panelHeight,
    border: { type: 'line', fg: '#333333' },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    tags: false,
    content: '',
    scrollbar: { ch: '│', style: { fg: '#555555' } },
    style: { bg: 'black', fg: 'white' }
  });

  const panelB = blessed.scrollablebox({
    parent: root,
    top: panelTop, left: '50%', width: '50%', height: panelHeight,
    border: { type: 'line', fg: '#333333' },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    tags: false,
    content: '',
    scrollbar: { ch: '│', style: { fg: '#555555' } },
    style: { bg: 'black', fg: 'white' }
  });

  // ── State ────────────────────────────────────────────────────────────────

  let modelAResult  = null;
  let modelBResult  = null;
  let modelAConfig  = null;
  let modelBConfig  = null;
  let forgeState    = null;
  let ready         = false;   // true once both results have arrived

  // ── Helpers ──────────────────────────────────────────────────────────────

  function setStatus(text) {
    statusBar.setContent(text);
    screen.render();
  }

  function updateLabelA(modelName) {
    labelA.setContent(
      `{bold} Model A:{/bold} {cyan-fg}${modelName}{/cyan-fg}\n {#555555-fg}───────────────────────────────────{/#555555-fg}`
    );
  }

  function updateLabelB(modelName) {
    labelB.setContent(
      `{bold} Model B:{/bold} {cyan-fg}${modelName}{/cyan-fg}\n {#555555-fg}───────────────────────────────────{/#555555-fg}`
    );
  }

  function showFooterReady() {
    setFooter(
      ' {bold}a{/bold}/{bold}1{/bold} use A  ' +
      '{bold}2{/bold} use B  ' +
      '{bold}m{/bold} merge  ' +
      '{bold}Escape{/bold} back'
    );
  }

  function showFooterWaiting() {
    setFooter(' {yellow-fg}Running comparison…{/yellow-fg}  {bold}Escape{/bold} back');
  }

  // ── DB recording ─────────────────────────────────────────────────────────

  async function recordComparison(chosenModel) {
    try {
      const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
      const { getDb, insertModelComparison } = await import('../db.js');
      const db = getDb(dbPath);
      insertModelComparison(db, {
        tool_name:    forgeState?.spec?.name || 'unknown',
        model_a:      modelAConfig?.model || 'unknown',
        model_b:      modelBConfig?.model || 'unknown',
        spec_a_json:  modelAResult ? JSON.stringify(modelAResult.nextState.spec) : null,
        spec_b_json:  modelBResult ? JSON.stringify(modelBResult.nextState.spec) : null,
        chosen_model: chosenModel,
        phase:        forgeState?.phase || null
      });
    } catch (_) {
      // Non-fatal — DB write failures should not block the workflow.
    }
  }

  // ── Choice actions ────────────────────────────────────────────────────────

  async function chooseA() {
    if (!ready || !modelAResult) return;
    config._chosenSpec = modelAResult.nextState.spec;
    await recordComparison(modelAConfig?.model || 'model_a');
    navigate('forge');
  }

  async function chooseB() {
    if (!ready || !modelBResult) return;
    config._chosenSpec = modelBResult.nextState.spec;
    await recordComparison(modelBConfig?.model || 'model_b');
    navigate('forge');
  }

  async function chooseMerge() {
    if (!ready || !modelAResult || !modelBResult) return;
    config._chosenSpec = mergeSpecs(
      modelAResult.nextState.spec,
      modelBResult.nextState.spec
    );
    await recordComparison('merge');
    navigate('forge');
  }

  // ── Key bindings ─────────────────────────────────────────────────────────

  screenKey(['a', '1'], () => { chooseA(); });
  screenKey(['2'],      () => { chooseB(); });
  screenKey(['m'],      () => { chooseMerge(); });
  screenKey(['escape'], () => { navigate('forge'); });

  // Also handle scroll between panels with Tab
  screenKey(['tab'], () => {
    if (screen.focused === panelA) {
      panelB.focus();
    } else {
      panelA.focus();
    }
    screen.render();
  });

  // ── Main async init (deferred to avoid blocking render) ──────────────────

  setImmediate(async () => {
    // 1. Load environment
    const env = loadEnv();

    // 2. Resolve model configs
    modelAConfig = resolveModelConfig(config, env, 'generation');
    modelBConfig = resolveModelConfig(config, env, 'secondary');

    // 3. Guard: no secondary model
    if (!modelBConfig.model) {
      updateLabelA(modelAConfig.model || 'unknown');
      updateLabelB('not configured');
      panelA.setContent('');
      panelB.setContent(
        'No secondary model configured.\n\n' +
        'Set models.secondary in Settings (option 1 → secondary role).'
      );
      setStatus('{red-fg} No secondary model configured.{/red-fg}');
      setFooter(' {bold}Escape{/bold} back');
      screen.render();
      return;
    }

    // 4. Update labels with resolved model names
    updateLabelA(modelAConfig.model || 'unknown');
    updateLabelB(modelBConfig.model || 'unknown');
    screen.render();

    // 5. Determine forge state
    forgeState = config._forgeState || createInitialState();
    if (!config._forgeState) {
      // No live state — inject a synthetic user input so the explore phase
      // has something to work with during a standalone comparison test.
      forgeState = {
        ...forgeState,
        messages: [{ role: 'user', content: config._forgeInput || 'test comparison' }]
      };
    }

    const userInput = config._forgeInput || null;

    // 6. Show running status and run both models in parallel
    setStatus('{yellow-fg} Running comparison against both models…{/yellow-fg}');
    showFooterWaiting();

    let errorA = null;
    let errorB = null;

    [modelAResult, modelBResult] = await Promise.all([
      forgeStep({
        state: forgeState,
        userInput,
        modelConfig: modelAConfig,
        existingTools: [],
        projectConfig: config,
        projectRoot: process.cwd()
      }).catch((err) => {
        errorA = err;
        return null;
      }),
      forgeStep({
        state: forgeState,
        userInput,
        modelConfig: modelBConfig,
        existingTools: [],
        projectConfig: config,
        projectRoot: process.cwd()
      }).catch((err) => {
        errorB = err;
        return null;
      })
    ]);

    // 7. Populate panels with results (or error messages)
    if (errorA || !modelAResult) {
      panelA.setContent(
        `Error calling ${modelAConfig.model}:\n\n${errorA?.message || 'unknown error'}`
      );
    } else {
      panelA.setContent(formatResult(modelAResult));
    }

    if (errorB || !modelBResult) {
      panelB.setContent(
        `Error calling ${modelBConfig.model}:\n\n${errorB?.message || 'unknown error'}`
      );
    } else {
      panelB.setContent(formatResult(modelBResult));
    }

    // 8. Mark ready and update status/footer
    const readyA = !!modelAResult;
    const readyB = !!modelBResult;
    ready = readyA || readyB;

    if (readyA && readyB) {
      setStatus('{green-fg} Done.{/green-fg}  Pick a result or merge.');
      setFooter(
        ' {bold}a{/bold}/{bold}1{/bold} use A  ' +
        '{bold}b{/bold}/{bold}2{/bold} use B  ' +
        '{bold}m{/bold} merge  ' +
        '{bold}Escape{/bold} back'
      );
    } else if (readyA) {
      const failures = [errorA && 'A', errorB && 'B'].filter(Boolean).join(', ');
      setStatus(`{yellow-fg} Model(s) failed: ${failures}.  Showing partial results.{/yellow-fg}`);
      setFooter(
        ' {bold}a{/bold}/{bold}1{/bold} use A  ' +
        '{#555555-fg}b/2 use B (unavailable){/#555555-fg}  ' +
        '{#555555-fg}m merge (unavailable){/#555555-fg}  ' +
        '{bold}Escape{/bold} back'
      );
    } else if (readyB) {
      const failures = [errorA && 'A', errorB && 'B'].filter(Boolean).join(', ');
      setStatus(`{yellow-fg} Model(s) failed: ${failures}.  Showing partial results.{/yellow-fg}`);
      setFooter(
        '{#555555-fg} a/1 use A (unavailable){/#555555-fg}  ' +
        '{bold}b{/bold}/{bold}2{/bold} use B  ' +
        '{#555555-fg}m merge (unavailable){/#555555-fg}  ' +
        '{bold}Escape{/bold} back'
      );
    } else {
      const failures = [errorA && 'A', errorB && 'B'].filter(Boolean).join(', ');
      setStatus(`{red-fg} Error in model(s): ${failures}.  Check API keys in Settings.{/red-fg}`);
      setFooter(' {bold}Escape{/bold} back');
    }

    panelA.focus();
    screen.render();
  });

  // Return the root node so tui.js can track it as the active view box.
  return root;
}
