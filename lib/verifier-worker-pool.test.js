import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * VerifierWorkerPool tests.
 *
 * We test pool-level behaviors (queue management, destroy, timeout semantics)
 * by manipulating the internal state after creation. Worker execution is
 * tested end-to-end in integration; unit tests cover the pool manager.
 */

// Mock worker_threads to avoid spawning real workers
vi.mock('worker_threads', () => {
  class FakeWorker {
    constructor() {
      this._handlers = {};
      this.terminated = false;
      this.autoReply = true;
    }
    on(event, fn) {
      if (!this._handlers[event]) this._handlers[event] = [];
      this._handlers[event].push(fn);
    }
    emit(event, ...args) {
      (this._handlers[event] ?? []).forEach(fn => fn(...args));
    }
    postMessage(msg) {
      if (this.autoReply && !this.terminated) {
        setImmediate(() => this.emit('message', { id: msg.id, outcome: 'pass', message: null }));
      }
    }
    terminate() {
      this.terminated = true;
      this.emit('exit', 0);
    }
  }
  return { Worker: FakeWorker };
});

const { VerifierWorkerPool } = await import('./verifier-worker-pool.js');

describe('VerifierWorkerPool', () => {
  describe('basic dispatch', () => {
    it('returns outcome from worker reply', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000 });
      const result = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      expect(result.outcome).toBe('pass');
      pool.destroy();
    });

    it('dispatches multiple calls sequentially through 1 worker', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000 });
      const results = await Promise.all([
        pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any'),
        pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any'),
        pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any')
      ]);
      expect(results.every(r => r.outcome === 'pass')).toBe(true);
      pool.destroy();
    });
  });

  describe('queue full', () => {
    it('returns warn for role=any when queue is full', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000, maxQueueDepth: 0 });
      // Block the single worker
      for (const w of pool._workers) w.busy = true;
      const result = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      expect(result.outcome).toBe('warn');
      expect(result.message).toMatch(/queue full/i);
      pool.destroy();
    });

    it('returns block for role=write when queue is full', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000, maxQueueDepth: 0 });
      for (const w of pool._workers) w.busy = true;
      const result = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'write');
      expect(result.outcome).toBe('block');
      pool.destroy();
    });
  });

  describe('destroy', () => {
    it('resolves queued calls with warn/block on destroy', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000 });
      // Block all workers
      for (const w of pool._workers) w.busy = true;
      const p1 = pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      const p2 = pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'write');
      pool.destroy();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.outcome).toBe('warn');
      expect(r2.outcome).toBe('block');
    });

    it('returns warn/block immediately after destroy', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000 });
      pool.destroy();
      const r1 = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      const r2 = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'write');
      expect(r1.outcome).toBe('warn');
      expect(r2.outcome).toBe('block');
    });
  });

  describe('timeout', () => {
    it('returns warn (role=any) when worker does not respond in time', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 20 });
      // Disable auto-reply on the FakeWorker instance (not the entry wrapper)
      for (const w of pool._workers) w.worker.autoReply = false;
      const result = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      expect(result.outcome).toBe('warn');
      expect(result.message).toMatch(/timed out/i);
    });

    it('returns block (role=write) on timeout', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 20 });
      for (const w of pool._workers) w.worker.autoReply = false;
      const result = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'write');
      expect(result.outcome).toBe('block');
    });
  });

  describe('crash recovery', () => {
    it('resolves calls for crashed worker with warn, not other workers', async () => {
      const pool = new VerifierWorkerPool({ size: 2, timeoutMs: 5000 });

      // Disable autoReply on worker[0] so its call stays pending until we crash it
      pool._workers[0].worker.autoReply = false;
      // worker[1] keeps autoReply=true (default)

      // Dispatch a call — goes to worker[0] (first free worker)
      const crashedCallP = pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');

      // Simulate worker[0] crash; _handleWorkerError should resolve crashedCallP with 'warn'
      pool._workers[0].worker.emit('error', new Error('OOM'));

      const crashedResult = await crashedCallP;
      expect(crashedResult.outcome).toBe('warn');
      expect(crashedResult.message).toMatch(/crashed/i);

      // A new call now goes to a healthy worker (worker[1] or the replacement for worker[0])
      // Both have autoReply=true, so this resolves with 'pass'
      const nextResult = await pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'any');
      expect(nextResult.outcome).toBe('pass');

      pool.destroy();
    });

    it('crashed write-role call resolves with block', async () => {
      const pool = new VerifierWorkerPool({ size: 1, timeoutMs: 5000 });

      pool._workers[0].worker.autoReply = false;
      const crashedCallP = pool.run('/fake/v.js', 'verify', 'tool', {}, {}, 'write');

      pool._workers[0].worker.emit('error', new Error('crash'));

      const result = await crashedCallP;
      expect(result.outcome).toBe('block');
      expect(result.message).toMatch(/crashed/i);

      pool.destroy();
    });
  });
});
