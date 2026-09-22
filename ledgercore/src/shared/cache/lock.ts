import { randomUUID } from 'node:crypto';
import { ConflictError, ServiceUnavailableError } from '../errors/AppError';
import { moduleLogger } from '../logging/logger';
import { getRedis, isCacheAvailable } from './redis';

const log = moduleLogger('lock');

/**
 * Distributed lock.
 *
 * Used for work that must happen at most once across every API node: day-end
 * for a branch, a scheduled job, a one-shot migration of data.
 *
 * ---------------------------------------------------------------------------
 * This lock FAILS CLOSED. That is the opposite of every other Redis use here.
 * ---------------------------------------------------------------------------
 *
 * The cache fails open: Redis down means slower reads. Rate limiting fails
 * open: Redis down means an unthrottled but working API. Both are right,
 * because the alternative is an outage caused by a component that is only
 * meant to be an optimisation.
 *
 * A lock is not an optimisation. If Redis is down we cannot know whether
 * another node is already running day-end, and running it twice would post
 * interest twice. Refusing to start is recoverable; double-posting is not.
 *
 * ---------------------------------------------------------------------------
 * What this lock is NOT
 * ---------------------------------------------------------------------------
 *
 * It is not safe against a process that pauses past its TTL -- a long GC or a
 * suspended VM can leave the holder believing it still owns a lock that has
 * expired and been taken by someone else. That is the well-known limitation of
 * any TTL-based lock, Redlock included.
 *
 * Two mitigations, both used:
 *
 *   1. A fencing token: a monotonically increasing number handed out with the
 *      lock. A resource that accepts a token only if it is greater than the
 *      last one it saw will reject a stale holder's write even if that holder
 *      still thinks it owns the lock.
 *   2. For the case that actually matters -- day-end -- the real guard is in
 *      Postgres: `pg_advisory_xact_lock(branch, date)` plus the business-date
 *      status transition, both inside the same transaction as the work. This
 *      Redis lock is the cheap first line that avoids the database round trip;
 *      the database is the line that is actually authoritative.
 *
 * Being able to say that last paragraph is the point. A Redis lock presented
 * as a correctness guarantee is a bug waiting to happen.
 */

export interface LockHandle {
  key: string;
  /** Proves ownership on release, so we cannot free somebody else's lock. */
  token: string;
  /** Monotonic. Pass to any resource that can reject out-of-order writers. */
  fencingToken: number;
  expiresAt: number;
}

const FENCE_KEY = 'lock:fence';

/**
 * Release only if we still own it.
 *
 * GET-then-DEL is a race: the lock can expire and be re-acquired by another
 * node between the two commands, and the DEL then frees THEIR lock. Lua runs
 * the compare and the delete as one atomic step on the server.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Same race, same fix, for extending a lock we still hold. */
const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export const acquireLock = async (
  key: string,
  ttlMs: number,
): Promise<LockHandle> => {
  const redis = getRedis();

  if (!redis || !isCacheAvailable()) {
    // Fail closed. See the header.
    log.error({ key }, 'cannot acquire lock: cache unavailable, refusing to proceed');
    throw new ServiceUnavailableError(
      'Coordination service is unavailable, so this operation cannot be started safely.',
    );
  }

  const token = randomUUID();
  const lockKey = `lock:${key}`;

  const acquired = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');

  if (acquired !== 'OK') {
    const holderTtl = await redis.pttl(lockKey);
    log.warn({ key, holderTtlMs: holderTtl }, 'lock already held');
    throw new ConflictError('This operation is already running. Wait for it to finish.', {
      lock: key,
      retryAfterMs: holderTtl > 0 ? holderTtl : undefined,
    });
  }

  const fencingToken = await redis.incr(FENCE_KEY);

  log.info({ key, fencingToken, ttlMs }, 'lock acquired');

  return { key: lockKey, token, fencingToken, expiresAt: Date.now() + ttlMs };
};

export const releaseLock = async (handle: LockHandle): Promise<boolean> => {
  const redis = getRedis();
  if (!redis || !isCacheAvailable()) return false;

  try {
    const released = await redis.eval(RELEASE_SCRIPT, 1, handle.key, handle.token);
    if (released === 0) {
      // We no longer owned it -- the TTL expired and somebody else took it.
      // Worth an error-level line: it means the work outran its own lock, and
      // whatever it did may have overlapped another run.
      log.error({ key: handle.key }, 'lock was no longer ours on release: it expired mid-operation');
    }
    return released === 1;
  } catch (error) {
    log.warn({ key: handle.key, err: error }, 'failed to release lock; it will expire on its own');
    return false;
  }
};

export const extendLock = async (handle: LockHandle, ttlMs: number): Promise<boolean> => {
  const redis = getRedis();
  if (!redis || !isCacheAvailable()) return false;

  const extended = await redis.eval(EXTEND_SCRIPT, 1, handle.key, handle.token, ttlMs);
  if (extended === 1) handle.expiresAt = Date.now() + ttlMs;
  return extended === 1;
};

/**
 * Run `work` while holding the lock, and always release.
 *
 * The lock is released in a `finally`, so a thrown error still frees it rather
 * than leaving the branch blocked until the TTL expires.
 */
export const withLock = async <T>(
  key: string,
  ttlMs: number,
  work: (handle: LockHandle) => Promise<T>,
): Promise<T> => {
  const handle = await acquireLock(key, ttlMs);
  try {
    return await work(handle);
  } finally {
    await releaseLock(handle);
  }
};
