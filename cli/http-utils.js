/**
 * Shared HTTP helpers for sidecar request handlers.
 */

/**
 * Read and JSON-parse a request body. Returns {} on parse failure.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<object>}
 */
export function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

/**
 * Send a JSON response with the given status code.
 * @param {import('http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
