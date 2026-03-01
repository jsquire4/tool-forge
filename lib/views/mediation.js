/**
 * Mediation View — Fast-track dialogue for resolving tool registry drift.
 *
 * Reuses forgeStep from forge-engine. Starts at 'description' phase with spec.name
 * pre-filled from config._mediationTarget. Right panel shows overlap matrix.
 *
 * Active phases: description, evals only (skips explore/skeptic/fields/routing/deps).
 */

import blessed from 'blessed';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ── Helpers ────────────────────────────────────────────────────────────────

function loadEnv(projectRoot) {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  const out = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── View ───────────────────────────────────────────────────────────────────

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup, startService }) {
  const toolName = config._mediationTarget || null;
  config._mediationTarget = null; // consume — prevent stale reads on re-entry

  const container = blessed.box({
    top: 0, left: 0, width: '100%', height: '100%', tags: true
  });

  // ── Layout: left chat, right overlap matrix ────────────────────────────
  const chatBox = blessed.box({
    parent: container,
    top: 0, left: 0,
    width: '60%', height: '100%',
    tags: true, scrollable: true,
    border: { type: 'line' },
    label: ` Mediation: ${toolName || '(no target)'} `,
    style: { border: { fg: 'yellow' } }
  });

  const rightPanel = blessed.box({
    parent: container,
    top: 0, right: 0,
    width: '40%', height: '50%',
    tags: true, scrollable: true,
    border: { type: 'line' },
    label: ' Overlap Matrix ',
    style: { border: { fg: 'cyan' } }
  });

  const specPanel = blessed.box({
    parent: container,
    bottom: 0, right: 0,
    width: '40%', height: '50%',
    tags: true, scrollable: true,
    border: { type: 'line' },
    label: ' Current Spec ',
    style: { border: { fg: '#555555' } }
  });

  const inputBox = blessed.textbox({
    parent: container,
    bottom: 0, left: 0,
    width: '60%', height: 3,
    border: { type: 'line' },
    label: ' Your reply ',
    keys: true, inputOnFocus: true,
    style: { border: { fg: 'blue' }, focus: { border: { fg: 'cyan' } } }
  });

  setFooter(' {cyan-fg}Enter{/cyan-fg} send  {cyan-fg}b{/cyan-fg} back (abandon mediation)');

  if (!toolName) {
    chatBox.setContent('\n  {red-fg}No mediation target set. Go to Tools & Evals and use Mediate.{/red-fg}');
    screen.render();
    return container;
  }

  // ── State ──────────────────────────────────────────────────────────────
  let forgeState = null;
  let modelConfig = null;
  let db = null;
  let openAlertId = null;
  let baselinePassRate = null;
  let busy = false;
  const chatHistory = [];

  function appendChat(role, text) {
    chatHistory.push({ role, text });
    const rendered = chatHistory.map((m) =>
      m.role === 'assistant'
        ? `{cyan-fg}Forge:{/cyan-fg} ${m.text}`
        : `{white-fg}You:{/white-fg} ${m.text}`
    ).join('\n\n');
    chatBox.setContent('\n' + rendered);
    chatBox.setScrollPerc(100);
    screen.render();
  }

  function updateSpecPanel(spec) {
    if (!spec) { specPanel.setContent(''); return; }
    const lines = [
      spec.name ? `{cyan-fg}name:{/cyan-fg} ${spec.name}` : '',
      spec.description ? `{cyan-fg}desc:{/cyan-fg} ${spec.description}` : '',
      spec.triggerPhrases?.length ? `{cyan-fg}triggers:{/cyan-fg}\n  ${spec.triggerPhrases.join('\n  ')}` : '',
    ].filter(Boolean);
    specPanel.setContent('\n ' + lines.join('\n '));
    screen.render();
  }

  // ── Init ───────────────────────────────────────────────────────────────
  async function init() {
    busy = true;
    openPopup?.(); // block global keys during init

    try {
      // Load env + model config
      const projectRoot = process.cwd();
      const env = loadEnv(projectRoot);
      const { resolveModelConfig } = await import('../api-client.js');
      modelConfig = resolveModelConfig(config, env, 'generation');

      if (!modelConfig.apiKey) {
        appendChat('assistant', '{red-fg}No API key found. Add one in Settings → API Keys.{/red-fg}');
        closePopup?.();
        busy = false;
        return;
      }

      // Load DB + open alert
      const dbPath = resolve(projectRoot, config?.dbPath || 'forge.db');
      if (existsSync(dbPath)) {
        const { getDb, getDriftAlerts, getToolRegistry } = await import('../db.js');
        db = getDb(dbPath);
        const alerts = getDriftAlerts(db, toolName);
        if (alerts.length > 0) {
          openAlertId = alerts[0].id;
        }
        const regRow = getToolRegistry(db, toolName);
        baselinePassRate = regRow?.baseline_pass_rate ?? null;
      }

      // Load forge engine and create initial state at 'description' phase
      const { createInitialState, forgeStep } = await import('../forge-engine.js');
      forgeState = createInitialState();
      forgeState.phase = 'description';
      forgeState.spec.name = toolName;

      // Build overlap matrix via one-shot LLM call
      await buildOverlapMatrix();

      // Kick off description phase
      closePopup?.();
      busy = false;
      await advanceForge(null);

    } catch (err) {
      appendChat('assistant', `{red-fg}Init error: ${err.message}{/red-fg}`);
      closePopup?.();
      busy = false;
    }
  }

  async function buildOverlapMatrix() {
    let matrixContent = ' {#888888-fg}(loading overlap matrix…){/#888888-fg}';
    rightPanel.setContent(matrixContent);
    screen.render();

    try {
      // Get suspects from drift alert
      let suspects = [];
      if (db && openAlertId) {
        const alert = db.prepare('SELECT trigger_tools FROM drift_alerts WHERE id = ?').get(openAlertId);
        if (alert?.trigger_tools) {
          try { suspects = JSON.parse(alert.trigger_tools); } catch (_) {}
        }
      }

      if (suspects.length === 0) {
        rightPanel.setContent(' {#888888-fg}No overlap suspects identified.{/#888888-fg}');
        screen.render();
        return;
      }

      // Assess overlap with one LLM call
      const { llmTurn } = await import('../api-client.js');
      const { getToolsWithMetadata } = await import('../tools-scanner.js');
      const project = config?.project || {};
      const allTools = getToolsWithMetadata(project);

      const flaggedTool = allTools.find((t) => t.name === toolName);
      const suspectTools = allTools.filter((t) => suspects.includes(t.name));

      if (!flaggedTool || suspectTools.length === 0) {
        rightPanel.setContent(` {yellow-fg}Suspects: ${suspects.join(', ')}{/yellow-fg}\n {#888888-fg}(tool files not found){/#888888-fg}`);
        screen.render();
        return;
      }

      const prompt = `Assess description and trigger phrase overlap between the flagged tool and each suspect.

Flagged tool:
Name: ${flaggedTool.name}
Description: ${flaggedTool.description || '(none)'}
Triggers: ${(flaggedTool.triggerPhrases || []).join(', ') || '(none)'}

Suspects:
${suspectTools.map((t) => `Name: ${t.name}\nDescription: ${t.description || '(none)'}\nTriggers: ${(t.triggerPhrases || []).join(', ') || '(none)'}`).join('\n\n')}

For each suspect, rate overlap as: high / medium / low / none.
Respond with one line per suspect in this format:
[suspect_name]: [overlap_level] — [one sentence reason]`;

      const result = await llmTurn({
        provider: modelConfig.provider,
        apiKey: modelConfig.apiKey,
        model: modelConfig.model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        timeoutMs: 30_000
      });

      const lines = (result.text || '').split('\n').filter((l) => l.trim());
      const matrixLines = lines.map((l) => {
        if (l.includes('high')) return ` {red-fg}${l}{/red-fg}`;
        if (l.includes('medium')) return ` {yellow-fg}${l}{/yellow-fg}`;
        if (l.includes('low')) return ` {green-fg}${l}{/green-fg}`;
        return ` {#888888-fg}${l}{/#888888-fg}`;
      });

      rightPanel.setContent(matrixLines.join('\n') || ' {#888888-fg}(no overlap data){/#888888-fg}');
      screen.render();

    } catch (_) {
      rightPanel.setContent(' {red-fg}Overlap matrix unavailable{/red-fg}');
      screen.render();
    }
  }

  async function advanceForge(userInput) {
    if (!forgeState || !modelConfig) return;

    // Only allow description and evals phases in mediation
    const allowedPhases = ['description', 'evals'];
    if (!allowedPhases.includes(forgeState.phase)) {
      // Skip to description or signal completion
      if (forgeState.phase === 'done' || forgeState.phase === 'verifiers') {
        await handleMediationComplete();
        return;
      }
      // Jump to done if past evals
      forgeState.phase = 'done';
      await handleMediationComplete();
      return;
    }

    busy = true;
    try {
      const { forgeStep } = await import('../forge-engine.js');
      const result = await forgeStep({
        state: forgeState,
        userInput,
        modelConfig,
        projectConfig: config,
        projectRoot: process.cwd()
      });

      forgeState = result.nextState;
      updateSpecPanel(forgeState.spec);

      if (result.assistantText) {
        appendChat('assistant', result.assistantText);
      }

      // Check for write_evals action
      const evalsAction = result.actions?.find((a) => a.type === 'write_evals');
      if (evalsAction) {
        await runMediationEvals();
        return;
      }

      // If done phase reached
      if (forgeState.phase === 'done') {
        await handleMediationComplete();
        return;
      }

    } catch (err) {
      appendChat('assistant', `{red-fg}Error: ${err.message}{/red-fg}`);
    } finally {
      busy = false;
    }
  }

  async function runMediationEvals() {
    appendChat('assistant', 'Running evals to check if description/triggers resolve the drift…');
    busy = true;
    try {
      const { runEvals } = await import('../eval-runner.js');
      const result = await runEvals(
        toolName,
        config,
        process.cwd(),
        (progress) => {
          appendChat('assistant', `  Case ${progress.done}/${progress.total}: ${progress.passed ? '✓' : '✗'}`);
        }
      );

      const newPassRate = result.total > 0 ? result.passed / result.total : 0;
      const recovered = baselinePassRate != null
        ? newPassRate >= baselinePassRate - 0.05
        : newPassRate >= 0.8;

      appendChat('assistant',
        `Eval complete: ${result.passed}/${result.total} passed (${Math.round(newPassRate * 100)}%). ` +
        (recovered
          ? '{green-fg}Recovery threshold met!{/green-fg}'
          : `{yellow-fg}Not yet at baseline (${baselinePassRate != null ? Math.round(baselinePassRate * 100) + '%' : '?'}). Try refining further.{/yellow-fg}`)
      );

      if (recovered && openAlertId && db) {
        // Resolve the alert and promote the same tool back to 'promoted' state.
        // We do NOT call resolveDrift (which swaps in a replacement); we resolve
        // the alert directly and update the lifecycle.
        const { resolveDriftAlert, updateToolLifecycle } = await import('../db.js');
        resolveDriftAlert(db, openAlertId);
        updateToolLifecycle(db, toolName, {
          lifecycle_state: 'promoted',
          promoted_at: new Date().toISOString()
        });
        appendChat('assistant', '{green-fg}Drift resolved. Navigating to Tools & Evals…{/green-fg}');
        setTimeout(() => navigate('tools-evals'), 2000);
      }

    } catch (err) {
      appendChat('assistant', `{red-fg}Eval error: ${err.message}{/red-fg}`);
    } finally {
      busy = false;
    }
  }

  async function handleMediationComplete() {
    appendChat('assistant', 'Mediation dialogue complete. Returning to Tools & Evals.');
    setTimeout(() => navigate('tools-evals'), 1500);
  }

  // ── Input handling ─────────────────────────────────────────────────────
  inputBox.key('enter', async () => {
    if (busy) return;
    const val = inputBox.getValue().trim();
    inputBox.clearValue();
    screen.render();
    if (!val) return;
    appendChat('user', val);
    await advanceForge(val);
  });

  inputBox.key(['escape'], () => {
    // Don't navigate — let global b handle it
  });

  // ── Start init ─────────────────────────────────────────────────────────
  init().catch((err) => {
    appendChat('assistant', `{red-fg}Fatal: ${err.message}{/red-fg}`);
  });

  inputBox.focus();
  screen.render();
  return container;
}
