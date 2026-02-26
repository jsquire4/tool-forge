/**
 * Tools Scanner — Discovers existing tools from barrel and tool files.
 * Used to diff: APIs without tools = available for MCP/tool creation.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Extract tool names from barrel file (exports).
 * @param {string} barrelsPath
 * @returns {string[]}
 */
function scanBarrel(barrelsPath) {
  const abs = resolve(process.cwd(), barrelsPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf-8');
  const names = [];
  const lines = content.split('\n').filter((l) => !l.trim().startsWith('//'));
  const re = /export\s+\{\s*(\w+Tool)\s*\}\s+from\s+['"]\.\/([^'"]+)['"]/g;
  let m;
  const text = lines.join('\n');
  while ((m = re.exec(text))) {
    const exportName = m[1];
    const fileBase = m[2].replace(/\.tool\.(ts|js)$/, '').replace(/-/g, '_');
    const snake = exportName.replace(/Tool$/, '').replace(/([A-Z])/g, (c) => '_' + c.toLowerCase()).replace(/^_/, '');
    names.push(snake || fileBase);
  }
  return names;
}

/**
 * Scan tool files for `name: 'snake_case'` pattern.
 * @param {string} toolsDir
 * @returns {string[]}
 */
function scanToolFiles(toolsDir) {
  const abs = resolve(process.cwd(), toolsDir);
  if (!existsSync(abs)) return [];
  const names = [];
  const files = readdirSync(abs).filter((f) => f.endsWith('.tool.ts') || f.endsWith('.tool.js'));
  const nameRe = /name:\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    const content = readFileSync(join(abs, file), 'utf-8');
    const m = nameRe.exec(content);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Get existing tool names. Prefer file scan (has canonical name); fallback to barrel.
 * @param {object} config - forge.config project section
 * @returns {string[]}
 */
export function getExistingTools(config) {
  const tools = [];
  if (config?.toolsDir) {
    const fromFiles = scanToolFiles(config.toolsDir);
    tools.push(...fromFiles);
  }
  if (config?.barrelsFile && tools.length === 0) {
    const fromBarrel = scanBarrel(config.barrelsFile);
    tools.push(...fromBarrel);
  }
  return [...new Set(tools)];
}

/**
 * Get tools with metadata (name, description, tags) for verifier gap analysis.
 * @param {object} config - forge.config project section
 * @returns {{ name: string; description?: string; tags?: string[] }[]}
 */
export function getToolsWithMetadata(config) {
  const abs = resolve(process.cwd(), config?.toolsDir || 'src/tools');
  if (!existsSync(abs)) return [];
  const files = readdirSync(abs).filter(
    (f) => f.endsWith('.tool.ts') || f.endsWith('.tool.js')
  );
  const tools = [];
  for (const file of files) {
    const content = readFileSync(join(abs, file), 'utf-8');
    const nameM = content.match(/name:\s*['"]([^'"]+)['"]/);
    const descM = content.match(/description:\s*(?:['"`]([^'"`]{1,300})['"`]|[\s\S]*?\+[\s\S]*?['"`]([^'"`]{1,200})['"`])/);
    const tagsM = content.match(/tags:\s*\[([^\]]+)\]/);
    const name = nameM ? nameM[1] : file.replace(/\.tool\.(ts|js)$/, '').replace(/-/g, '_');
    const description = descM ? (descM[1] || descM[2] || '').slice(0, 200) : undefined;
    const tags = tagsM ? tagsM[1].split(',').map((t) => t.trim().replace(/['"]/g, '')) : undefined;
    tools.push({ name, description, tags });
  }
  return tools;
}
