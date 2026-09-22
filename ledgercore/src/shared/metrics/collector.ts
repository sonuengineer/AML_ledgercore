import { prisma } from '../db/prisma';
import { moduleLogger } from '../logging/logger';
import {
  deadLetters,
  outboxOldestPendingSeconds,
  pendingAuthorisations,
  queueDepth,
} from './registry';

const log = moduleLogger('metrics-collector');

/**
 * Periodic collector for metrics that are QUERIED rather than observed.
 *
 * Counters and histograms are updated at the moment something happens. These
 * are different: they are properties of the system's current state -- how many
 * jobs are waiting, how old the oldest unpublished event is -- and nothing
 * "happens" to make them change. They have to be sampled.
 *
 * Done on a timer rather than inside the `/metrics` handler on purpose. A
 * scrape must be fast and must not touch the database: if it did, a slow
 * database would make the scrape time out, Prometheus would record the target
 * as DOWN, and the monitoring would fail at precisely the moment it was most
 * needed. Sampling on a timer means a scrape only reads memory.
 *
 * The cost is that these gauges are up to one interval stale. For values that
 * move on the scale of seconds-to-minutes, that is irrelevant.
 */

const INTERVAL_MS = 15_000;

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Queue depth needs the queue connection, and the API process does not have
 * one. Injected by whichever process starts the collector, so the API can
 * collect database gauges without opening a queue connection it otherwise
 * would not need.
 */
export interface CollectorOptions {
  collectQueueDepths?: () => Promise<
    Array<{ queue: string; waiting: number; active: number; delayed: number; failed: number }>
  >;
}

export const collectOnce = async (options: CollectorOptions = {}): Promise<void> => {
  // Each block is independently guarded. A failure collecting one gauge must
  // not stop the others -- partial metrics beat none, and the missing series
  // is itself a signal.
  try {
    const rows = await prisma.$queryRaw<Array<{ age: number | null }>>`
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS age
        FROM outbox_event
       WHERE status IN ('PENDING', 'FAILED')
    `;
    // 0, not "absent", when there is nothing pending: a missing series and a
    // healthy zero look identical in a graph, and `absent()` alerting is a
    // trap people fall into once and then never again.
    outboxOldestPendingSeconds.set(rows[0]?.age ?? 0);
  } catch (error) {
    log.warn({ err: error }, 'failed to collect outbox age');
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM voucher WHERE status = 'PENDING_AUTH'
    `;
    pendingAuthorisations.set(Number(rows[0]?.n ?? 0));
  } catch (error) {
    log.warn({ err: error }, 'failed to collect pending authorisations');
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM dead_letter WHERE replayed_at IS NULL
    `;
    deadLetters.set(Number(rows[0]?.n ?? 0));
  } catch (error) {
    log.warn({ err: error }, 'failed to collect dead letters');
  }

  if (options.collectQueueDepths) {
    try {
      for (const depth of await options.collectQueueDepths()) {
        queueDepth.set({ queue: depth.queue, state: 'waiting' }, depth.waiting);
        queueDepth.set({ queue: depth.queue, state: 'active' }, depth.active);
        queueDepth.set({ queue: depth.queue, state: 'delayed' }, depth.delayed);
        queueDepth.set({ queue: depth.queue, state: 'failed' }, depth.failed);
      }
    } catch (error) {
      log.warn({ err: error }, 'failed to collect queue depths');
    }
  }
};

export const startCollector = (options: CollectorOptions = {}): void => {
  if (running) return;
  running = true;

  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      await collectOnce(options);
    } catch (error) {
      log.error({ err: error }, 'metrics collection tick failed');
    } finally {
      if (running) timer = setTimeout(() => void tick(), INTERVAL_MS);
    }
  };

  void tick();
  log.info({ intervalMs: INTERVAL_MS }, 'metrics collector started');
};

export const stopCollector = (): void => {
  running = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
};
