/**
 * Manual Entry — Add an API endpoint via interactive prompts.
 * Used when the endpoint isn't in OpenAPI or manifest.
 */

import * as readline from 'readline';

/**
 * @typedef {Object} ApiEndpoint
 * @property {string} path
 * @property {string} method
 * @property {string} name
 * @property {string} description
 * @property {Record<string,unknown>} [params]
 * @property {boolean} [requiresConfirmation]
 */

/**
 * Prompt for a single line.
 * @param {readline.Interface} rl
 * @param {string} question
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
function ask(rl, question, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (ans) => {
      resolve(ans.trim() || defaultValue);
    });
  });
}

/**
 * Add an endpoint via interactive prompts.
 * @param {readline.Interface} [rl] - Reuse existing readline (e.g. from TUI)
 * @returns {Promise<ApiEndpoint>}
 */
export async function addEndpointManually(rl) {
  const ownRl = !rl;
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const path = await ask(rl, 'Path (e.g. /api/v1/holdings)', '/api/v1/example');
  const method = (await ask(rl, 'Method (GET, POST, etc.)', 'GET')).toUpperCase();
  const name = await ask(rl, 'Tool name (snake_case)', path.split('/').filter(Boolean).pop()?.replace(/-/g, '_') || 'get_example');
  const description = await ask(rl, 'Description (routing contract)', `${method} ${path}`);
  const confirmStr = await ask(rl, 'Requires confirmation? (y/n)', 'n');
  const requiresConfirmation = /^y|yes|true$/i.test(confirmStr);

  if (ownRl) rl.close();

  return {
    path: path.startsWith('/') ? path : `/${path}`,
    method: method || 'GET',
    name: name || 'get_example',
    description: description || `${method} ${path}`,
    requiresConfirmation
  };
}
