import Redis, { type RedisOptions } from 'ioredis';
import { config } from '../../config';
import { moduleLogger } from '../logging/logger';
import { cacheAvailable, cacheCircuitState, cachePingDuration } from '../metrics/registry';
import { CircuitBreaker, CircuitOpenError } from '../resilience/circuitBreaker';

const log = moduleLogger('redis');

/**
 * Redis client -- CACHE role.
 *
 * The single most important property of this file is that **Redis being down
 * must not take the API down**. Everything in the cache is reconstructible
 * from Postgres, so a cache failure is a performance event, not an outage.
 * Every call here is wrapped, timed out, and falls back.
 *
 * That is not the default behaviour of a Redis client. `ioredis` will queue
 * commands while disconnected and retry forever, so a naive integration turns
 * a Redis blip into an API-wide hang -- requests pile up waiting on a cache
 * lookup that will never resolve. `enableOfflineQueue: false` plus an explicit
 * per-command timeout is what prevents that.
 *
 * Phase 7 adds a SECOND client for the job queue with the opposite settings:
 * offline queueing ON, `noeviction`, AOF. A queue must not lose work; a cache
 * must not block.
 */

const options: RedisOptions = {
  // Do NOT queue commands while disconnected. Fail fast so the caller can go
  // to the database instead of waiting for a reconnect that may not come.
  enableOfflineQueue: false,
  // Cap the reconnect backoff. Without this, a long outage pushes the retry
  // delay into minutes and the cache stays cold long after Redis recovers.
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  maxRetriesPerRequest: 1,
  connectTimeout: 3_000,
  commandTimeout: config.cache.commandTimeoutMs,
  lazyConnect: true,
  keyPrefix: 'lc:',
};

let client: Redis | undefined;
let available = false;

export const getRedis = (): Redis | undefined => client;

/** True when the last observed state was connected. Drives /health. */
export const isCacheAvailable = (): boolean => config.cache.enabled && available;

export const connectCache = async (): Promise<void> => {
  if (!config.cache.enabled) {
    log.warn('cache disabled by configuration; every lookup will hit postgres');
    return;
  }

  client = new Redis(config.cache.url, options);

  client.on('ready', () => {
    available = true;
    cacheAvailable.set(1);
    log.info('cache connected');
  });

  client.on('end', () => {
    available = false;
    cacheAvailable.set(0);
    log.warn('cache connection closed');
  });

  // An error handler is mandatory: an unhandled 'error' event on an
  // EventEmitter throws, and a Redis blip would then kill the process. The
  // whole point of this module is that a cache failure is survivable.
  client.on('error', (error: Error) => {
    if (available) log.error({ err: error.message }, 'cache error, degrading to database');
    available = false;
    cacheAvailable.set(0);
  });

  try {
    await client.connect();
  } catch (error) {
    // Starting without a cache is fine. Starting without a database is not --
    // that is why connectDatabase() throws and this does not.
    log.error({ err: error }, 'cache unavailable at startup; continuing without it');
    available = false;
  }
};

export const disconnectCache = async (): Promise<void> => {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  available = false;
  log.info('cache disconnected');
};

/**
 * Run a Redis operation, and return `fallback` on ANY failure.
 *
 * This is the only way the rest of the codebase touches Redis. It means no
 * caller has to remember the degradation rule -- it is structural.
 *
 * Note what is NOT logged at error level: a miss or a timeout is expected
 * behaviour under load, and paging someone for it would train them to ignore
 * the channel. A transition from available to unavailable is logged once, by
 * the 'error' handler above.
 */
/**
 * Circuit breaker around the cache.
 *
 * WHY THIS EXISTS, measured in Phase 16:
 *
 *   healthy cache  571 rps  p50  27.7ms
 *   cache STOPPED  142 rps  p50 112.5ms
 *   cache HUNG      58 rps  p50 335.5ms    <- 2.4x WORSE than dead
 *
 * A dead Redis is cheap: ioredis marks the client unavailable and the guard
 * above returns the fallback without a syscall. A HUNG Redis -- the container
 * paused, the host swapping, a network black hole -- keeps its connections
 * open and answers nothing, so every single request pays the full
 * REDIS_COMMAND_TIMEOUT_MS before falling back. The system does four times
 * more work to produce exactly the same answer.
 *
 * Worse, `cache_available` stayed at 1 throughout, so the CacheDegraded alert
 * never fired. The system believed the cache was fine while it was the single
 * most expensive thing happening.
 *
 * The breaker converts slow failure into fast failure: after
 * `failureThreshold` consecutive timeouts it stops calling Redis at all,
 * admits one probe after the cooldown, and closes again once that probe
 * succeeds twice.
 *
 * NOTE this is the first place the CircuitBreaker class is actually used.
 * Phase 10 built it with 13 unit tests and wired it to nothing -- a resilience
 * control that existed only in its own tests, while the documents claimed it
 * was protecting the system. Finding that was worth more than the breaker.
 *
 * Thresholds: 5 consecutive failures, because a single blip must not take the
 * cache out; 5s cooldown, because a cache is cheap to retry and staying open
 * too long throws away the hit ratio that pays for all of this.
 */
const cacheBreaker = new CircuitBreaker({
  name: 'cache',
  failureThreshold: 5,
  cooldownMs: 5_000,
  successThreshold: 2,
});

const publishCircuitState = (): void => {
  const state = cacheBreaker.snapshot().state;
  cacheCircuitState.set(state === 'OPEN' ? 2 : state === 'HALF_OPEN' ? 1 : 0);
  // The alert keys off cache_available, so an OPEN circuit has to show there
  // too. Otherwise the hung case stays invisible, which is the bug this whole
  // block exists to fix.
  if (state === 'OPEN') cacheAvailable.set(0);
  else if (available) cacheAvailable.set(1);
};

export const safely = async <T>(
  operation: (redis: Redis) => Promise<T>,
  fallback: T,
  context: string,
): Promise<T> => {
  if (!client || !available) return fallback;

  try {
    const result = await cacheBreaker.execute(async () => operation(client!));
    publishCircuitState();
    return result;
  } catch (error) {
    publishCircuitState();

    // An open circuit is the DESIGNED state, not an incident. Logging it per
    // request would produce exactly the log flood the breaker exists to stop.
    if (error instanceof CircuitOpenError) return fallback;

    log.warn({ context, err: error instanceof Error ? error.message : error }, 'cache operation failed');
    return fallback;
  }
};

/** For /health and tests. */
export const cacheCircuit = (): ReturnType<CircuitBreaker['snapshot']> => cacheBreaker.snapshot();

/** For /health. Returns latency in ms, or null when unavailable. */
export const pingCache = async (): Promise<number | null> => {
  if (!client || !available) return null;
  const start = process.hrtime.bigint();
  try {
    await client.ping();
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    cachePingDuration.observe(seconds);
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
};
