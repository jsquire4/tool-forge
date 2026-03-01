/**
 * VerifierWorkerPool — fixed-size Worker thread pool for sandboxed custom verifier execution.
 *
 * Architecture (1000 verifiers × 1M sessions):
 *   - N workers (default: min(4, cpus), configurable via poolSize)
 *   - Module cache per worker (imported once, reused)
 *   - Dispatch to first available idle worker
 *   - Per-call timeout: 2000ms (configurable) — on expiry: terminate + replace worker
 *   - Queue: max 200 pending calls (configurable); rejects with warn/block based on role
 *   - Dead worker (crash/OOM): replaced immediately
 *   - Timeout/crash outcome: 'write' role → 'block', 'read'|'any' → 'warn'
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, 'workers', 'verifier-worker.js');

export class VerifierWorkerPool {
  /**
   * @param {object} opts
   * @param {number} [opts.size] — pool size (default: min(4, cpus().length))
   * @param {number} [opts.timeoutMs=2000] — per-call timeout in ms
   * @param {number} [opts.maxQueueDepth=200] — max pending calls before rejecting
   */
  constructor(opts = {}) {
    this._size = opts.size ?? Math.min(4, cpus().length);
    this._timeoutMs = opts.timeoutMs ?? 2000;
    this._maxQueueDepth = opts.maxQueueDepth ?? 200;

    this._workers = []; // { worker, busy, lastUsed }
    this._callMap = new Map(); // callId → { resolve, timeoutHandle, role, entry }
    this._queue = []; // { callArgs, role, resolve }
    this._nextId = 1;
    this._destroyed = false;

    for (let i = 0; i < this._size; i++) {
      this._workers.push(this._createWorkerEntry());
    }
  }

  /** @private */
  _createWorkerEntry() {
    const worker = new Worker(WORKER_PATH, { type: 'module' });
    const entry = { worker, busy: false, lastUsed: 0 };

    worker.on('message', (msg) => {
      this._handleMessage(msg, entry);
    });
    worker.on('error', (err) => {
      this._handleWorkerError(entry, err);
    });
    worker.on('exit', (code) => {
      if (code !== 0 && !this._destroyed) {
        this._replaceWorker(entry);
      }
    });

    return entry;
  }

  /** @private */
  _handleMessage({ id, outcome, message }, entry) {
    const pending = this._callMap.get(id);
    if (!pending) return;
    clearTimeout(pending.timeoutHandle);
    this._callMap.delete(id);
    entry.busy = false;
    entry.lastUsed = Date.now();
    pending.resolve({ outcome, message });
    // Drain queue
    this._drainQueue();
  }

  /** @private */
  _handleWorkerError(crashedEntry, err) {
    // Fail only the pending calls that were dispatched to the crashed worker
    for (const [id, pending] of this._callMap) {
      if (pending.entry !== crashedEntry) continue;
      clearTimeout(pending.timeoutHandle);
      this._callMap.delete(id);
      const outcome = pending.role === 'write' ? 'block' : 'warn';
      pending.resolve({ outcome, message: `Verifier worker crashed: ${err.message}` });
    }
    if (!this._destroyed) {
      this._replaceWorker(crashedEntry);
    }
  }

  /** @private */
  _replaceWorker(entry) {
    const idx = this._workers.indexOf(entry);
    if (idx === -1) return;
    try { entry.worker.terminate(); } catch { /* ignore */ }
    this._workers[idx] = this._createWorkerEntry();
    this._drainQueue();
  }

  /** @private */
  _drainQueue() {
    while (this._queue.length > 0) {
      const freeEntry = this._workers.find(e => !e.busy);
      if (!freeEntry) break;
      const { callArgs, role, resolve } = this._queue.shift();
      this._dispatch(freeEntry, callArgs, role, resolve);
    }
  }

  /** @private */
  _dispatch(entry, { id, verifierPath, exportName, toolName, args, result }, role, resolve) {
    entry.busy = true;
    entry.lastUsed = Date.now();

    const timeoutHandle = setTimeout(() => {
      this._callMap.delete(id);
      const outcome = role === 'write' ? 'block' : 'warn';
      resolve({ outcome, message: `Verifier timed out after ${this._timeoutMs}ms` });
      // Replace the worker (stuck in user code)
      this._replaceWorker(entry);
    }, this._timeoutMs).unref();

    this._callMap.set(id, { resolve, timeoutHandle, role, entry });
    entry.worker.postMessage({ id, verifierPath, exportName, toolName, args, result });
  }

  /**
   * Run a custom verifier in a worker thread.
   *
   * @param {string} verifierPath — absolute path to verifier module
   * @param {string} exportName — exported function name (e.g. 'verify')
   * @param {string} toolName
   * @param {object} args — tool call input
   * @param {object} result — tool call result
   * @param {string} [role='any'] — 'read' | 'write' | 'any' (determines timeout outcome)
   * @returns {Promise<{ outcome: 'pass'|'warn'|'block', message: string|null }>}
   */
  run(verifierPath, exportName, toolName, args, result, role = 'any') {
    if (this._destroyed) {
      const outcome = role === 'write' ? 'block' : 'warn';
      return Promise.resolve({ outcome, message: 'Verifier pool is destroyed' });
    }

    const id = this._nextId++;

    return new Promise((resolve) => {
      const callArgs = { id, verifierPath, exportName, toolName, args, result };

      // Try to dispatch immediately to a free worker
      const freeEntry = this._workers.find(e => !e.busy);
      if (freeEntry) {
        this._dispatch(freeEntry, callArgs, role, resolve);
        return;
      }

      // Queue if under limit
      if (this._queue.length >= this._maxQueueDepth) {
        const outcome = role === 'write' ? 'block' : 'warn';
        resolve({ outcome, message: 'Verifier queue full — request dropped' });
        return;
      }

      this._queue.push({ callArgs, role, resolve });
    });
  }

  /**
   * Tear down all workers. Outstanding calls resolve with warn/block.
   */
  destroy() {
    this._destroyed = true;

    // Fail all pending calls
    for (const [id, pending] of this._callMap) {
      clearTimeout(pending.timeoutHandle);
      this._callMap.delete(id);
      const outcome = pending.role === 'write' ? 'block' : 'warn';
      pending.resolve({ outcome, message: 'Verifier pool shutting down' });
    }

    // Drain queue
    for (const { callArgs, role, resolve } of this._queue) {
      const outcome = role === 'write' ? 'block' : 'warn';
      resolve({ outcome, message: 'Verifier pool shutting down' });
    }
    this._queue.length = 0;

    // Terminate workers
    for (const entry of this._workers) {
      try { entry.worker.terminate(); } catch { /* ignore */ }
    }
    this._workers.length = 0;
  }
}
