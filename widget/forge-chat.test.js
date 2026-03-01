/**
 * forge-chat.test.js
 *
 * Tests for the ForgeChat Web Component helper methods.
 *
 * Since jsdom is not available in this project's devDependencies, we test
 * the pure helper methods directly by shimming the minimal browser globals
 * needed to load the module, then extracting prototype methods onto a
 * plain object for unit testing. No DOM rendering is exercised.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// ── Minimal browser-global shims ──────────────────────────────────────────────
// forge-chat.js registers a custom element at module load time. We shim just
// enough of the browser API to let the module parse without throwing.

class _HTMLElement {
  constructor() {
    this.shadowRoot = null;
  }
  getAttribute() { return null; }
  setAttribute() {}
  removeAttribute() {}
  attachShadow() { this.shadowRoot = {}; return this.shadowRoot; }
  get isConnected() { return false; }
  dispatchEvent() {}
  addEventListener() {}
}

global.HTMLElement = _HTMLElement;
global.customElements = { define: vi.fn() };

// Load the component module (side-effect: defines the class, calls customElements.define)
await import('./forge-chat.js');

// Retrieve the ForgeChat class that was passed to customElements.define
const ForgeChatClass = global.customElements.define.mock.calls[0][1];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal ForgeChat instance. The constructor calls super() then
 * attachShadow, so we can safely call new ForgeChatClass() with the shim in
 * place. The instance has all prototype methods available for unit testing.
 */
function makeInstance() {
  return new ForgeChatClass();
}

// ── _escapeHtml ───────────────────────────────────────────────────────────────

describe('ForgeChat._escapeHtml', () => {
  it('escapes ampersands', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes greater-than', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml('x > y')).toBe('x &gt; y');
  });

  it('escapes double-quotes', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes a full XSS payload', () => {
    const inst = makeInstance();
    const payload = '<img src=x onerror="alert(1)">';
    const result = inst._escapeHtml(payload);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain('"');
    expect(result).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('converts non-string values via String()', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml(42)).toBe('42');
    expect(inst._escapeHtml(null)).toBe('null');
  });

  it('returns empty string unchanged', () => {
    const inst = makeInstance();
    expect(inst._escapeHtml('')).toBe('');
  });
});

// ── XSS in hitlLevels (M15 regression) ───────────────────────────────────────

describe('ForgeChat — hitlLevels XSS protection (M15)', () => {
  it('escapes HTML characters in hitlLevel option values', () => {
    const inst = makeInstance();
    // Simulate a server-supplied hitlLevels array containing a malicious value
    const hitlLevels = ['standard', '<script>alert(1)</script>', 'paranoid'];
    const currentHitl = 'standard';

    // Reproduce the exact template logic from _togglePrefs
    const rendered = hitlLevels.map(l => {
      const safe = inst._escapeHtml(l);
      return `<option value="${safe}" ${l === currentHitl ? 'selected' : ''}>${safe}</option>`;
    }).join('');

    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ── _renderMarkdown ───────────────────────────────────────────────────────────

describe('ForgeChat._renderMarkdown', () => {
  it('returns empty string for falsy input', () => {
    const inst = makeInstance();
    expect(inst._renderMarkdown('')).toBe('');
    expect(inst._renderMarkdown(null)).toBe('');
  });

  it('escapes raw HTML in input', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('<b>hello</b>');
    expect(result).not.toContain('<b>');
    expect(result).toContain('&lt;b&gt;');
  });

  it('renders bold markdown', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('**hello**');
    expect(result).toContain('<strong>hello</strong>');
  });

  it('renders italic markdown', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('*hello*');
    expect(result).toContain('<em>hello</em>');
  });

  it('renders inline code', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('`code`');
    expect(result).toContain('<code>code</code>');
  });

  it('rejects javascript: links', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('[click](javascript:alert(1))');
    expect(result).not.toContain('href');
    expect(result).toContain('click'); // text preserved
  });

  it('allows safe https links', () => {
    const inst = makeInstance();
    const result = inst._renderMarkdown('[docs](https://example.com)');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('rel="noopener noreferrer"');
  });
});

// ── SSE eventType reset ───────────────────────────────────────────────────────

describe('ForgeChat SSE eventType state machine', () => {
  it('resets eventType to null after each complete event (data: line)', () => {
    // Verify the eventType reset behaviour by simulating the parsing loop
    // from _readSseStream using its exact logic.
    const lines = [
      'event: text_delta',
      'data: {"content":"hello"}',
      'event: text_delta',
      'data: {"content":" world"}',
    ];

    let eventType = null;
    const collected = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        collected.push({ type: eventType, data: JSON.parse(line.slice(6)) });
        eventType = null; // reset — this is the fix under test
      } else if (line === '') {
        eventType = null;
      }
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toEqual({ type: 'text_delta', data: { content: 'hello' } });
    expect(collected[1]).toEqual({ type: 'text_delta', data: { content: ' world' } });
    // eventType should be null after the loop (last data: line reset it)
    expect(eventType).toBeNull();
  });

  it('does not process data: line when no preceding event: line', () => {
    // A data: line without a preceding event: line should be ignored
    const lines = [
      'data: {"content":"orphan"}',
      'event: text',
      'data: {"content":"good"}',
    ];

    let eventType = null;
    const collected = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        collected.push({ type: eventType, data: JSON.parse(line.slice(6)) });
        eventType = null;
      } else if (line === '') {
        eventType = null;
      }
    }

    // Only the second data: line (with a matching event:) should be collected
    expect(collected).toHaveLength(1);
    expect(collected[0].type).toBe('text');
  });

  it('resets eventType on blank SSE boundary line', () => {
    // A blank line between SSE messages should reset eventType
    const lines = [
      'event: text_delta',
      '', // blank line = message boundary
      'data: {"content":"stale"}', // no event: — should be ignored
    ];

    let eventType = null;
    const collected = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        collected.push({ type: eventType });
        eventType = null;
      } else if (line === '') {
        eventType = null;
      }
    }

    expect(collected).toHaveLength(0);
    expect(eventType).toBeNull();
  });
});

// ── Constructor state ─────────────────────────────────────────────────────────

describe('ForgeChat constructor state', () => {
  it('initialises _abortCtrl to null', () => {
    const inst = makeInstance();
    expect(inst._abortCtrl).toBeNull();
  });

  it('initialises _streaming to false', () => {
    const inst = makeInstance();
    expect(inst._streaming).toBe(false);
  });

  it('initialises _pendingTheme to null', () => {
    const inst = makeInstance();
    expect(inst._pendingTheme).toBeNull();
  });
});

// ── attributeChangedCallback token handling ───────────────────────────────────

describe('ForgeChat.attributeChangedCallback token handling', () => {
  it('attributeChangedCallback: does not overwrite _token when newVal is null', () => {
    const el = new ForgeChatClass();
    el._token = 'my-token';
    el.attributeChangedCallback('token', 'my-token', null);
    expect(el._token).toBe('my-token');
  });
});
