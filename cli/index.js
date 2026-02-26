#!/usr/bin/env node
/**
 * Forge CLI — API discovery, verifier gap report.
 *
 * Usage:
 *   node index.js           # API TUI — discover APIs, create pending tool spec
 *   node index.js --manual  # Skip to manual endpoint entry
 *   node index.js --verifiers  # Verifier coverage gap report
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runTui } from './tui.js';
import { addEndpointManually } from './manual-entry.js';
import { writeFileSync } from 'fs';
import * as readline from 'readline';
import { runVerifierReport } from './verifier-report.js';

const CONFIG_FILE = 'forge.config.json';
const PENDING_SPEC_FILE = 'forge-pending-tool.json';

function findProjectRoot() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const cliParent = resolve(scriptDir, '..');
  return cliParent;
}

function loadConfig() {
  const projectRoot = findProjectRoot();
  const configPath = resolve(projectRoot, CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.error(`No ${CONFIG_FILE} found in ${projectRoot}. Create one from config/forge.config.template.json`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

async function main() {
  process.chdir(findProjectRoot());

  const args = process.argv.slice(2);
  const manualOnly = args.includes('--manual') || args.includes('-m');
  const verifiersOnly = args.includes('--verifiers') || args.includes('-v');

  if (verifiersOnly) {
    const config = loadConfig();
    runVerifierReport(config);
    return;
  }

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
