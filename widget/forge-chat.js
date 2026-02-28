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
        .forge-chat {
          border: 1px solid ${isDark ? '#444' : '#ddd'};
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          height: 400px;
          background: ${isDark ? '#1a1a2e' : '#fff'};
          color: ${isDark ? '#e0e0e0' : '#333'};
        }
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
        }
        .forge-msg.user {
          background: ${isDark ? '#0d47a1' : '#e3f2fd'};
          margin-left: auto;
          text-align: right;
        }
        .forge-msg.assistant {
          background: ${isDark ? '#2d2d44' : '#f5f5f5'};
        }
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
          padding: 4px 12px;
          border-radius: 4px;
          cursor: pointer;
          border: 1px solid #ccc;
        }
        .forge-msg.hitl button.confirm { background: #4caf50; color: #fff; border: none; }
        .forge-msg.hitl button.cancel { background: #f44336; color: #fff; border: none; }
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
        }
        .forge-input-row button {
          margin-left: 8px;
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          background: #1976d2;
          color: #fff;
          cursor: pointer;
        }
        .forge-input-row button:disabled { opacity: 0.5; cursor: not-allowed; }
        .forge-typing { font-style: italic; color: ${isDark ? '#888' : '#999'}; padding: 4px 12px; }
      </style>
      <div class="forge-chat">
        <div class="forge-messages" id="messages"></div>
        <div class="forge-input-row">
          <input type="text" id="input" placeholder="Type a message..." autocomplete="off" />
          <button id="send">Send</button>
        </div>
      </div>
    `;

    const input = this.shadowRoot.getElementById('input');
    const sendBtn = this.shadowRoot.getElementById('send');

    sendBtn.addEventListener('click', () => this._sendMessage());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });
  }

  _addMessage(role, content, extraClass = '') {
    const msgDiv = document.createElement('div');
    msgDiv.className = `forge-msg ${role} ${extraClass}`.trim();
    msgDiv.textContent = content;
    const container = this.shadowRoot.getElementById('messages');
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
    return msgDiv;
  }

  async _sendMessage() {
    const input = this.shadowRoot.getElementById('input');
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

      if (assistantText) {
        this._addMessage('assistant', assistantText);
        this.dispatchEvent(new CustomEvent('forge:message', { detail: { role: 'assistant', content: assistantText } }));
      }
    } catch (err) {
      this._addMessage('assistant', `Connection error: ${err.message}`);
      this.dispatchEvent(new CustomEvent('forge:error', { detail: { message: err.message } }));
    } finally {
      sendBtn.disabled = false;
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
        this._addMessage('assistant', `Error: ${data.message}`);
        this.dispatchEvent(new CustomEvent('forge:error', { detail: data }));
        break;
    }
  }

  _showHitlDialog(data) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'forge-msg hitl';
    msgDiv.innerHTML = `
      <p>${data.message || 'Tool call requires confirmation'}</p>
      <p><strong>${data.tool || 'Unknown tool'}</strong></p>
      <button class="confirm">Confirm</button>
      <button class="cancel">Cancel</button>
    `;

    const container = this.shadowRoot.getElementById('messages');
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;

    msgDiv.querySelector('.confirm').addEventListener('click', () => {
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

  _applyTheme(theme) {
    // Re-render to apply new theme
    if (this.isConnected) this._render();
  }
}

customElements.define('forge-chat', ForgeChat);
