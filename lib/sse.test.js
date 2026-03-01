import { describe, it, expect, vi } from 'vitest';
import { initSSE } from './sse.js';

function mockResponse() {
  const chunks = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn((data) => chunks.push(data)),
    end: vi.fn(),
    _chunks: chunks
  };
}

describe('SSE', () => {
  it('sets correct headers', () => {
    const res = mockResponse();
    initSSE(res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }));
  });

  it('writes correct SSE format', () => {
    const res = mockResponse();
    const sse = initSSE(res);
    sse.send('text', { content: 'Hello' });

    expect(res._chunks).toHaveLength(1);
    expect(res._chunks[0]).toBe('event: text\ndata: {"content":"Hello"}\n\n');
  });

  it('close ends response', () => {
    const res = mockResponse();
    const sse = initSSE(res);
    sse.close();
    expect(res.end).toHaveBeenCalled();
  });

  it('handles multiple send calls', () => {
    const res = mockResponse();
    const sse = initSSE(res);
    sse.send('text', { content: 'A' });
    sse.send('tool_call', { tool: 'get_weather' });
    sse.send('done', { usage: {} });

    expect(res._chunks).toHaveLength(3);
    expect(res._chunks[0]).toContain('event: text');
    expect(res._chunks[1]).toContain('event: tool_call');
    expect(res._chunks[2]).toContain('event: done');
  });
});
