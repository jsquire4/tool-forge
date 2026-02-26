/**
 * TUI — Interactive selection of APIs to turn into tools.
 * Shows APIs without MCPs/tools, prompts to create, writes pending spec.
 */

import * as readline from 'readline';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { loadApis } from './api-loader.js';
import { getExistingTools } from './tools-scanner.js';
import { addEndpointManually } from './manual-entry.js';

const PENDING_SPEC_FILE = 'forge-pending-tool.json';

/**
 * Match API endpoint to existing tool (by name or path).
 * @param {object} endpoint
 * @param {string[]} existingTools
 * @returns {boolean}
 */
function hasTool(endpoint, existingTools) {
  const name = (endpoint.name || '').toLowerCase().replace(/-/g, '_');
  const normalized = new Set(existingTools.map((t) => t.toLowerCase().replace(/-/g, '_')));
  return normalized.has(name);
}

/**
 * Run the TUI.
 * @param {object} config - Full forge config (project + api)
 */
export async function runTui(config) {
  const apiConfig = config?.api || {};
  const projectConfig = config?.project || {};

  const [apis, existingTools] = await Promise.all([
    loadApis(apiConfig),
    Promise.resolve(getExistingTools(projectConfig))
  ]);

  const unavailable = apis.filter((e) => !hasTool(e, existingTools));
  const available = apis.filter((e) => hasTool(e, existingTools));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q, def = '') =>
    new Promise((res) => {
      rl.question(def ? `${q} [${def}]: ` : `${q}: `, (ans) => res(ans.trim() || def));
    });

  console.log('\n--- Tool-Forge API Discovery ---\n');
  console.log(`Existing tools: ${existingTools.length}`);
  console.log(`APIs found: ${apis.length}`);
  console.log(`APIs without tools: ${unavailable.length}\n`);

  if (unavailable.length === 0 && apis.length === 0) {
    console.log('No APIs found. Add api.discovery or api.manifestPath to forge.config.json.');
    console.log('Or add endpoints to api-endpoints.json.');
    rl.close();
    return;
  }

  if (unavailable.length === 0) {
    console.log('All discovered APIs have tools. Add more endpoints or run with --manual to add one.');
    rl.close();
    return;
  }

  console.log('APIs without tools:\n');
  unavailable.forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.method} ${e.path}  →  ${e.name}`);
  });

  console.log('\n  m. Add endpoint manually');
  console.log('  q. Quit\n');

  const choice = await ask('Select number (or m/q)', '1');

  if (choice.toLowerCase() === 'q') {
    rl.close();
    return;
  }

  let selected;
  if (choice.toLowerCase() === 'm') {
    selected = await addEndpointManually(rl);
  } else {
    const idx = parseInt(choice, 10);
    if (isNaN(idx) || idx < 1 || idx > unavailable.length) {
      console.log('Invalid selection.');
      rl.close();
      return;
    }
    selected = unavailable[idx - 1];
  }

  const confirm = await ask(`\nCreate MCP/tool for "${selected.name}"? (y/n)`, 'y');
  if (!/^y|yes$/i.test(confirm)) {
    console.log('Cancelled.');
    rl.close();
    return;
  }

  const pendingSpec = {
    _source: 'forge-api-tui',
    _createdAt: new Date().toISOString(),
    endpoint: selected,
    project: projectConfig
  };

  const outPath = resolve(process.cwd(), PENDING_SPEC_FILE);
  writeFileSync(outPath, JSON.stringify(pendingSpec, null, 2), 'utf-8');

  console.log(`\nWrote ${PENDING_SPEC_FILE}`);
  console.log('\nNext: Run /forge-tool in Claude. It will detect the pending spec and use it.');
  console.log('The tool→eval factory will run after the tool is generated.\n');

  rl.close();
}
