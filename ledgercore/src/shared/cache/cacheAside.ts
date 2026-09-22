import { config } from '../../config';
import { moduleLogger } from '../logging/logger';
import { safely } from './redis';
import { cacheOperations } from '../metrics/registry';

const log = moduleLogger('cache');

/**
 * Cache-aside.
 *
 *   Request
 *      |
 *      v
 *    Redis --- HIT ---> return
 *      |
 *     MISS
 *      |
 *      v
 *   Postgres
 *      |
 *      +---> write to Redis (TTL)
 *      |
 *      v
 *    return
 *
 * Why cache-aside rather than read-through or write-through:
 *
 *   read-through  needs the cache to know how to load from the database,
 *                 which means the cache layer owns domain queries. Wrong
 *                 place for that knowledge.
 *   write-through writes go to the cache first, so a cache failure becomes a
 *                 WRITE failure. Unacceptable when the cache is allowed to be
 *                 down.
 *   cache-aside   the application owns both sides. A cache failure degrades
 *                 reads and touches writes not at all.
 *
 * ---------------------------------------------------------------------------
 * What this is used for, and what it is deliberately NOT used for
 * ---------------------------------------------------------------------------
 *
 * USED: product master, GL heads, role permissions, business date. All read
 * on nearly every request, all changed a few times a year, and all harmless
 * if a few seconds stale -- a product's minimum balance changing at 11:00:00
 * and taking effect at 11:00:05 hurts nobody.
 *
 * NOT USED: account balances. Ever. The balance IS the product. A stale read
 * can authorise a debit that overdraws an account, and no reconciliation makes
 * that acceptable. Balances are read from Postgres under a row lock at the
 * moment they are about to change -- see posting.service.ts. Being able to
 * explain that refusal is worth more than the latency it costs.
 */

export interface CacheOptions {
  ttlSeconds?: number;
  /** Skip the cache entirely for this call. Used by admin reads that must be fresh. */
  bypass?: boolean;
}

interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
}

// Per-process counters. Phase 9 replaces these with real metrics; they exist
// now so the Phase 6 before/after can be measured rather than asserted.
const stats: CacheStats = { hits: 0, misses: 0, errors: 0 };

export const cacheStats = (): CacheStats & { hitRatio: number } => {
  const total = stats.hits + stats.misses;
  return { ...stats, hitRatio: total === 0 ? 0 : Math.round((stats.hits / total) * 1000) / 1000 };
};

export const resetCacheStats = (): void => {
  stats.hits = 0;
  stats.misses = 0;
  stats.errors = 0;
};

/**
 * In-flight de-duplication, per process.
 *
 * On a cache miss for a hot key, N concurrent requests would each run the same
 * database query -- a cache stampede. Sharing one in-flight promise collapses
 * them into a single query.
 *
 * This is per-process, so with three API nodes a stampede costs at most three
 * queries instead of N. A cross-process lock would reduce that to one, at the
 * cost of a Redis round trip on every miss and a new failure mode when the
 * lock holder dies. Three queries is not worth that.
 */
const inFlight = new Map<string, Promise<unknown>>();

export const cached = async <T>(
  key: string,
  loader: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> => {
  if (!config.cache.enabled || options.bypass) return loader();

  const ttl = options.ttlSeconds ?? config.cache.defaultTtlSeconds;

  const hit = await safely(
    async (redis) => redis.get(key),
    null,
    `get ${key}`,
  );

  if (hit !== null) {
    try {
      stats.hits += 1;
      cacheOperations.inc({ result: 'hit' });
      return JSON.parse(hit) as T;
    } catch {
      // A corrupt entry is not a reason to fail the request. Drop it and
      // reload -- self-healing beats an error the caller cannot act on.
      stats.errors += 1;
      cacheOperations.inc({ result: 'error' });
      log.warn({ key }, 'cache entry could not be parsed; discarding');
      await safely(async (redis) => redis.del(key), 0, `del ${key}`);
    }
  }

  stats.misses += 1;
  cacheOperations.inc({ result: 'miss' });

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async (): Promise<T> => {
    try {
      const value = await loader();

      // Fire and forget. The response must not wait on the cache write, and a
      // failed write is a missed optimisation, not a failed request.
      void safely(
        async (redis) => redis.set(key, JSON.stringify(value), 'EX', ttl),
        'SKIPPED',
        `set ${key}`,
      );

      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
};

/**
 * Invalidate on write.
 *
 * Explicit DEL on the write path, with the TTL as a backstop. Two mechanisms
 * because each covers the other's failure: the DEL is immediate but can be
 * missed (Redis down, a code path that forgets), and the TTL always fires but
 * leaves a window.
 *
 * The consistency this buys is honest to state: **bounded staleness**, at most
 * the TTL, on data where staleness is harmless. It is not strong consistency,
 * and nothing that needs strong consistency is in here.
 */
export const invalidate = async (...keys: string[]): Promise<void> => {
  if (!config.cache.enabled || keys.length === 0) return;
  const removed = await safely(async (redis) => redis.del(...keys), 0, 'invalidate');
  if (removed > 0) log.debug({ keys, removed }, 'cache invalidated');
};

/**
 * Invalidate everything under a prefix.
 *
 * SCAN, never KEYS. `KEYS *` is O(n) and blocks the single-threaded Redis
 * server for the whole scan -- on a large keyspace it is an outage. SCAN is
 * cursor-based and yields between batches.
 *
 * Used sparingly: a role's permissions changing invalidates every user in that
 * role, and there is no better key structure for that without maintaining a
 * reverse index that would itself need invalidating.
 */
export const invalidatePrefix = async (prefix: string): Promise<number> =>
  safely(
    async (redis) => {
      let cursor = '0';
      let removed = 0;
      do {
        // The client has keyPrefix 'lc:', which SCAN's MATCH does NOT apply
        // automatically -- so the pattern has to carry it, while DEL must not.
        const [next, keys] = await redis.scan(cursor, 'MATCH', `lc:${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) {
          const unprefixed = keys.map((key) => key.slice(3));
          removed += await redis.del(...unprefixed);
        }
      } while (cursor !== '0');

      if (removed > 0) log.info({ prefix, removed }, 'cache prefix invalidated');
      return removed;
    },
    0,
    `invalidatePrefix ${prefix}`,
  );

/** Key builders. Centralised so an invalidation cannot miss a spelling. */
export const cacheKeys = {
  rolePermissions: (roleId: string): string => `perm:role:${roleId}`,
  rolePermissionsPrefix: 'perm:role:',
  product: (productId: string): string => `product:${productId}`,
  productPrefix: 'product:',
  businessDate: (branchId: string): string => `bizdate:${branchId}`,
  branch: (branchId: string): string => `branch:${branchId}`,
  idempotency: (key: string): string => `idem:${key}`,
} as const;
