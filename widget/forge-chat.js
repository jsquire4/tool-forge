/**
 * <forge-chat> — Reference chat widget (Web Component, vanilla JS, zero deps).
 *
 * Usage:
 *   <script src="/widget/forge-chat.js"></script>
 *   <forge-chat endpoint="https://myapp.com/agent-api" theme="light"></forge-chat>
 *
 * Attributes:
 *   endpoint — Base URL for the agent API (required)
 *   theme    — "light" or "dark" (default: "light")
 *   token    — JWT token for auth (optional, can also be set via setToken())
 *
 * Custom events:
 *   forge:message    — { detail: { role, content } }
 *   forge:tool-call  — { detail: { tool, args } }
 *   forge:hitl       — { detail: { tool, message, resumeToken } }
 *   forge:error      — { detail: { message } }
 */

class ForgeChat extends HTMLElement {
  constructor() {
    super();
    this._sessionId = null;
    this._token = null;
    this._messages = [];
    this._prefsOpen = false;
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['endpoint', 'theme', 'token'];
  }

  connectedCallback() {
    this._token = this.getAttribute('token') || null;
    this._render();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'token') this._token = newVal;
    if (name === 'theme') this._applyTheme(newVal);
  }

  setToken(token) {
    this._token = token;
  }

  _render() {
    const theme = this.getAttribute('theme') || 'light';
    const isDark = theme === 'dark';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        *, *::before, *::after { box-sizing: border-box; }
        .forge-chat {
          border: 1px solid ${isDark ? '#444' : '#ddd'};
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          height: 400px;
          background: ${isDark ? '#1a1a2e' : '#fff'};
          color: ${isDark ? '#e0e0e0' : '#333'};
          position: relative;
        }
        .forge-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 12px;
          border-bottom: 1px solid ${isDark ? '#333' : '#eee'};
          font-size: 0.85em;
          font-weight: 600;
          color: ${isDark ? '#aaa' : '#666'};
        }
        .forge-header button {
          background: none;
          border: none;
          cursor: pointer;
          font-size: 1.1em;
          color: ${isDark ? '#aaa' : '#666'};
          padding: 2px 6px;
          border-radius: 4px;
        }
        .forge-header button:hover { background: ${isDark ? '#333' : '#eee'}; }
        .forge-header button:focus-visible { outline: 2px solid #1976d2; outline-offset: 1px; }
        .forge-messages {
          flex: 1;
          overflow-y: auto;
          padding: 12px;
        }
        .forge-msg {
          margin-bottom: 8px;
          padding: 8px 12px;
          border-radius: 6px;
          max-width: 80%;
          word-wrap: break-word;
          line-height: 1.5;
        }
        .forge-msg.user {
          background: ${isDark ? '#0d47a1' : '#e3f2fd'};
          margin-left: auto;
          text-align: right;
        }
        .forge-msg.assistant {
          background: ${isDark ? '#2d2d44' : '#f5f5f5'};
        }
        /* Markdown styles inside assistant messages */
        .forge-msg.assistant p { margin: 4px 0; }
        .forge-msg.assistant code {
          background: ${isDark ? '#1a1a2e' : '#e8e8e8'};
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 0.9em;
        }
        .forge-msg.assistant pre {
          background: ${isDark ? '#111' : '#e8e8e8'};
          padding: 8px;
          border-radius: 4px;
          overflow-x: auto;
          font-size: 0.85em;
        }
        .forge-msg.assistant pre code { background: none; padding: 0; }
        .forge-msg.assistant ul, .forge-msg.assistant ol { padding-left: 20px; margin: 4px 0; }
        .forge-msg.assistant strong { font-weight: 600; }
        .forge-msg.assistant em { font-style: italic; }
        .forge-msg.assistant a { color: #1976d2; text-decoration: underline; }
        .forge-msg.tool-warning {
          background: ${isDark ? '#4a3800' : '#fff3e0'};
          border-left: 3px solid #ff9800;
          font-size: 0.9em;
        }
        .forge-msg.hitl {
          background: ${isDark ? '#4a0000' : '#fce4ec'};
          border-left: 3px solid #f44336;
          text-align: center;
        }
        .forge-msg.hitl button {
          margin: 4px;
          padding: 6px 16px;
          border-radius: 4px;
          cursor: pointer;
          border: none;
          font-size: 0.9em;
        }
        .forge-msg.hitl button:focus-visible { outline: 2px solid #1976d2; outline-offset: 1px; }
        .forge-msg.hitl button.confirm { background: #4caf50; color: #fff; }
        .forge-msg.hitl button.cancel { background: #f44336; color: #fff; }
        .forge-typing {
          font-style: italic;
          color: ${isDark ? '#888' : '#999'};
          padding: 4px 12px;
          font-size: 0.9em;
        }
        .forge-typing .dots::after {
          content: '';
          animation: forge-dots 1.5s steps(4, end) infinite;
        }
        @keyframes forge-dots {
          0% { content: ''; }
          25% { content: '.'; }
          50% { content: '..'; }
          75% { content: '...'; }
        }
        .forge-input-row {
          display: flex;
          border-top: 1px solid ${isDark ? '#444' : '#ddd'};
          padding: 8px;
        }
        .forge-input-row input {
          flex: 1;
          padding: 8px;
          border: 1px solid ${isDark ? '#555' : '#ccc'};
          border-radius: 4px;
          background: ${isDark ? '#2d2d44' : '#fff'};
          color: ${isDark ? '#e0e0e0' : '#333'};
          outline: none;
          font-size: 0.95em;
        }
        .forge-input-row input:focus-visible { border-color: #1976d2; box-shadow: 0 0 0 1px #1976d2; }
        .forge-input-row button {
          margin-left: 8px;
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          background: #1976d2;
          color: #fff;
          cursor: pointer;
          font-size: 0.95em;
        }
        .forge-input-row button:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
        .forge-input-row button:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Preference panel */
        .forge-prefs-overlay {
          position: absolute;
          inset: 0;
          background: ${isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.3)'};
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
        }
        .forge-prefs-panel {
          background: ${isDark ? '#2d2d44' : '#fff'};
          border-radius: 8px;
          padding: 16px;
          width: 280px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
        .forge-prefs-panel h3 { margin: 0 0 12px; font-size: 1em; }
        .forge-prefs-panel label { display: block; margin-bottom: 8px; font-size: 0.9em; }
        .forge-prefs-panel select, .forge-prefs-panel input[type="text"] {
          width: 100%;
          padding: 6px;
          border: 1px solid ${isDark ? '#555' : '#ccc'};
          border-radius: 4px;
          background: ${isDark ? '#1a1a2e' : '#fff'};
          color: ${isDark ? '#e0e0e0' : '#333'};
          font-size: 0.9em;
          margin-top: 2px;
        }
        .forge-prefs-panel select:focus-visible, .forge-prefs-panel input:focus-visible {
          outline: 2px solid #1976d2;
        }
        .forge-prefs-panel .prefs-actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          justify-content: flex-end;
        }
        .forge-prefs-panel .prefs-actions button {
          padding: 6px 14px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9em;
        }
        .forge-prefs-panel .prefs-actions button:focus-visible { outline: 2px solid #1976d2; outline-offset: 1px; }
        .forge-prefs-panel .prefs-actions .save-btn { background: #1976d2; color: #fff; }
        .forge-prefs-panel .prefs-actions .cancel-btn {
          background: ${isDark ? '#444' : '#e0e0e0'};
          color: ${isDark ? '#ccc' : '#333'};
        }
        .forge-prefs-panel .perm-note { font-size: 0.8em; color: ${isDark ? '#888' : '#999'}; margin-top: 2px; }

        /* Screen reader only */
        .sr-only {
          position: absolute;
          width: 1px; height: 1px;
          padding: 0; margin: -1px;
          overflow: hidden;
          clip: rect(0,0,0,0);
          border: 0;
        }
      </style>
      <div class="forge-chat" role="region" aria-label="Chat">
        <div class="forge-header">
          <span>Forge Chat</span>
          <button id="prefs-btn" aria-label="Open preferences" title="Preferences">&#9881;</button>
        </div>
        <div class="forge-messages" id="messages" role="log" aria-live="polite" aria-label="Chat messages"></div>
        <div id="typing" class="forge-typing" style="display:none" aria-live="polite">
          <span>Assistant is thinking</span><span class="dots"></span>
        </div>
        <div class="forge-input-row">
          <label for="forge-input" class="sr-only">Message</label>
          <input type="text" id="forge-input" placeholder="Type a message..." autocomplete="off" aria-label="Type a message" />
          <button id="send" aria-label="Send message">Send</button>
        </div>
      </div>
    `;

    const input = this.shadowRoot.getElementById('forge-input');
    const sendBtn = this.shadowRoot.getElementById('send');
    const prefsBtn = this.shadowRoot.getElementById('prefs-btn');

    sendBtn.addEventListener('click', () => this._sendMessage());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });
    prefsBtn.addEventListener('click', () => this._togglePrefs());
  }

  _addMessage(role, content, extraClass = '') {
    const msgDiv = document.createElement('div');
    msgDiv.className = `forge-msg ${role} ${extraClass}`.trim();
    msgDiv.setAttribute('role', role === 'user' ? 'status' : 'article');

    if (role === 'assistant' && !extraClass) {
      msgDiv.innerHTML = this._renderMarkdown(content);
    } else {
      msgDiv.textContent = content;
    }

    const container = this.shadowRoot.getElementById('messages');
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    return msgDiv;
  }

  /**
   * Basic markdown renderer — handles the most common patterns:
   * code blocks, inline code, bold, italic, links, lists, paragraphs.
   * No external dependencies.
   */
  _renderMarkdown(text) {
    if (!text) return '';

    // Escape HTML
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks: ```lang\n...\n```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **text** or __text__
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic: *text* or _text_ (but not inside words)
    html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');
    html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<em>$1</em>');

    // Links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Unordered lists: lines starting with - or *
    html = html.replace(/^([ \t]*[-*] .+(?:\n|$))+/gm, (match) => {
      const items = match.trim().split('\n').map(line => {
        return `<li>${line.replace(/^[ \t]*[-*] /, '')}</li>`;
      }).join('');
      return `<ul>${items}</ul>`;
    });

    // Ordered lists: lines starting with 1. 2. etc
    html = html.replace(/^([ \t]*\d+\. .+(?:\n|$))+/gm, (match) => {
      const items = match.trim().split('\n').map(line => {
        return `<li>${line.replace(/^[ \t]*\d+\. /, '')}</li>`;
      }).join('');
      return `<ol>${items}</ol>`;
    });

    // Paragraphs: double newlines
    html = html.replace(/\n\n+/g, '</p><p>');
    if (!html.startsWith('<')) html = `<p>${html}`;
    if (!html.endsWith('>')) html = `${html}</p>`;

    // Single newlines → <br> (but not inside pre/code blocks)
    html = html.replace(/(?<!<\/li>|<\/ul>|<\/ol>|<\/pre>|<\/code>)\n(?!<)/g, '<br>');

    return html;
  }

  _showTyping() {
    const el = this.shadowRoot.getElementById('typing');
    if (el) el.style.display = 'block';
  }

  _hideTyping() {
    const el = this.shadowRoot.getElementById('typing');
    if (el) el.style.display = 'none';
  }

  async _sendMessage() {
    const input = this.shadowRoot.getElementById('forge-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    this._addMessage('user', message);
    this.dispatchEvent(new CustomEvent('forge:message', { detail: { role: 'user', content: message } }));

    const endpoint = this.getAttribute('endpoint');
    if (!endpoint) {
      this._addMessage('assistant', 'Error: no endpoint configured');
      return;
    }

    const sendBtn = this.shadowRoot.getElementById('send');
    sendBtn.disabled = true;
    this._showTyping();

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

      const res = await fetch(`${endpoint}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, sessionId: this._sessionId })
      });

      if (!res.ok) {
        const err = await res.text();
        this._hideTyping();
        this._addMessage('assistant', `Error: ${res.status} — ${err}`);
        return;
      }

      // Parse SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              this._handleSSEEvent(eventType, data);
              if (eventType === 'text') assistantText += data.content || '';
              if (eventType === 'session') this._sessionId = data.sessionId;
            } catch { /* skip malformed */ }
            eventType = null;
          }
        }
      }

      this._hideTyping();

      if (assistantText) {
        this._addMessage('assistant', assistantText);
        this.dispatchEvent(new CustomEvent('forge:message', { detail: { role: 'assistant', content: assistantText } }));
      }
    } catch (err) {
      this._hideTyping();
      this._addMessage('assistant', `Connection error: ${err.message}`);
      this.dispatchEvent(new CustomEvent('forge:error', { detail: { message: err.message } }));
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  _handleSSEEvent(type, data) {
    switch (type) {
      case 'tool_call':
        this.dispatchEvent(new CustomEvent('forge:tool-call', { detail: data }));
        break;
      case 'tool_warning':
        this._addMessage('assistant', `Warning: ${data.message}`, 'tool-warning');
        break;
      case 'hitl':
        this._showHitlDialog(data);
        this.dispatchEvent(new CustomEvent('forge:hitl', { detail: data }));
        break;
      case 'error':
        this._hideTyping();
        this._addMessage('assistant', `Error: ${data.message}`);
        this.dispatchEvent(new CustomEvent('forge:error', { detail: data }));
        break;
    }
  }

  _showHitlDialog(data) {
    this._hideTyping();
    const msgDiv = document.createElement('div');
    msgDiv.className = 'forge-msg hitl';
    msgDiv.setAttribute('role', 'alertdialog');
    msgDiv.setAttribute('aria-label', 'Tool confirmation required');
    msgDiv.innerHTML = `
      <p>${this._escapeHtml(data.message || 'Tool call requires confirmation')}</p>
      <p><strong>${this._escapeHtml(data.tool || 'Unknown tool')}</strong></p>
      <button class="confirm" aria-label="Confirm tool call">Confirm</button>
      <button class="cancel" aria-label="Cancel tool call">Cancel</button>
    `;

    const container = this.shadowRoot.getElementById('messages');
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;

    // Focus the confirm button for keyboard users
    const confirmBtn = msgDiv.querySelector('.confirm');
    confirmBtn.focus();

    confirmBtn.addEventListener('click', () => {
      this._resumeHitl(data.resumeToken, true);
      msgDiv.remove();
    });
    msgDiv.querySelector('.cancel').addEventListener('click', () => {
      this._resumeHitl(data.resumeToken, false);
      msgDiv.remove();
      this._addMessage('assistant', 'Action cancelled.');
    });
  }

  async _resumeHitl(resumeToken, confirmed) {
    const endpoint = this.getAttribute('endpoint');
    if (!endpoint || !resumeToken) return;

    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    if (confirmed) this._showTyping();

    try {
      await fetch(`${endpoint}/chat/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ resumeToken, confirmed })
      });
    } catch (err) {
      this.dispatchEvent(new CustomEvent('forge:error', { detail: { message: err.message } }));
    }
  }

  // ── Preference panel ───────────────────────────────────────────────────

  async _togglePrefs() {
    if (this._prefsOpen) {
      this._closePrefs();
      return;
    }

    const endpoint = this.getAttribute('endpoint');
    if (!endpoint) return;

    // Fetch current preferences
    const headers = {};
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    let prefsData;
    try {
      const res = await fetch(`${endpoint}/user/preferences`, { headers });
      if (!res.ok) {
        if (res.status === 401) return; // Not authenticated
        return;
      }
      prefsData = await res.json();
    } catch {
      return;
    }

    this._prefsOpen = true;
    const chat = this.shadowRoot.querySelector('.forge-chat');

    const overlay = document.createElement('div');
    overlay.className = 'forge-prefs-overlay';
    overlay.id = 'prefs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'User preferences');

    const canModel = prefsData.permissions?.canChangeModel;
    const canHitl = prefsData.permissions?.canChangeHitl;
    const hitlLevels = prefsData.options?.hitlLevels || ['autonomous', 'cautious', 'standard', 'paranoid'];
    const currentModel = prefsData.preferences?.model || '';
    const currentHitl = prefsData.preferences?.hitlLevel || prefsData.effective?.hitlLevel || 'cautious';

    overlay.innerHTML = `
      <div class="forge-prefs-panel">
        <h3>Preferences</h3>
        ${canModel ? `
          <label>
            Model
            <input type="text" id="pref-model" value="${this._escapeHtml(currentModel)}" placeholder="${this._escapeHtml(prefsData.effective?.model || 'default')}" />
          </label>
        ` : `<p class="perm-note">Model selection disabled by admin</p>`}
        ${canHitl ? `
          <label>
            Confirmation level
            <select id="pref-hitl">
              ${hitlLevels.map(l => `<option value="${l}" ${l === currentHitl ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
        ` : `<p class="perm-note">HITL level disabled by admin</p>`}
        <p class="perm-note">Effective: ${this._escapeHtml(prefsData.effective?.model || 'default')} / ${this._escapeHtml(prefsData.effective?.hitlLevel || 'default')}</p>
        <div class="prefs-actions">
          <button class="cancel-btn" id="prefs-cancel">Cancel</button>
          ${canModel || canHitl ? '<button class="save-btn" id="prefs-save">Save</button>' : ''}
        </div>
      </div>
    `;

    chat.appendChild(overlay);

    // Focus first interactive element
    const firstInput = overlay.querySelector('input, select, button');
    if (firstInput) firstInput.focus();

    overlay.querySelector('#prefs-cancel').addEventListener('click', () => this._closePrefs());

    const saveBtn = overlay.querySelector('#prefs-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this._savePrefs(prefsData.permissions));
    }

    // Close on Escape
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closePrefs();
    });
  }

  async _savePrefs(permissions) {
    const endpoint = this.getAttribute('endpoint');
    if (!endpoint) return;

    const body = {};
    if (permissions.canChangeModel) {
      const modelInput = this.shadowRoot.getElementById('pref-model');
      if (modelInput?.value) body.model = modelInput.value;
    }
    if (permissions.canChangeHitl) {
      const hitlSelect = this.shadowRoot.getElementById('pref-hitl');
      if (hitlSelect?.value) body.hitl_level = hitlSelect.value;
    }

    if (Object.keys(body).length === 0) {
      this._closePrefs();
      return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this._token) headers['Authorization'] = `Bearer ${this._token}`;

    try {
      await fetch(`${endpoint}/user/preferences`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body)
      });
    } catch { /* ignore save error */ }

    this._closePrefs();
  }

  _closePrefs() {
    this._prefsOpen = false;
    const overlay = this.shadowRoot.getElementById('prefs-overlay');
    if (overlay) overlay.remove();
    // Return focus to prefs button
    const prefsBtn = this.shadowRoot.getElementById('prefs-btn');
    if (prefsBtn) prefsBtn.focus();
  }

  _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _applyTheme(theme) {
    if (this.isConnected) this._render();
  }
}

customElements.define('forge-chat', ForgeChat);
