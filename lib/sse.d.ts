import type { ServerResponse } from 'http';

export interface SSEHandle {
  /** Write a named SSE event with a JSON-serialized data payload. */
  send(event: string, data: unknown): void;
  /** End the response stream. */
  close(): void;
}

/**
 * Initialize an HTTP response for SSE streaming.
 * Sets Content-Type, Cache-Control, and Connection headers, then returns a
 * minimal send/close handle.
 */
export function initSSE(res: ServerResponse): SSEHandle;
