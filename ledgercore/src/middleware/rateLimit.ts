import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import { TooManyRequestsError } from '../shared/errors/AppError';
import { moduleLogger } from '../shared/logging/logger';
import { getRedis, isCacheAvailable } from '../shared/cache/redis';

const log = moduleLogger('rate-limit');

/**
 * Rate limiting -- sliding window, Redis-backed.
 *
 * This closes the largest gap carried from Phase 4: `/auth/login` had only a
 * per-account lockout. That stops credential stuffing against ONE account but
 * does nothing about **password spraying** -- one common password tried across
 * a thousand staff codes, where no single account ever reaches its threshold.
 * The per-IP limit here is what catches that.
 *
 * ---------------------------------------------------------------------------
 * Why a sliding window and not a fixed one
 * ---------------------------------------------------------------------------
 *
 * A fixed window ("100 per minute", counter resets on the minute) allows a
 * burst of 200 across a window boundary: 100 at 10:00:59 and 100 at 10:01:00.
 * For a login endpoint that doubling is exactly the thing being defended
 * against.
 *
 * A sorted set keyed by timestamp gives a true rolling window: drop entries
 * older than `now - window`, count what remains. Costs one more Redis command
 * and a little memory per key; worth it here.
 *
 * ---------------------------------------------------------------------------
 * This FAILS OPEN
 * ---------------------------------------------------------------------------
 *
 * Redis down means unthrottled, not unavailable. A rate limiter exists to
 * protect the API from excess load; turning it into a hard dependency means a
 * Redis blip takes down the login page for everyone, which is a far worse
 * outcome than briefly permitting more requests than intended.
 *
 * The opposite call is made for distributed locks -- see lock.ts -- and the
 * difference is the point: fail open when the component is an optimisation,
 * fail closed when it is a correctness guarantee.
 */

export interface RateLimitOptions {
  /** Window length. */
  windowMs: number;
  /** Requests permitted per window. */
  max: number;
  /** Bucket name, so two limiters never share a key. */
  bucket: string;
  /**
   * What to count by. Default is the caller's IP; authenticated endpoints
   * usually want the user id, which survives a changing IP.
   */
  keyBy?: (req: Request) => string;
  /** Do not count successful requests. Used on login: only failures count. */
  skipSuccessful?: boolean;
}

const defaultKey = (req: Request): string => `ip:${req.ip ?? 'unknown'}`;

/**
 * One round trip for the whole check.
 *
 * Doing this as four separate commands would be four round trips AND a race:
 * two concurrent requests can both read a count below the limit and both
 * proceed. A Lua script runs atomically on the server, so the read and the
 * write cannot interleave.
 *
 * Returns [allowed, currentCount, resetInMs].
 */
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max    = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count >= max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetIn = window
  if oldest[2] then
    resetIn = (tonumber(oldest[2]) + window) - now
  end
  return {0, count, resetIn}
end

redis.call('ZADD', key, now, member)
-- Expire the key itself, so an idle client leaves nothing behind. Without
-- this, every IP that ever called is a permanent key.
redis.call('PEXPIRE', key, window)
return {1, count + 1, window}
`;

export const rateLimit = (options: RateLimitOptions): RequestHandler => {
  const keyBy = options.keyBy ?? defaultKey;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }

    const redis = getRedis();
    if (!redis || !isCacheAvailable()) {
      // Fail open. See the header.
      next();
      return;
    }

    const key = `rl:${options.bucket}:${keyBy(req)}`;
    const now = Date.now();
    // Unique per request: two requests in the same millisecond must both count,
    // and a plain timestamp member would collapse them into one ZADD.
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const [allowed, count, resetInMs] = (await redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        now,
        options.windowMs,
        options.max,
        member,
      )) as [number, number, number];

      res.setHeader('RateLimit-Limit', options.max);
      res.setHeader('RateLimit-Remaining', Math.max(0, options.max - count));
      res.setHeader('RateLimit-Reset', Math.ceil(resetInMs / 1000));

      if (allowed === 0) {
        res.setHeader('Retry-After', Math.ceil(resetInMs / 1000));
        log.warn(
          { bucket: options.bucket, key, count, max: options.max, path: req.originalUrl },
          'rate limit exceeded',
        );
        next(
          new TooManyRequestsError('Too many requests. Slow down and try again shortly.', {
            retryAfterSeconds: Math.ceil(resetInMs / 1000),
          }),
        );
        return;
      }

      // On login, a successful attempt should not consume budget -- otherwise
      // a busy teller hits the limit doing nothing wrong, while an attacker
      // (who only ever fails) is unaffected.
      if (options.skipSuccessful) {
        res.on('finish', () => {
          if (res.statusCode < 400) {
            void redis.zrem(key, member).catch(() => undefined);
          }
        });
      }

      next();
    } catch (error) {
      log.warn({ err: error, bucket: options.bucket }, 'rate limit check failed; allowing request');
      next();
    }
  };
};

/**
 * Login limiter.
 *
 * Per IP, because the attack is one password across many accounts and the
 * account is therefore not a useful key. Only failures count, so real staff
 * are unaffected. Layered on top of the per-account lockout from Phase 4:
 * together they cover both stuffing and spraying.
 */
export const loginRateLimit = rateLimit({
  bucket: 'login',
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessful: true,
});

/** Blunt per-IP ceiling for anonymous traffic. */
export const anonymousRateLimit = rateLimit({
  bucket: 'anon',
  windowMs: 60 * 1000,
  max: 120,
});

/**
 * Posting limiter -- per USER, not per IP.
 *
 * A branch is behind one NAT address, so an IP limit would throttle the whole
 * branch because one teller is fast. The limit that makes sense on the money
 * path is per operator.
 */
export const postingRateLimit = rateLimit({
  bucket: 'posting',
  windowMs: 60 * 1000,
  max: 60,
  keyBy: (req) => `user:${req.actor?.userId ?? req.ip ?? 'unknown'}`,
});
