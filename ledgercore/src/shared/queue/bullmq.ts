import { Queue, type JobsOptions, type RedisOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { config } from '../../config';
import { moduleLogger } from '../logging/logger';
import {
  QUEUES,
  type EnqueueOptions,
  type JobEnvelope,
  type JobQueue,
  type QueueDepth,
  type QueueName,
} from './types';

const log = moduleLogger('queue');

/**
 * BullMQ adapter.
 *
 * Connects to the QUEUE Redis, which is a different instance from the cache
 * and configured the opposite way: `noeviction` and AOF on. Running a queue on
 * an LRU cache is a trap worth naming -- under memory pressure Redis evicts
 * keys, the keys are jobs, and work disappears with no error anywhere.
 *
 * The connection settings are also the mirror image of the cache client's:
 *
 *   cache: enableOfflineQueue false, maxRetriesPerRequest 1, short timeout
 *          -- a cache must never block a request
 *   queue: offline queueing ON, maxRetriesPerRequest null
 *          -- a queue must never silently drop work
 *
 * `maxRetriesPerRequest: null` is not optional: BullMQ's blocking commands
 * (BRPOPLPUSH and friends) sit idle for long periods, and any finite retry
 * count makes ioredis abort them with "max retries per request exceeded".
 */

const connectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
};

let connection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

export const getQueueConnection = (): Redis => {
  if (!connection) {
    connection = new IORedis(config.queue.url, connectionOptions);
    connection.on('error', (error: Error) => log.error({ err: error.message }, 'queue redis error'));
    connection.on('ready', () => log.info('queue redis connected'));
  }
  return connection;
};

const getQueue = (name: QueueName): Queue => {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        /**
         * Five attempts with exponential backoff: 1s, 2s, 4s, 8s, 16s.
         *
         * Exponential rather than fixed because the common cause of failure is
         * a dependency under load -- an SMS gateway, a database mid-failover.
         * Retrying at a fixed interval hammers a struggling service and turns
         * a blip into an outage. Backing off gives it room to recover.
         */
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        /**
         * Keep completed jobs briefly, failed jobs much longer.
         *
         * Completed jobs are only useful for a short while and would otherwise
         * grow without bound in Redis -- which, on a `noeviction` instance,
         * eventually means writes start failing. Failures are the ones anyone
         * actually needs to look at.
         */
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    queue.on('error', (error: Error) => log.error({ queue: name, err: error.message }, 'queue error'));
    queues.set(name, queue);
  }
  return queue;
};

const toJobsOptions = (envelope: JobEnvelope, options?: EnqueueOptions): JobsOptions => ({
  /**
   * BullMQ de-duplicates on jobId: enqueueing an existing id is a no-op.
   *
   * That makes the PRODUCER side idempotent, which matters because the outbox
   * relay can publish the same row twice if it crashes between publishing and
   * marking it sent. It does NOT make the consumer side idempotent -- once a
   * job completes and is removed, the same id can be enqueued again. Consumers
   * still have to de-duplicate on their own, which is why every one of them
   * does.
   */
  // BullMQ rejects a custom job id containing ':' -- it is their Redis key
  // separator. An empty key means "let BullMQ assign one", which is correct
  // for scheduler templates where the id must differ per occurrence.
  ...(envelope.idempotencyKey ? { jobId: envelope.idempotencyKey } : {}),
  ...(options?.delayMs !== undefined ? { delay: options.delayMs } : {}),
  ...(options?.attempts !== undefined ? { attempts: options.attempts } : {}),
  ...(options?.backoffMs !== undefined
    ? { backoff: { type: 'exponential' as const, delay: options.backoffMs } }
    : {}),
});

export const bullQueue: JobQueue = {
  async enqueue<T>(
    queue: QueueName,
    jobName: string,
    envelope: JobEnvelope<T>,
    options?: EnqueueOptions,
  ): Promise<string> {
    const job = await getQueue(queue).add(jobName, envelope, toJobsOptions(envelope, options));
    log.debug({ queue, jobName, jobId: job.id }, 'job enqueued');
    return job.id ?? envelope.idempotencyKey;
  },

  async enqueueMany<T>(
    queue: QueueName,
    jobs: Array<{ jobName: string; envelope: JobEnvelope<T>; options?: EnqueueOptions }>,
  ): Promise<string[]> {
    if (jobs.length === 0) return [];

    const added = await getQueue(queue).addBulk(
      jobs.map((job) => ({
        name: job.jobName,
        data: job.envelope,
        opts: toJobsOptions(job.envelope, job.options),
      })),
    );

    log.debug({ queue, count: added.length }, 'jobs enqueued in bulk');
    return added.map((job, index) => job.id ?? jobs[index]!.envelope.idempotencyKey);
  },

  async schedule<T>(
    queue: QueueName,
    jobName: string,
    cron: string,
    envelope: JobEnvelope<T>,
  ): Promise<void> {
    /**
     * BullMQ 6 replaced `add(..., { repeat })` with job schedulers.
     *
     * The scheduler id is the unit of idempotency: upserting the same id is
     * a no-op, so every worker process can register the same schedule at
     * startup and exactly one series of jobs results. Under the old API a
     * repeatable job also had to avoid a fixed jobId, or every occurrence
     * would collide with the first and it would run exactly once -- the
     * scheduler API removes that footgun.
     */
    await getQueue(queue).upsertJobScheduler(
      `${queue}:${jobName}`,
      { pattern: cron },
      { name: jobName, data: envelope },
    );
    log.info({ queue, jobName, cron }, 'repeatable job scheduled');
  },

  async close(): Promise<void> {
    for (const [name, queue] of queues) {
      await queue.close();
      log.debug({ queue: name }, 'queue closed');
    }
    queues.clear();
    if (connection) {
      connection.disconnect();
      connection = undefined;
    }
  },
};

/**
 * Queue depth -- the single most useful operational metric for async work.
 *
 * A growing `waiting` count means consumers cannot keep up, which is the
 * signal to scale workers (Phase 8) and the thing to alert on in Phase 9. It
 * is also the number that tells you an incident is ongoing before any user
 * notices, because the API is still happily accepting requests.
 */
export const queueDepths = async (): Promise<QueueDepth[]> =>
  Promise.all(
    Object.values(QUEUES).map(async (name) => {
      const counts = await getQueue(name).getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      return {
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    }),
  );
