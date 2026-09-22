import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCache, disconnectCache, getRedis, isCacheAvailable } from '../src/shared/cache/redis';
import {
  cached,
  cacheKeys,
  cacheStats,
  invalidate,
  invalidatePrefix,
  resetCacheStats,
} from '../src/shared/cache/cacheAside';
import { acquireLock, releaseLock, withLock } from '../src/shared/cache/lock';
import { ConflictError } from '../src/shared/errors/AppError';

/**
 * Phase 6 integration tests.
 *
 * The properties that matter are not "the cache caches". They are:
 *   - a miss loads and stores, a hit does not reload
 *   - invalidation actually removes
 *   - concurrent misses collapse into ONE load (stampede)
 *   - the lock is mutually exclusive, and only its owner can release it
 *   - the fencing token is monotonic
 *
 * Needs the docker-compose Redis.
 */

beforeAll(async () => {
  await connectCache();
  // Give ioredis's lazy connect a moment to reach 'ready'.
  for (let i = 0; i < 40 && !isCacheAvailable(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(async () => {
  await disconnectCache();
});

const uniqueKey = (name: string): string => `test:${name}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

describe('cache-aside', () => {
  it('is actually connected (otherwise every test below is vacuous)', () => {
    expect(isCacheAvailable()).toBe(true);
  });

  it('loads on a miss and serves the next read from the cache', async () => {
    const key = uniqueKey('basic');
    let loads = 0;

    const loader = async (): Promise<{ value: number }> => {
      loads += 1;
      return { value: 42 };
    };

    expect(await cached(key, loader)).toEqual({ value: 42 });
    expect(loads).toBe(1);

    expect(await cached(key, loader)).toEqual({ value: 42 });
    // The whole point: the loader did NOT run again.
    expect(loads).toBe(1);
  });

  it('collapses concurrent misses into a single load', async () => {
    const key = uniqueKey('stampede');
    let loads = 0;

    const loader = async (): Promise<string> => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 'value';
    };

    // Twenty simultaneous requests for a cold key. Without in-flight
    // de-duplication this is twenty identical database queries -- a stampede.
    const results = await Promise.all(Array.from({ length: 20 }, () => cached(key, loader)));

    expect(results.every((value) => value === 'value')).toBe(true);
    expect(loads).toBe(1);
  });

  it('invalidation removes the entry so the next read reloads', async () => {
    const key = uniqueKey('invalidate');
    let loads = 0;
    const loader = async (): Promise<number> => {
      loads += 1;
      return loads;
    };

    expect(await cached(key, loader)).toBe(1);
    expect(await cached(key, loader)).toBe(1);

    await invalidate(key);

    expect(await cached(key, loader)).toBe(2);
  });

  it('honours a TTL', async () => {
    const key = uniqueKey('ttl');
    await cached(key, async () => 'short', { ttlSeconds: 1 });

    const redis = getRedis()!;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1);
  });

  it('invalidates a whole prefix with SCAN, not KEYS', async () => {
    const prefix = `test:prefix:${Date.now()}:`;
    await Promise.all([
      cached(`${prefix}a`, async () => 'a'),
      cached(`${prefix}b`, async () => 'b'),
      cached(`${prefix}c`, async () => 'c'),
    ]);

    const removed = await invalidatePrefix(prefix);
    expect(removed).toBe(3);

    let reloaded = false;
    await cached(`${prefix}a`, async () => {
      reloaded = true;
      return 'a';
    });
    expect(reloaded).toBe(true);
  });

  it('survives a corrupt entry by discarding and reloading', async () => {
    const key = uniqueKey('corrupt');
    const redis = getRedis()!;
    await redis.set(key, 'this is not json');

    let loads = 0;
    const value = await cached(key, async () => {
      loads += 1;
      return { ok: true };
    });

    expect(value).toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  it('bypass skips the cache entirely', async () => {
    const key = uniqueKey('bypass');
    let loads = 0;
    const loader = async (): Promise<number> => {
      loads += 1;
      return loads;
    };

    await cached(key, loader);
    await cached(key, loader, { bypass: true });
    await cached(key, loader, { bypass: true });

    expect(loads).toBe(3);
  });

  it('counts hits and misses so the hit ratio can be reported', async () => {
    resetCacheStats();
    const key = uniqueKey('stats');

    await cached(key, async () => 'v'); // miss
    await cached(key, async () => 'v'); // hit
    await cached(key, async () => 'v'); // hit

    const stats = cacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.hitRatio).toBeCloseTo(0.667, 2);
  });

  it('builds keys through one place, so invalidation cannot miss a spelling', () => {
    expect(cacheKeys.rolePermissions('abc')).toBe('perm:role:abc');
    expect(cacheKeys.rolePermissions('abc').startsWith(cacheKeys.rolePermissionsPrefix)).toBe(true);
  });
});

describe('distributed lock', () => {
  it('is mutually exclusive', async () => {
    const key = uniqueKey('lock-mutex');
    const first = await acquireLock(key, 5_000);

    await expect(acquireLock(key, 5_000)).rejects.toThrow(ConflictError);

    await releaseLock(first);

    // Free again once released.
    const second = await acquireLock(key, 5_000);
    expect(second.token).not.toBe(first.token);
    await releaseLock(second);
  });

  it('hands out monotonically increasing fencing tokens', async () => {
    const a = await acquireLock(uniqueKey('fence-a'), 2_000);
    const b = await acquireLock(uniqueKey('fence-b'), 2_000);

    // The guard against a paused holder writing after its lock expired: a
    // resource that only accepts an increasing token rejects the stale writer.
    expect(b.fencingToken).toBeGreaterThan(a.fencingToken);

    await releaseLock(a);
    await releaseLock(b);
  });

  it('refuses to release a lock it does not own', async () => {
    const key = uniqueKey('lock-steal');
    const owner = await acquireLock(key, 5_000);

    // Forge a handle with the right key but the wrong token -- what a naive
    // GET-then-DEL release would do after the lock expired and was re-taken.
    const impostor = { ...owner, token: 'not-the-owner-token' };

    expect(await releaseLock(impostor)).toBe(false);
    // Still held by the real owner.
    await expect(acquireLock(key, 1_000)).rejects.toThrow(ConflictError);

    await releaseLock(owner);
  });

  it('releases even when the work throws', async () => {
    const key = uniqueKey('lock-finally');

    await expect(
      withLock(key, 5_000, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');

    // Free, not blocked until the TTL expires.
    const after = await acquireLock(key, 1_000);
    expect(after).toBeTruthy();
    await releaseLock(after);
  });

  it('serialises concurrent attempts: exactly one runs', async () => {
    const key = uniqueKey('lock-race');
    let ran = 0;

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        withLock(key, 3_000, async () => {
          ran += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'done';
        }),
      ),
    );

    // This is the day-end guarantee: five nodes try, one runs, four are told
    // it is already running rather than doing it again.
    expect(ran).toBe(1);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(4);
  });
});
