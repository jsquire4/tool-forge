/**
 * RateLimiter — fixed-window per-user per-route rate limiting.
 *
 * Auto-detects backend:
 *   Redis — if a Redis client is provided (INCR + EXPIRE per window key)
 *   Memory — fallback Map, resets on window boundary
 *
 * Only applied to authenticated requests — rate-limits by userId, not IP.
 */

export class RateLimiter {
  /**
   * @param {object} config — forge rateLimit config block
   * @param {object} [redis] — ioredis / node-redis-compatible client (optional)
   */
  constructor(config = {}, redis = null) {
    this._enabled = config.enabled ?? false;
    this._windowMs = config.windowMs ?? 60_000;
    this._maxRequests = config.maxRequests ?? 60;
    this._redis = redis;
    // In-memory fallback: Map<`${userId}:${route}`, { count, windowStart }>
    this._store = new Map();
    if (this._enabled) {
      this._sweepTimer = setInterval(() => {
        const now = Date.now();
        const windowMs = this._windowMs;
        for (const [k, v] of this._store) {
          if (Math.floor(now / windowMs) * windowMs !== v.windowStart) {
            this._store.delete(k);
          }
        }
      }, this._windowMs).unref();
    }
  }

  /**
   * Check if a request is allowed under the rate limit.
   * Increments the counter and returns the decision synchronously (memory)
   * or asynchronously (Redis).
   *
   * @param {string} userId
   * @param {string} route
   * @returns {Promise<{ allowed: boolean, retryAfter?: number }>}
   */
  async check(userId, route) {
    if (!this._enabled) return { allowed: true };
    if (!userId || !route) return { allowed: true };

    const windowMs = this._windowMs;
    const maxRequests = this._maxRequests;
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    // Use null-byte separator to prevent collisions when userId or route contains ':'
    // (e.g. userId "user:admin" + route "chat" must not collide with userId "user" + route "admin:chat")
    const key = `\x00${userId}\x00${route}`;

    if (this._redis) {
      return this._checkRedis(key, now, windowMs, maxRequests, windowStart);
    }
    return this._checkMemory(key, now, windowMs, maxRequests, windowStart);
  }

  /** @private */
  async _checkRedis(key, now, windowMs, maxRequests, windowStart) {
    const redisKey = `forge:rl:${key}:${windowStart}`;
    const ttlSeconds = Math.ceil(windowMs / 1000);
    // Atomic increment + conditional TTL via Lua — prevents the race where INCR
    // succeeds but EXPIRE is never called (crash/kill between the two commands).
    const count = await this._redis.eval(
      `local c = redis.call('INCR', KEYS[1])
     if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return c`,
      { keys: [redisKey], arguments: [String(ttlSeconds)] }
    );
    if (count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  }

  /** @private */
  _checkMemory(key, now, windowMs, maxRequests, windowStart) {
    const entry = this._store.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      // Prune the stale entry before creating the new window entry to prevent unbounded Map growth.
      if (entry) this._store.delete(key);
      this._store.set(key, { count: 1, windowStart });
      return { allowed: true };
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  }
}

/**
 * Postgres-backed fixed-window rate limiter.
 * Uses an atomic INSERT ... ON CONFLICT DO UPDATE to count requests.
 * Requires the rate_limit_buckets table (created by postgres-store.js SCHEMA).
 *
 * @param {object} config — forge rateLimit config block
 * @param {object} pgPool — pg.Pool instance
 */
export class PostgresRateLimiter {
  constructor(config = {}, pgPool) {
    this._enabled = config.enabled ?? false;
    this._windowMs = config.windowMs ?? 60_000;
    this._maxRequests = config.maxRequests ?? 60;
    this._pgPool = pgPool;
    // Cleanup stale windows every 5 minutes
    if (this._enabled) {
      this._cleanupTimer = setInterval(async () => {
        const cutoff = Math.floor(Date.now() / this._windowMs) * this._windowMs - this._windowMs;
        try {
          await this._pgPool.query(
            'DELETE FROM rate_limit_buckets WHERE window_start < $1', [cutoff]);
        } catch { /* non-fatal */ }
      }, 5 * 60 * 1000).unref();
    }
  }

  async check(userId, route) {
    if (!this._enabled) return { allowed: true };
    if (!userId || !route) return { allowed: true };

    const windowMs = this._windowMs;
    const maxRequests = this._maxRequests;
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `\x00${userId}\x00${route}`;

    let rows;
    try {
      ({ rows } = await this._pgPool.query(
        `INSERT INTO rate_limit_buckets (key, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE
           SET count = rate_limit_buckets.count + 1
         RETURNING count`,
        [key, windowStart]
      ));
    } catch (err) {
      console.error('[forge-rate-limiter] pgPool.query failed:', err.message ?? err);
      return { allowed: true }; // fail open on DB error
    }
    const count = rows[0]?.count ?? 1;
    if (count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfter };
    }
    return { allowed: true };
  }
}

/**
 * Factory — creates a RateLimiter from forge config.
 * Auto-passes Redis client if available (set by buildSidecarContext).
 *
 * @param {object} config — merged forge config
 * @param {object} [redis] — optional Redis client
 * @param {object} [pgPool] — optional pg.Pool instance
 * @returns {RateLimiter|PostgresRateLimiter}
 */
export function makeRateLimiter(config, redis = null, pgPool = null) {
  const rlConfig = config.rateLimit ?? {};
  if (!redis && pgPool) {
    return new PostgresRateLimiter(rlConfig, pgPool);
  }
  return new RateLimiter(rlConfig, redis);
}
