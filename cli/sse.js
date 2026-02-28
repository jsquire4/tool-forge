/**
 * SSE (Server-Sent Events) streaming helper.
 *
 * Initializes an HTTP response for SSE and returns a simple send/close interface.
 */

/**
 * Initialize an HTTP response for SSE streaming.
 * @param {import('http').ServerResponse} res
 * @returns {{ send(event: string, data: object): void, close(): void }}
 */
export function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  return {
    send(event, data) {
      // Sanitize event name — must not contain newlines or colons
      const safeEvent = String(event).replace(/[\r\n:]/g, '_');
      res.write(`event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      res.end();
    }
  };
}
