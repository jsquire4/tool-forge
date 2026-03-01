export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets. Present only when `allowed` is false. */
  retryAfter?: number;
}

/**
 * Fixed-window per-user per-route rate limiter.
 *
 * Backend is selected automatically by `makeRateLimiter`:
 * - Redis — if a Redis client is provided
 * - Postgres — if a pg.Pool is provided as the third argument
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
 * Postgres-backed rate limiter. Uses an atomic `INSERT … ON CONFLICT DO UPDATE`
 * on the `rate_limit_buckets` table for horizontal-scale durability.
 */
export class PostgresRateLimiter {
  constructor(config?: object, pgPool?: object | null);

  /**
   * Check whether a request is within the rate limit and increment the counter.
   * Always returns `{ allowed: true }` when rate limiting is disabled.
   * Rejects if the database is unavailable.
   */
  check(userId: string, route: string): Promise<RateLimitResult>;
}

/**
 * Factory — creates a rate limiter from forge config.
 * Reads `config.rateLimit` for `enabled`, `windowMs`, and `maxRequests`.
 * Priority: Redis > Postgres > in-memory.
 */
export function makeRateLimiter(config: object, redis?: object | null, pgPool?: object | null): RateLimiter | PostgresRateLimiter;
