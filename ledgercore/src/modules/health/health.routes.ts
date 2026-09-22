import { Router, type Request, type Response } from 'express';
import { config } from '../../config';
import { pingDatabase } from '../../shared/db/prisma';
import { isCacheAvailable, pingCache } from '../../shared/cache/redis';
import { cacheStats } from '../../shared/cache/cacheAside';
import { allBreakers } from '../../shared/resilience/circuitBreaker';
import { asyncHandler } from '../../shared/http/asyncHandler';
import { moduleLogger } from '../../shared/logging/logger';

const log = moduleLogger('health');

/**
 * Three endpoints, three different questions. Conflating them is a classic
 * outage amplifier.
 *
 *  /liveness   Is the process alive?
 *              NO dependency checks. If liveness checked Postgres, a database
 *              blip would make the orchestrator kill and restart every healthy
 *              node at once -- turning a recoverable dependency failure into a
 *              full outage.
 *
 *  /readiness  Should this instance receive traffic right now?
 *              Checks dependencies. The load balancer uses this one. Also
 *              returns 503 while shutting down, so the LB drains the node
 *              BEFORE the process stops accepting connections (Phase 3's
 *              graceful shutdown depends on this ordering).
 *
 *  /health     Detailed, for humans and dashboards. Never used by automation
 *              to make routing decisions.
 */

export const healthRouter = Router();

/** Flipped by the shutdown handler before the drain delay begins. */
let shuttingDown = false;
export const beginDraining = (): void => {
  shuttingDown = true;
  log.info('readiness now reporting not-ready (draining)');
};
export const isDraining = (): boolean => shuttingDown;

const startedAt = Date.now();

healthRouter.get('/liveness', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    instance: config.instanceId,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

healthRouter.get(
  '/readiness',
  asyncHandler(async (_req: Request, res: Response) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'draining' });
      return;
    }

    try {
      await pingDatabase();
      // Note what is NOT checked here: Redis. The cache is an optimisation,
      // and a node that can still answer every request -- more slowly -- is
      // ready. Failing readiness on a Redis blip would pull every node out of
      // the load balancer at once and turn a degradation into an outage.
      res.status(200).json({
        status: 'ready',
        instance: config.instanceId,
        cache: isCacheAvailable() ? 'available' : 'degraded',
      });
    } catch (error) {
      log.error({ err: error }, 'readiness check failed: database unreachable');
      res.status(503).json({ status: 'not_ready', reason: 'database_unreachable' });
    }
  }),
);

healthRouter.get(
  '/health',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; error?: string }> = {};

    const start = process.hrtime.bigint();
    try {
      await pingDatabase();
      checks.database = {
        status: 'up',
        latencyMs: Math.round(Number(process.hrtime.bigint() - start) / 1_000_000),
      };
    } catch (error) {
      checks.database = { status: 'down', error: error instanceof Error ? error.message : 'unknown' };
    }

    const cacheLatency = await pingCache();
    checks.cache =
      cacheLatency === null
        ? { status: 'down', error: 'unavailable -- serving from the database' }
        : { status: 'up', latencyMs: cacheLatency };

    // The cache is excluded from the healthy/degraded verdict on purpose: it
    // is reported so an operator can see it, not so automation can act on it.
    const healthy = checks.database?.status === 'up' && !shuttingDown;
    const memory = process.memoryUsage();

    res.status(healthy ? 200 : 503).json({
      status: shuttingDown ? 'draining' : healthy ? 'healthy' : 'degraded',
      version: process.env.npm_package_version ?? 'unknown',
      env: config.env,
      instance: config.instanceId,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
      // An open circuit is not unhealthy -- it is the system correctly
      // refusing to hammer something that is already down. Reported so an
      // operator can see it, excluded from the healthy/degraded verdict.
      circuits: allBreakers(),
      cacheStats: cacheStats(),
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      },
    });
  }),
);
