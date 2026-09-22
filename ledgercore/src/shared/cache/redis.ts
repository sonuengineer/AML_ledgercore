import Redis, { type RedisOptions } from 'ioredis';
import { config } from '../../config';
import { moduleLogger } from '../logging/logger';
import { cacheAvailable, cachePingDuration } from '../metrics/registry';

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
export const safely = async <T>(
  operation: (redis: Redis) => Promise<T>,
  fallback: T,
  context: string,
): Promise<T> => {
  if (!client || !available) return fallback;

  try {
    return await operation(client);
  } catch (error) {
    log.warn({ context, err: error instanceof Error ? error.message : error }, 'cache operation failed');
    return fallback;
  }
};

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
