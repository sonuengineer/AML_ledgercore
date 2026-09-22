import { createServer, type Server } from 'node:http';
import type { Worker } from 'bullmq';
import { config } from './config';
import { connectDatabase, disconnectDatabase } from './shared/db/prisma';
import { connectCache, disconnectCache } from './shared/cache/redis';
import { bullQueue, queueDepths } from './shared/queue/bullmq';
import { registry } from './shared/metrics/registry';
import { startCollector, stopCollector } from './shared/metrics/collector';
import { startRelay, stopRelay } from './shared/outbox/relay';
import { logger } from './shared/logging/logger';
import { startAuditWorker } from './workers/audit.worker';
import { startNotificationWorker } from './workers/notification.worker';
import { startAmlWorker } from './workers/aml.worker';
import { scheduleMaintenance, startMaintenanceWorker } from './workers/maintenance.worker';

/**
 * Worker entrypoint.
 *
 * A SEPARATE process from the API, sharing the same codebase. The three
 * reasons from Phase 2, unchanged:
 *
 *   1. CPU-bound work (AML aggregation, report generation) would block the
 *      API's event loop.
 *   2. API and workers scale on DIFFERENT signals -- the API on RPS and
 *      latency, workers on queue depth.
 *   3. A worker crash must not take down the API, and deploying one must not
 *      force a deploy of the other.
 *
 * This is the modular-monolith payoff: same modules, same domain code,
 * different entrypoint. Extracting a worker into its own service later is a
 * deployment change, not a rewrite.
 */

const workers: Worker[] = [];
let metricsServer: Server | undefined;
let shuttingDown = false;

/**
 * The worker needs its own scrape endpoint.
 *
 * It has no HTTP surface otherwise, but its metrics are the ones that matter
 * most for the async pipeline -- queue depth, job durations, dead letters --
 * and Prometheus can only pull. A worker that does not expose them is a worker
 * nobody can see into.
 *
 * Health endpoints are deliberately NOT added here: the worker has no
 * readiness concept (nothing routes to it) and adding one would invite an
 * orchestrator to restart a perfectly healthy worker mid-job.
 */
const startMetricsServer = (): Server => {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    void registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType }).end(body);
      })
      .catch(() => res.writeHead(500).end());
  });

  server.listen(config.metrics.workerPort, () => {
    logger.info({ port: config.metrics.workerPort }, 'worker metrics endpoint listening');
  });

  return server;
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'worker shutdown initiated');

  const hardExit = setTimeout(() => {
    logger.fatal('worker shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdown.timeoutMs);
  hardExit.unref();

  try {
    // Stop taking new work FIRST, then let in-flight jobs finish.
    stopRelay();
    stopCollector();
    if (metricsServer) metricsServer.close();

    // `close()` waits for active jobs to complete. That matters more here than
    // in the API: a job killed mid-flight is redelivered, and a consumer that
    // is only idempotent at the database level still pays for the retry.
    await Promise.all(workers.map(async (worker) => worker.close()));
    logger.info({ workers: workers.length }, 'workers closed, no jobs in flight');

    await bullQueue.close();
    await disconnectCache();
    await disconnectDatabase();

    clearTimeout(hardExit);
    logger.info('worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.fatal({ err: error }, 'error during worker shutdown');
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  await connectDatabase();
  await connectCache();

  workers.push(startAuditWorker());
  workers.push(startNotificationWorker());
  workers.push(startAmlWorker());
  workers.push(startMaintenanceWorker());

  await scheduleMaintenance();

  metricsServer = startMetricsServer();

  // The worker DOES have a queue connection, so it is the process that reports
  // queue depth. Reporting it from every API node too would be duplicate
  // series measuring the same shared queue.
  startCollector({ collectQueueDepths: queueDepths });

  // The relay runs HERE, not in the API.
  //
  // It could run in either -- it only needs Postgres and the queue. Putting it
  // in the worker keeps the API's job purely request/response, and means the
  // relay scales with the thing that consumes its output rather than with
  // inbound traffic.
  startRelay();

  logger.info(
    { workers: workers.length, concurrency: config.queue.workerConcurrency },
    'ledgercore worker started',
  );
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection in worker');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception in worker');
  void shutdown('uncaughtException');
});

void start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
