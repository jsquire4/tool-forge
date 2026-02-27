#!/usr/bin/env node
/**
 * Forge CLI — Entry point.
 *
 * Usage:
 *   node cli/index.js           # Full-screen TUI
 *   node cli/index.js --manual  # Skip to manual endpoint entry (fallback)
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runTui } from './tui.js';
import { addEndpointManually } from './manual-entry.js';
import * as readline from 'readline';

const CONFIG_FILE = 'forge.config.json';
const PENDING_SPEC_FILE = 'forge-pending-tool.json';

function findProjectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function loadConfig() {
  const projectRoot = findProjectRoot();
  const configPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.error(`No ${CONFIG_FILE} found in ${projectRoot}. Create one from config/forge.config.template.json`);
    process.exit(1);
  }
  const raw = readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${CONFIG_FILE} contains invalid JSON: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  process.chdir(findProjectRoot());

  const args = process.argv.slice(2);
  const manualOnly = args.includes('--manual') || args.includes('-m');

  if (manualOnly) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const endpoint = await addEndpointManually(rl);
    rl.close();

    const projectRoot = findProjectRoot();
    const config = existsSync(resolve(projectRoot, CONFIG_FILE))
      ? JSON.parse(readFileSync(resolve(projectRoot, CONFIG_FILE), 'utf-8'))
      : { project: {} };

    const pendingSpec = {
      _source: 'forge-api-tui',
      _createdAt: new Date().toISOString(),
      endpoint,
      project: config.project || {}
    };
    writeFileSync(resolve(projectRoot, PENDING_SPEC_FILE), JSON.stringify(pendingSpec, null, 2), 'utf-8');
    console.log(`\nWrote ${PENDING_SPEC_FILE}. Run /forge-tool in Claude.\n`);
    return;
  }

  const config = loadConfig();
  await runTui(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
