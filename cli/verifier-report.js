/**
 * Verifier Report — Gap detection: tools without verifier coverage.
 * Run with: node cli/index.js --verifiers
 */

import { getToolsWithMetadata } from './tools-scanner.js';
import { getExistingVerifiers } from './verifier-scanner.js';
import { inferOutputGroups, getVerifiersForGroups } from './output-groups.js';

/**
 * Build and print verifier coverage report.
 * @param {object} config - Full forge config
 */
export function runVerifierReport(config) {
  const verification = config?.verification;
  const project = config?.project;

  if (!verification?.enabled) {
    console.log('Verification is disabled in forge.config.json. Set verification.enabled: true');
    return;
  }

  const tools = getToolsWithMetadata(project);
  const verifiers = getExistingVerifiers(verification);

  console.log('\n--- Verifier Coverage Report ---\n');
  console.log(`Tools: ${tools.length}`);
  console.log(`Verifiers: ${verifiers.length}\n`);

  if (tools.length === 0) {
    console.log('No tools found. Add tools first.');
    return;
  }

  const rows = [];
  const toolsWithoutCoverage = [];
  const suggestedVerifiers = new Set();

  for (const tool of tools) {
    const groups = inferOutputGroups(tool);
    const covering = getVerifiersForGroups(groups).filter((v) => verifiers.includes(v));
    const suggested = getVerifiersForGroups(groups).filter((v) => !verifiers.includes(v));
    suggested.forEach((v) => suggestedVerifiers.add(v));

    const coverage = covering.length > 0 ? covering.join(', ') : '—';
    rows.push({ tool: tool.name, groups: groups.join(', '), coverage });

    if (covering.length === 0) {
      toolsWithoutCoverage.push({ ...tool, groups, suggested });
    }
  }

  console.log('| Tool              | Output Groups   | Verifier Coverage |');
  console.log('|-------------------|-----------------|-------------------|');
  for (const r of rows) {
    const tool = r.tool.padEnd(17).slice(0, 17);
    const groups = r.groups.padEnd(15).slice(0, 15);
    const cov = r.coverage.padEnd(17).slice(0, 17);
    console.log(`| ${tool} | ${groups} | ${cov} |`);
  }

  if (toolsWithoutCoverage.length > 0) {
    console.log('\nTools without verifier coverage:');
    for (const t of toolsWithoutCoverage) {
      console.log(`  • ${t.name} — output groups: ${t.groups.join(', ')}`);
    }
    if (suggestedVerifiers.size > 0) {
      console.log('\nSuggested verifiers:');
      for (const v of suggestedVerifiers) {
        console.log(`  • ${v}`);
      }
    }
    console.log('\nRun /forge-verifier in Claude to create verifiers.');
  } else {
    console.log('\nAll tools have verifier coverage.');
  }
  console.log('');
}
