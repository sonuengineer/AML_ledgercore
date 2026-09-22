import { Worker, type Job, type Processor } from 'bullmq';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { runWithContext } from '../shared/logging/context';
import { getQueueConnection } from '../shared/queue/bullmq';
import type { JobEnvelope, QueueName } from '../shared/queue/types';
import { jobDuration, jobsProcessed } from '../shared/metrics/registry';

const log = moduleLogger('consumer');

/**
 * Shared consumer harness.
 *
 * Every worker in this system gets four things from here, so that no
 * individual consumer has to remember them:
 *
 *   1. the request id restored into AsyncLocalStorage, so a worker's log lines
 *      join the same trace as the API call that produced the event;
 *   2. structured logging of every attempt, with the attempt number;
 *   3. a dead letter written to POSTGRES on final failure;
 *   4. a place to state, per consumer, why it is idempotent.
 *
 * On (3): BullMQ keeps its own failed set, but that lives in Redis -- capped,
 * evictable, and gone on a flush. A dead letter is evidence that work was
 * lost. It belongs in the database, where it can be queried, alerted on and
 * replayed months later.
 */

export interface ConsumerOptions {
  queue: QueueName;
  concurrency?: number;
}

export type Handler<T> = (data: T, job: Job<JobEnvelope<T>>) => Promise<void>;

export const createConsumer = <T>(
  options: ConsumerOptions,
  handler: Handler<T>,
): Worker<JobEnvelope<T>> => {
  const processor: Processor<JobEnvelope<T>> = async (job) => {
    const envelope = job.data;

    // Restore the trace. Without this, a worker's logs are an island and
    // "what happened to voucher X" needs two separate searches.
    const context = {
      requestId: envelope.requestId ?? `job:${job.id ?? 'unknown'}`,
      method: 'JOB',
      path: `${options.queue}/${job.name}`,
      startedAt: Date.now(),
    };

    return runWithContext(context, async () => {
      const startedAt = process.hrtime.bigint();
      try {
        await handler(envelope.data, job);
        jobDuration.observe(
          { queue: options.queue, job: job.name },
          Number(process.hrtime.bigint() - startedAt) / 1e9,
        );
        jobsProcessed.inc({ queue: options.queue, job: job.name, result: 'completed' });
        log.info(
          {
            queue: options.queue,
            job: job.name,
            jobId: job.id,
            attempt: job.attemptsMade + 1,
            durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
          },
          'job completed',
        );
      } catch (error) {
        const attempt = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? 1;
        const isFinal = attempt >= maxAttempts;

        log[isFinal ? 'error' : 'warn'](
          {
            queue: options.queue,
            job: job.name,
            jobId: job.id,
            attempt,
            maxAttempts,
            isFinal,
            err: error instanceof Error ? error.message : String(error),
          },
          isFinal ? 'job failed permanently, writing dead letter' : 'job failed, will retry',
        );

        // Retries and dead letters are counted separately: a rising retry
        // rate is a dependency wobbling, a rising dead-letter rate is work
        // being lost. Very different pages at 3am.
        jobsProcessed.inc({
          queue: options.queue,
          job: job.name,
          result: isFinal ? 'dead_lettered' : 'retried',
        });

        if (isFinal) await writeDeadLetter(options.queue, job, error);

        // Rethrow either way: BullMQ needs the rejection to schedule the
        // retry, or to move the job to its failed set.
        throw error;
      }
    });
  };

  const worker = new Worker<JobEnvelope<T>>(options.queue, processor, {
    connection: getQueueConnection(),
    concurrency: options.concurrency ?? config.queue.workerConcurrency,
  });

  worker.on('error', (error) => log.error({ queue: options.queue, err: error.message }, 'worker error'));

  return worker;
};

const writeDeadLetter = async (
  queue: QueueName,
  job: Job,
  error: unknown,
): Promise<void> => {
  try {
    await prisma.deadLetter.create({
      data: {
        queueName: queue,
        jobName: job.name,
        jobId: job.id ?? null,
        payload: (job.data ?? {}) as Prisma.InputJsonValue,
        attempts: job.attemptsMade + 1,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        errorStack: error instanceof Error ? (error.stack ?? null) : null,
        requestId: (job.data as JobEnvelope | undefined)?.requestId ?? null,
      },
    });
  } catch (writeError) {
    // If even the dead letter cannot be written, say so as loudly as possible.
    // This is the point where work is genuinely, unrecoverably lost.
    log.error(
      { queue, jobId: job.id, err: writeError },
      'FAILED TO WRITE DEAD LETTER -- this job is lost',
    );
  }
};

/**
 * Replay a dead letter.
 *
 * A DLQ nobody can drain is a log file with extra steps. This is what makes it
 * a queue: an operator fixes the cause, then replays.
 *
 * `replayedAt` is stamped so the same letter cannot be replayed twice by two
 * operators both reacting to the same alert.
 */
export const replayDeadLetter = async (
  deadLetterId: string,
  replayedById: string,
): Promise<{ replayed: boolean; reason?: string }> => {
  const letter = await prisma.deadLetter.findUnique({ where: { id: deadLetterId } });
  if (!letter) return { replayed: false, reason: 'not_found' };
  if (letter.replayedAt) return { replayed: false, reason: 'already_replayed' };

  const { bullQueue } = await import('../shared/queue/bullmq');
  const envelope = letter.payload as unknown as JobEnvelope;

  await bullQueue.enqueue(
    letter.queueName as QueueName,
    letter.jobName,
    {
      ...envelope,
      // A NEW idempotency key. The original job id may still be in Redis's
      // completed/failed set, in which case re-enqueueing it would be a silent
      // no-op -- the operator would see "replayed" and nothing would run.
      idempotencyKey: `replay--${letter.id}`,
    },
  );

  await prisma.deadLetter.update({
    where: { id: deadLetterId },
    data: { replayedAt: new Date(), replayedById },
  });

  log.info({ deadLetterId, queue: letter.queueName, replayedById }, 'dead letter replayed');
  return { replayed: true };
};
