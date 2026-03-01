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
    // Atomic first-write: SET NX sets the key to '1' with TTL in one operation.
    // If the key already exists (null returned), fall through to INCR.
    const setResult = await this._redis.set(redisKey, '1', 'EX', ttlSeconds, 'NX');
    const count = setResult !== null ? 1 : await this._redis.incr(redisKey);
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
 * Factory — creates a RateLimiter from forge config.
 * Auto-passes Redis client if available (set by buildSidecarContext).
 *
 * @param {object} config — merged forge config
 * @param {object} [redis] — optional Redis client
 * @returns {RateLimiter}
 */
export function makeRateLimiter(config, redis = null) {
  return new RateLimiter(config.rateLimit ?? {}, redis);
}
