/**
 * Verifier Coverage View — Interactive DB-backed verifier management.
 *
 * Shows promoted tools with their bound verifiers, supports attaching/detaching
 * verifiers, creating schema/pattern verifiers inline, and registering
 * discovered custom verifiers from disk.
 */

import blessed from 'blessed';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  getDb, getAllToolRegistry, getAllVerifiers, getVerifiersForTool,
  upsertVerifier, upsertVerifierBinding, removeVerifierBinding,
  getBindingsForVerifier
} from '../db.js';
import { getExistingVerifiers } from '../verifier-scanner.js';

/**
 * Load data from DB + filesystem.
 * @param {object} config
 * @param {import('better-sqlite3').Database} db
 */
function loadData(config, db) {
  const tools = getAllToolRegistry(db).filter(r => r.lifecycle_state === 'promoted');
  const allVerifiers = getAllVerifiers(db);
  const rows = tools.map(tool => {
    const bound = getVerifiersForTool(db, tool.tool_name);
    return {
      tool: tool.tool_name,
      verifiers: bound,
      verifierDisplay: bound.length > 0
        ? bound.map(v => `${v.aciru_order} ${v.verifier_name}`).join(', ')
        : '—',
      hasVerifiers: bound.length > 0
    };
  });

  // Discover unregistered verifiers from filesystem
  let unregistered = [];
  const verification = config?.verification || {};
  if (verification?.verifiersDir) {
    const onDisk = getExistingVerifiers(verification);
    const inDb = new Set(allVerifiers.map(v => v.verifier_name));
    unregistered = onDisk.filter(name => !inDb.has(name));
  }

  return { rows, allVerifiers, unregistered };
}

/**
 * Compute next ACIRU sequence number for a category.
 * @param {object[]} allVerifiers
 * @param {string} category
 * @returns {string}
 */
function nextAciruOrder(allVerifiers, category) {
  const prefix = category + '-';
  const existing = allVerifiers
    .filter(v => v.aciru_order.startsWith(prefix))
    .map(v => parseInt(v.aciru_order.slice(prefix.length), 10))
    .filter(n => !isNaN(n));
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${category}-${String(next).padStart(4, '0')}`;
}

export function createView({ screen, content, config, navigate, setFooter, screenKey, openPopup, closePopup }) {
  // Resolve DB
  let db;
  try {
    const dbPath = resolve(process.cwd(), config?.dbPath || 'forge.db');
    if (existsSync(dbPath)) {
      db = getDb(dbPath);
    }
  } catch { /* ignore */ }

  const container = blessed.box({ top: 0, left: 0, width: '100%', height: '100%', tags: true });

  const table = blessed.listtable({
    parent: container,
    top: 0, left: 0, width: '100%', height: '100%-2',
    tags: true, keys: true, vi: true, mouse: true,
    border: { type: 'line' }, align: 'left',
    style: {
      header: { bold: true, fg: 'cyan' },
      cell: { selected: { bg: '#1a3a5c', fg: 'white' } },
      border: { fg: '#333333' }
    },
    pad: 1
  });

  const summaryBar = blessed.box({
    parent: container,
    bottom: 0, left: 0, width: '100%', height: 2, tags: true
  });

  setFooter(
    ' {cyan-fg}Enter{/cyan-fg} actions  {cyan-fg}a{/cyan-fg} attach  {cyan-fg}d{/cyan-fg} detach  ' +
    '{cyan-fg}n{/cyan-fg} new  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}b{/cyan-fg} back'
  );

  let currentData = { rows: [], allVerifiers: [], unregistered: [] };

  function refreshView() {
    if (!db) {
      table.setData([
        ['Tool', 'ACIRU Order', 'Verifiers', 'Status'],
        ['No database available', '', '', '']
      ]);
      summaryBar.setContent('');
      screen.render();
      return;
    }

    try {
      currentData = loadData(config, db);
    } catch (err) {
      table.setData([
        ['Tool', 'ACIRU Order', 'Verifiers', 'Status'],
        [`Error: ${String(err.message).replace(/\{/g, '\\{')}`, '', '', '']
      ]);
      screen.render();
      return;
    }

    const { rows, allVerifiers, unregistered } = currentData;

    if (rows.length === 0) {
      table.setData([
        ['Tool', 'ACIRU Order', 'Verifiers', 'Status'],
        ['No promoted tools found', '', '', '']
      ]);
      summaryBar.setContent('');
      screen.render();
      return;
    }

    table.setData([
      ['Tool', 'ACIRU Order', 'Verifiers', 'Status'],
      ...rows.map(r => {
        const orders = r.verifiers.map(v => v.aciru_order).join(', ') || '—';
        const names = r.verifiers.map(v => {
          const bindings = getBindingsForVerifier(db, v.verifier_name);
          const isWild = bindings.some(b => b.tool_name === '*');
          return isWild ? `${v.verifier_name} [*]` : v.verifier_name;
        }).join(', ') || '—';
        const status = r.hasVerifiers
          ? '{green-fg}✓{/green-fg}'
          : '{yellow-fg}⚠ none{/yellow-fg}';
        return [r.tool, orders, names, status];
      })
    ]);

    const unverifiedCount = rows.filter(r => !r.hasVerifiers).length;
    summaryBar.setContent(
      ` {white-fg}${rows.length}{/white-fg} tools | ` +
      `{white-fg}${allVerifiers.length}{/white-fg} verifiers | ` +
      (unverifiedCount > 0
        ? `{yellow-fg}${unverifiedCount} unverified{/yellow-fg}`
        : '{green-fg}all verified{/green-fg}') +
      (unregistered.length > 0
        ? ` | {cyan-fg}${unregistered.length} discovered on disk{/cyan-fg}`
        : '')
    );

    screen.render();
  }

  // ── Action Popup ──────────────────────────────────────────────────────────

  function getSelectedRow() {
    const sel = table.selected;
    if (sel < 1 || sel > currentData.rows.length) return null;
    return currentData.rows[sel - 1];
  }

  function showActionMenu(row) {
    const items = ['Attach verifier', 'Detach verifier', 'Create schema verifier', 'Create pattern verifier'];
    if (currentData.unregistered.length > 0) items.push('Register discovered');
    items.push('Cancel');

    const popup = blessed.list({
      parent: screen,
      top: 'center', left: 'center',
      width: 40, height: items.length + 2,
      tags: true, keys: true, vi: true, mouse: true,
      border: { type: 'line' },
      label: ` {cyan-fg}${row.tool}{/cyan-fg} `,
      style: {
        selected: { bg: '#1a3a5c', fg: 'white' },
        border: { fg: 'cyan' }
      },
      items
    });

    openPopup && openPopup();
    popup.focus();
    screen.render();

    popup.on('select', (item, idx) => {
      popup.detach();
      closePopup && closePopup();
      screen.render();

      switch (idx) {
        case 0: showAttachMenu(row); break;
        case 1: showDetachMenu(row); break;
        case 2: showSchemaForm(row); break;
        case 3: showPatternForm(row); break;
        case 4:
          if (currentData.unregistered.length > 0) showRegisterMenu(row);
          break;
      }
    });

    popup.key(['escape', 'q'], () => {
      popup.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Attach ────────────────────────────────────────────────────────────────

  function showAttachMenu(row) {
    const boundNames = new Set(row.verifiers.map(v => v.verifier_name));
    const available = currentData.allVerifiers.filter(v => !boundNames.has(v.verifier_name));

    if (available.length === 0) {
      showMessage('No unbound verifiers available');
      return;
    }

    const items = available.map(v => `${v.aciru_order} ${v.verifier_name} (${v.type})`);
    items.push('Cancel');

    const popup = blessed.list({
      parent: screen,
      top: 'center', left: 'center',
      width: 50, height: Math.min(items.length + 2, 15),
      tags: true, keys: true, vi: true, mouse: true,
      border: { type: 'line' },
      label: ' Attach verifier ',
      style: { selected: { bg: '#1a3a5c', fg: 'white' }, border: { fg: 'green' } },
      items
    });

    openPopup && openPopup();
    popup.focus();
    screen.render();

    popup.on('select', (item, idx) => {
      popup.detach();
      closePopup && closePopup();
      if (idx < available.length) {
        upsertVerifierBinding(db, { verifier_name: available[idx].verifier_name, tool_name: row.tool });
        refreshView();
      }
      table.focus();
      screen.render();
    });

    popup.key(['escape'], () => {
      popup.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Detach ────────────────────────────────────────────────────────────────

  function showDetachMenu(row) {
    if (row.verifiers.length === 0) {
      showMessage('No verifiers to detach');
      return;
    }

    const items = row.verifiers.map(v => `${v.aciru_order} ${v.verifier_name}`);
    items.push('Cancel');

    const popup = blessed.list({
      parent: screen,
      top: 'center', left: 'center',
      width: 50, height: Math.min(items.length + 2, 15),
      tags: true, keys: true, vi: true, mouse: true,
      border: { type: 'line' },
      label: ' Detach verifier ',
      style: { selected: { bg: '#1a3a5c', fg: 'white' }, border: { fg: 'yellow' } },
      items
    });

    openPopup && openPopup();
    popup.focus();
    screen.render();

    popup.on('select', (item, idx) => {
      popup.detach();
      closePopup && closePopup();
      if (idx < row.verifiers.length) {
        removeVerifierBinding(db, row.verifiers[idx].verifier_name, row.tool);
        refreshView();
      }
      table.focus();
      screen.render();
    });

    popup.key(['escape'], () => {
      popup.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Schema Verifier Form ──────────────────────────────────────────────────

  function showSchemaForm(row) {
    const form = blessed.form({
      parent: screen,
      top: 'center', left: 'center',
      width: 60, height: 14,
      tags: true, keys: true,
      border: { type: 'line' },
      label: ' Create Schema Verifier ',
      style: { border: { fg: 'green' } }
    });

    blessed.text({ parent: form, top: 1, left: 2, content: 'Name:', tags: true });
    const nameInput = blessed.textbox({
      parent: form, top: 1, left: 10, width: 44, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 3, left: 2, content: 'Required fields (comma-sep):', tags: true });
    const reqInput = blessed.textbox({
      parent: form, top: 4, left: 2, width: 52, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 6, left: 2, content: 'Property types (key:type, key:type):', tags: true });
    const propsInput = blessed.textbox({
      parent: form, top: 7, left: 2, width: 52, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 9, left: 2, content: 'ACIRU category:', tags: true });
    const catInput = blessed.textbox({
      parent: form, top: 9, left: 20, width: 5, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }, value: 'I'
    });

    const submitBtn = blessed.button({
      parent: form, top: 11, left: 2, width: 12, height: 1,
      content: ' Create ', tags: true, mouse: true,
      style: { fg: 'white', bg: 'green', focus: { bg: 'cyan' } }
    });

    const cancelBtn = blessed.button({
      parent: form, top: 11, left: 16, width: 12, height: 1,
      content: ' Cancel ', tags: true, mouse: true,
      style: { fg: 'white', bg: '#555', focus: { bg: '#777' } }
    });

    openPopup && openPopup();
    nameInput.focus();
    screen.render();

    submitBtn.on('press', () => {
      const name = nameInput.getValue().trim();
      if (!name) { showMessage('Name is required'); return; }

      const category = (catInput.getValue().trim() || 'I').toUpperCase();
      const order = nextAciruOrder(currentData.allVerifiers, category);
      const required = reqInput.getValue().trim()
        ? reqInput.getValue().trim().split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const properties = {};
      const propsStr = propsInput.getValue().trim();
      if (propsStr) {
        for (const pair of propsStr.split(',')) {
          const [k, t] = pair.split(':').map(s => s.trim());
          if (k && t) properties[k] = { type: t };
        }
      }

      upsertVerifier(db, {
        verifier_name: name,
        display_name: name,
        type: 'schema',
        aciru_category: category,
        aciru_order: order,
        spec_json: JSON.stringify({ required, properties }),
        description: `Schema verifier for ${row.tool}`
      });
      upsertVerifierBinding(db, { verifier_name: name, tool_name: row.tool });

      form.detach();
      closePopup && closePopup();
      refreshView();
      table.focus();
    });

    cancelBtn.on('press', () => {
      form.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });

    form.key(['escape'], () => {
      form.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Pattern Verifier Form ─────────────────────────────────────────────────

  function showPatternForm(row) {
    const form = blessed.form({
      parent: screen,
      top: 'center', left: 'center',
      width: 60, height: 14,
      tags: true, keys: true,
      border: { type: 'line' },
      label: ' Create Pattern Verifier ',
      style: { border: { fg: 'green' } }
    });

    blessed.text({ parent: form, top: 1, left: 2, content: 'Name:', tags: true });
    const nameInput = blessed.textbox({
      parent: form, top: 1, left: 10, width: 44, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 3, left: 2, content: 'Match pattern (regex, optional):', tags: true });
    const matchInput = blessed.textbox({
      parent: form, top: 4, left: 2, width: 52, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 6, left: 2, content: 'Reject pattern (regex, optional):', tags: true });
    const rejectInput = blessed.textbox({
      parent: form, top: 7, left: 2, width: 52, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }
    });

    blessed.text({ parent: form, top: 9, left: 2, content: 'Outcome:', tags: true });
    const outcomeInput = blessed.textbox({
      parent: form, top: 9, left: 12, width: 10, height: 1,
      inputOnFocus: true, style: { fg: 'white', bg: '#333' }, value: 'warn'
    });

    const submitBtn = blessed.button({
      parent: form, top: 11, left: 2, width: 12, height: 1,
      content: ' Create ', tags: true, mouse: true,
      style: { fg: 'white', bg: 'green', focus: { bg: 'cyan' } }
    });

    const cancelBtn = blessed.button({
      parent: form, top: 11, left: 16, width: 12, height: 1,
      content: ' Cancel ', tags: true, mouse: true,
      style: { fg: 'white', bg: '#555', focus: { bg: '#777' } }
    });

    openPopup && openPopup();
    nameInput.focus();
    screen.render();

    submitBtn.on('press', () => {
      const name = nameInput.getValue().trim();
      if (!name) { showMessage('Name is required'); return; }

      const order = nextAciruOrder(currentData.allVerifiers, 'I');
      const spec = {};
      const match = matchInput.getValue().trim();
      const reject = rejectInput.getValue().trim();
      const outcome = outcomeInput.getValue().trim() || 'warn';
      if (match) spec.match = match;
      if (reject) spec.reject = reject;
      spec.outcome = outcome;

      upsertVerifier(db, {
        verifier_name: name,
        display_name: name,
        type: 'pattern',
        aciru_category: 'I',
        aciru_order: order,
        spec_json: JSON.stringify(spec),
        description: `Pattern verifier for ${row.tool}`
      });
      upsertVerifierBinding(db, { verifier_name: name, tool_name: row.tool });

      form.detach();
      closePopup && closePopup();
      refreshView();
      table.focus();
    });

    cancelBtn.on('press', () => {
      form.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });

    form.key(['escape'], () => {
      form.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Register Discovered ───────────────────────────────────────────────────

  function showRegisterMenu(row) {
    const items = [...currentData.unregistered, 'Cancel'];

    const popup = blessed.list({
      parent: screen,
      top: 'center', left: 'center',
      width: 50, height: Math.min(items.length + 2, 15),
      tags: true, keys: true, vi: true, mouse: true,
      border: { type: 'line' },
      label: ' Register discovered verifier ',
      style: { selected: { bg: '#1a3a5c', fg: 'white' }, border: { fg: 'cyan' } },
      items
    });

    openPopup && openPopup();
    popup.focus();
    screen.render();

    popup.on('select', (item, idx) => {
      popup.detach();
      closePopup && closePopup();
      if (idx < currentData.unregistered.length) {
        const name = currentData.unregistered[idx];
        const verifiersDir = config?.verification?.verifiersDir || '';
        const filePath = resolve(process.cwd(), verifiersDir, `${name}.verifier.js`);
        const order = nextAciruOrder(currentData.allVerifiers, 'R');

        upsertVerifier(db, {
          verifier_name: name,
          display_name: name,
          type: 'custom',
          aciru_category: 'R',
          aciru_order: order,
          spec_json: JSON.stringify({ filePath, exportName: 'verify' }),
          description: `Custom verifier discovered on disk`
        });
        upsertVerifierBinding(db, { verifier_name: name, tool_name: row.tool });
        refreshView();
      }
      table.focus();
      screen.render();
    });

    popup.key(['escape'], () => {
      popup.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Message popup ─────────────────────────────────────────────────────────

  function showMessage(msg) {
    const box = blessed.message({
      parent: screen,
      top: 'center', left: 'center',
      width: msg.length + 6, height: 5,
      tags: true, border: { type: 'line' },
      style: { border: { fg: 'yellow' } }
    });
    openPopup && openPopup();
    box.display(msg, 2, () => {
      box.detach();
      closePopup && closePopup();
      table.focus();
      screen.render();
    });
  }

  // ── Key bindings ──────────────────────────────────────────────────────────

  table.on('select', () => {
    const row = getSelectedRow();
    if (row) showActionMenu(row);
  });

  screenKey('a', () => {
    const row = getSelectedRow();
    if (row) showAttachMenu(row);
  });

  screenKey('d', () => {
    const row = getSelectedRow();
    if (row) showDetachMenu(row);
  });

  screenKey('n', () => {
    const row = getSelectedRow();
    if (row) showSchemaForm(row);
  });

  container.refresh = () => refreshView();

  refreshView();
  table.focus();
  return container;
}
