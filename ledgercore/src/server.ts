import type { Server } from 'node:http';
import { config } from './config';
import { createApp } from './app';
import { connectDatabase, disconnectDatabase } from './shared/db/prisma';
import { connectCache, disconnectCache } from './shared/cache/redis';
import { startCollector, stopCollector } from './shared/metrics/collector';
import { logger } from './shared/logging/logger';
import { beginDraining } from './modules/health/health.routes';

/**
 * Process lifecycle.
 *
 * Graceful shutdown is not a nicety here. Phase 0 found that a deploy of the
 * legacy API destroyed every half-entered voucher, because the voucher lived in
 * `Context.Items` on that process. LedgerCore has no such state -- but an
 * in-flight POST /vouchers still holds an open database transaction, and
 * killing the process mid-transaction is how you get a row lock held until the
 * database notices the connection died.
 *
 * The sequence, and why each step is where it is:
 *
 *   SIGTERM
 *     |
 *   1. readiness starts returning 503      <- LB stops sending NEW requests
 *     |
 *   2. wait DRAIN_DELAY                    <- LB health check interval must
 *     |                                       elapse before we stop listening,
 *     |                                       or in-flight requests get RST
 *   3. server.close()                      <- finish in-flight, refuse new
 *     |
 *   4. disconnect the database             <- after the last query, not before
 *     |
 *   5. exit 0
 *
 * A hard timer guards the whole thing: if something hangs, exit non-zero
 * rather than leave a zombie that the orchestrator has to SIGKILL.
 */

/**
 * Must exceed the load balancer's health check interval times its unhealthy
 * threshold, otherwise the LB is still routing to us when we stop listening.
 * Tuned against the real ALB settings in Phase 11.
 */
const DRAIN_DELAY_MS = config.isProduction ? 10_000 : 250;

let server: Server | undefined;
let shuttingDown = false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const closeServer = (httpServer: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    logger.warn({ signal }, 'shutdown already in progress, ignoring signal');
    return;
  }
  shuttingDown = true;

  logger.info({ signal, drainDelayMs: DRAIN_DELAY_MS }, 'shutdown initiated');

  const hardExit = setTimeout(() => {
    logger.fatal({ timeoutMs: config.shutdown.timeoutMs }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdown.timeoutMs);
  // Do not let this timer hold the event loop open if everything finishes early.
  hardExit.unref();

  try {
    beginDraining();
    stopCollector();
    await sleep(DRAIN_DELAY_MS);

    if (server) {
      await closeServer(server);
      logger.info('http server closed, no in-flight requests remain');
    }

    // Cache before database: nothing needs the cache once we have stopped
    // serving, and a hung Redis quit must not delay releasing DB connections.
    await disconnectCache();
    await disconnectDatabase();

    clearTimeout(hardExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.fatal({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  // Fail before listening rather than serving 503s to a load balancer that
  // then has to decide we are unhealthy.
  await connectDatabase();

  // Deliberately NOT awaited as a hard requirement: connectCache() never
  // throws. Starting without a database is fatal; starting without a cache is
  // a degraded but correct service.
  await connectCache();

  // Database-backed gauges only. The API has no queue connection and should
  // not open one just to report depth -- the worker already has one and
  // reports it, and Prometheus sums across instances.
  startCollector();

  const app = createApp();

  server = app.listen(config.http.port, () => {
    logger.info(
      { port: config.http.port, env: config.env, nodeVersion: process.version },
      'ledgercore api listening',
    );
  });

  // Above the ALB's own idle timeout (60s default), otherwise Node closes a
  // connection the LB still believes is usable and the client sees a 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'http server error');
    process.exit(1);
  });
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection means a promise failed with nobody listening -- the
 * process is in an unknown state. Log it and shut down cleanly rather than
 * continuing to serve traffic from a process we can no longer reason about.
 * (`asyncHandler` exists so this should never fire from a route.)
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});

void start().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
