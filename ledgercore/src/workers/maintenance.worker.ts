import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { bullQueue } from '../shared/queue/bullmq';
import { QUEUES } from '../shared/queue/types';
import { purgeExpiredIdempotencyKeys } from '../middleware/idempotency';
import { purgeExpired as purgeExpiredRefreshTokens } from '../modules/identity/refreshToken.service';
import { createConsumer } from './consumer';

const log = moduleLogger('maintenance-worker');

/**
 * Scheduled housekeeping.
 *
 * Every one of these was written in an earlier phase and left with the note
 * "becomes a scheduled worker job in Phase 7". This is Phase 7.
 *
 * They run as repeatable queue jobs rather than `setInterval` in the API for
 * the reason given in Phase 2: a cron in the API means N nodes each running
 * it, so a purge runs three times and a partition is created three times. A
 * repeatable queue job is claimed by exactly one worker.
 */

export const JOBS = {
  PURGE_REFRESH_TOKENS: 'purge-refresh-tokens',
  PURGE_IDEMPOTENCY_KEYS: 'purge-idempotency-keys',
  ENSURE_PARTITIONS: 'ensure-partitions',
  PURGE_SENT_OUTBOX: 'purge-sent-outbox',
} as const;

/**
 * Create the next quarter's partition before anything needs it.
 *
 * Phase 5 created partitions only to 2027q1 and flagged this as a gap. It is
 * the gap that matters most operationally: an INSERT with no matching
 * partition is an ERROR, not a degradation, so running out of partitions is an
 * outage that arrives at midnight on a quarter boundary.
 *
 * Runs two quarters ahead, so a failure has three months of slack before it
 * becomes urgent.
 */
export const ensurePartitions = async (quartersAhead = 2): Promise<string[]> => {
  const created: string[] = [];
  const now = new Date();

  for (let i = 0; i <= quartersAhead; i += 1) {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + i * 3, 1),
    );
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1));
    const name = `voucher_line_${start.getUTCFullYear()}q${Math.floor(start.getUTCMonth() / 3) + 1}`;

    const exists = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_class WHERE relname = ${name}
    `;
    if (Number(exists[0]!.n) > 0) continue;

    // Cannot be parameterised: an identifier is not a value. The name is
    // constructed from arithmetic on the current date, never from input.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE ${name} PARTITION OF voucher_line FOR VALUES FROM ('${start
        .toISOString()
        .slice(0, 10)}') TO ('${end.toISOString().slice(0, 10)}')`,
    );

    created.push(name);
    log.info({ partition: name }, 'partition created');
  }

  return created;
};

/**
 * Delete outbox rows that were published long ago.
 *
 * SENT rows are pure noise in the relay's partial index and grow without
 * bound. The durable record of what happened lives in `audit_event`, which is
 * append-only and is the thing auditors read -- the outbox is a delivery
 * mechanism, not a history.
 */
export const purgeSentOutbox = async (olderThanHours = 48): Promise<number> => {
  const cutoff = new Date(Date.now() - olderThanHours * 3600 * 1000);
  const result = await prisma.outboxEvent.deleteMany({
    where: { status: 'SENT', sentAt: { lt: cutoff } },
  });
  return result.count;
};

export const startMaintenanceWorker = () =>
  createConsumer<Record<string, never>>(
    { queue: QUEUES.MAINTENANCE, concurrency: 1 },
    async (_data, job) => {
      switch (job.name) {
        case JOBS.PURGE_REFRESH_TOKENS: {
          const removed = await purgeExpiredRefreshTokens();
          log.info({ removed }, 'expired refresh tokens purged');
          return;
        }
        case JOBS.PURGE_IDEMPOTENCY_KEYS: {
          const removed = await purgeExpiredIdempotencyKeys();
          log.info({ removed }, 'expired idempotency keys purged');
          return;
        }
        case JOBS.ENSURE_PARTITIONS: {
          const created = await ensurePartitions();
          log.info({ created }, 'partition check complete');
          return;
        }
        case JOBS.PURGE_SENT_OUTBOX: {
          const removed = await purgeSentOutbox();
          log.info({ removed }, 'sent outbox rows purged');
          return;
        }
        default:
          log.warn({ job: job.name }, 'unknown maintenance job, ignoring');
      }
    },
  );

/**
 * Register the repeatable jobs.
 *
 * Safe to call from every worker process: BullMQ keys a repeatable job by
 * (name, pattern), so registering it N times still produces one schedule.
 */
export const scheduleMaintenance = async (): Promise<void> => {
  const empty = { data: {} as Record<string, never>, idempotencyKey: '' };

  // Hourly: cheap deletes that keep hot tables small.
  await bullQueue.schedule(QUEUES.MAINTENANCE, JOBS.PURGE_REFRESH_TOKENS, '0 * * * *', empty);
  await bullQueue.schedule(QUEUES.MAINTENANCE, JOBS.PURGE_IDEMPOTENCY_KEYS, '15 * * * *', empty);
  await bullQueue.schedule(QUEUES.MAINTENANCE, JOBS.PURGE_SENT_OUTBOX, '30 * * * *', empty);
  // Daily at 02:00, when nobody is posting.
  await bullQueue.schedule(QUEUES.MAINTENANCE, JOBS.ENSURE_PARTITIONS, '0 2 * * *', empty);

  log.info('maintenance schedule registered');
};
