export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets. Present only when `allowed` is false. */
  retryAfter?: number;
}

/**
 * Fixed-window per-user per-route rate limiter.
 *
 * Backend is selected automatically:
 * - Redis — if a Redis client is provided (uses INCR + EXPIRE per window key)
 * - Memory — in-process Map fallback, resets on window boundary
 *
 * Only counts authenticated requests — limits by `userId`, not IP.
 */
export class RateLimiter {
  constructor(config?: object, redis?: object | null);

  /**
   * Check whether a request is within the rate limit and increment the counter.
   * Always returns `{ allowed: true }` when rate limiting is disabled.
   */
  check(userId: string, route: string): Promise<RateLimitResult>;
}

/**
 * Factory — creates a RateLimiter from forge config.
 * Reads `config.rateLimit` for `enabled`, `windowMs`, and `maxRequests`.
 */
export function makeRateLimiter(config: object, redis?: object | null): RateLimiter;
