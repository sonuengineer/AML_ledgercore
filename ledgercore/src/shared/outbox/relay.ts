import { config } from '../../config';
import { prisma, transaction, type TxClient } from '../db/prisma';
import { moduleLogger } from '../logging/logger';
import { bullQueue } from '../queue/bullmq';
import { QUEUES, type QueueName } from '../queue/types';
import { outboxEventsPublished } from '../metrics/registry';

const log = moduleLogger('outbox-relay');

/**
 * The outbox relay.
 *
 * Phase 5 wrote events into `outbox_event` inside the same transaction as the
 * state change, so the two commit or fail together. Nothing published them.
 * This is the other half.
 *
 * ---------------------------------------------------------------------------
 * The claim query
 * ---------------------------------------------------------------------------
 *
 *   SELECT ... FOR UPDATE SKIP LOCKED
 *
 * `SKIP LOCKED` is what makes this safe to run on every API node at once.
 * Without it, three relays would all try to lock the same oldest rows: two
 * would block behind the first, do nothing useful, and serialise the whole
 * pipeline. With it, each relay silently steps over rows another has claimed
 * and takes the next free batch. Three relays means three times the
 * throughput, not three times the contention -- and no leader election, no
 * coordination service, no split-brain.
 *
 * ---------------------------------------------------------------------------
 * Delivery semantics, stated honestly
 * ---------------------------------------------------------------------------
 *
 * AT LEAST ONCE. The relay publishes, then marks the row SENT. If it dies
 * between those two steps the row is still PENDING and will be published
 * again.
 *
 * The other ordering -- mark sent, then publish -- would lose events instead,
 * which is strictly worse: a duplicate is a consumer's problem and a
 * solvable one; a lost posting event is silent data loss.
 *
 * Two things absorb the duplicate:
 *   1. BullMQ de-duplicates on jobId, which is the outbox row id;
 *   2. every consumer de-duplicates independently, because (1) only holds
 *      while the job is still in Redis.
 */

/** Which queue an event type fans out to. */
const routeFor = (eventType: string): QueueName[] => {
  if (eventType.startsWith('voucher.')) {
    // One event, three consumers, each with its own retry budget and failure
    // mode. A single "do everything" consumer would mean a failing SMS gateway
    // blocking the audit trail.
    return [QUEUES.AUDIT, QUEUES.NOTIFICATIONS, QUEUES.AML];
  }
  return [QUEUES.EVENTS];
};

interface ClaimedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  requestId: string | null;
  attempts: number;
}

/**
 * Claim a batch.
 *
 * `FOR UPDATE SKIP LOCKED` inside a transaction. The lock is held only while
 * the batch is published, which is why the batch size is modest -- a large
 * batch means a long transaction and rows locked away from other relays.
 */
const claimBatch = async (tx: TxClient, limit: number): Promise<ClaimedEvent[]> =>
  tx.$queryRaw<ClaimedEvent[]>`
    SELECT id,
           event_type     AS "eventType",
           aggregate_type AS "aggregateType",
           aggregate_id   AS "aggregateId",
           payload,
           request_id     AS "requestId",
           attempts
      FROM outbox_event
     WHERE status IN ('PENDING', 'FAILED')
       AND available_at <= now()
     ORDER BY available_at, id
     LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
  `;

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

export const drainOnce = async (batchSize = config.queue.outboxBatchSize): Promise<RelayResult> =>
  transaction(async (tx) => {
    const events = await claimBatch(tx, batchSize);
    if (events.length === 0) return { claimed: 0, published: 0, failed: 0 };

    let published = 0;
    let failed = 0;

    for (const event of events) {
      const targets = routeFor(event.eventType);

      try {
        await Promise.all(
          targets.map(async (queue) =>
            bullQueue.enqueue(
              queue,
              event.eventType,
              {
                data: {
                  eventType: event.eventType,
                  aggregateType: event.aggregateType,
                  aggregateId: event.aggregateId,
                  payload: event.payload,
                },
                requestId: event.requestId ?? undefined,
                // The outbox row id IS the idempotency key. It is stable
                // across republishes of the same row, which is exactly what
                // at-least-once delivery needs it to be. Per queue, so the
                // same event fanned out to three queues is three distinct
                // jobs rather than one that collides with itself.
                //
                // Separator is '--', not ':'. BullMQ uses ':' internally as
                // its Redis key separator and rejects a custom job id
                // containing one with "Custom Id cannot contain :". The relay
                // caught it correctly -- events went to FAILED with that
                // message and were retried, rather than being lost -- but the
                // pipeline published nothing until it was fixed.
                idempotencyKey: `${queue}--${event.id}`,
              },
            ),
          ),
        );

        await tx.$executeRaw`
          UPDATE outbox_event
             SET status = 'SENT', sent_at = now(), attempts = attempts + 1
           WHERE id = ${event.id}::uuid
        `;
        published += 1;
        outboxEventsPublished.inc({ result: 'published' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = event.attempts + 1;

        // Exponential backoff on the ROW, capped at 5 minutes. A permanently
        // broken event must not be retried in a tight loop -- that turns one
        // bad row into a busy loop that starves every healthy one behind it.
        const backoffMs = Math.min(1_000 * 2 ** attempts, 300_000);

        await tx.$executeRaw`
          UPDATE outbox_event
             SET status = 'FAILED',
                 attempts = ${attempts},
                 last_error = ${message.slice(0, 500)},
                 available_at = now() + ${`${backoffMs} milliseconds`}::interval
           WHERE id = ${event.id}::uuid
        `;
        failed += 1;
        outboxEventsPublished.inc({ result: 'failed' });

        log.error(
          { outboxId: event.id, eventType: event.eventType, attempts, backoffMs, err: message },
          'failed to publish outbox event; will retry',
        );
      }
    }

    if (published > 0 || failed > 0) {
      log.info({ claimed: events.length, published, failed }, 'outbox batch relayed');
    }

    return { claimed: events.length, published, failed };
  });

/**
 * Poll loop.
 *
 * Polling, not logical decoding. Postgres CDC would remove the poll interval
 * entirely, at the cost of a replication slot, a decoding plugin and a new
 * operational failure mode -- a slot that stops being consumed pins WAL and
 * eventually fills the disk. At this scale a 200 ms poll on a partial index is
 * cheap and has no such failure mode. Worth naming as the next step, not worth
 * building yet.
 */
let running = false;
let timer: NodeJS.Timeout | undefined;

export const startRelay = (): void => {
  if (running) return;
  running = true;

  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      // Keep draining while batches come back full: a burst should not be
      // metered out one batch per poll interval.
      let result = await drainOnce();
      while (running && result.claimed >= config.queue.outboxBatchSize) {
        result = await drainOnce();
      }
    } catch (error) {
      // Never let the loop die. A database blip must pause the relay, not end
      // it -- events are durable and will still be there on the next tick.
      log.error({ err: error }, 'relay tick failed');
    } finally {
      if (running) timer = setTimeout(() => void tick(), config.queue.outboxPollIntervalMs);
    }
  };

  void tick();
  log.info({ intervalMs: config.queue.outboxPollIntervalMs }, 'outbox relay started');
};

export const stopRelay = (): void => {
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
  log.info('outbox relay stopped');
};

/**
 * Oldest unsent event age, in seconds.
 *
 * The one number that tells you the relay is broken. Queue depth alone does
 * not: if the relay has stopped, the queue is EMPTY and looks perfectly
 * healthy while events pile up in Postgres. Phase 9 alerts on this.
 */
export const oldestPendingAgeSeconds = async (): Promise<number | null> => {
  const rows = await prisma.$queryRaw<Array<{ age: number | null }>>`
    SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS age
      FROM outbox_event
     WHERE status IN ('PENDING', 'FAILED')
  `;
  return rows[0]?.age ?? null;
};
