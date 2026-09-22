import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { TooManyRequestsError } from '../shared/errors/AppError';
import { moduleLogger } from '../shared/logging/logger';
import { httpRequestsInFlight, httpRequestsShed } from '../shared/metrics/registry';

const log = moduleLogger('load-shedding');

/**
 * Load shedding.
 *
 * The answer to "what happens at 10x traffic".
 *
 * Rate limiting (Phase 6) is about FAIRNESS -- stopping one caller consuming
 * everyone's capacity. Load shedding is about SURVIVAL: when total demand
 * exceeds what this process can serve, something has to be refused, and it is
 * far better to refuse it immediately than to accept it and serve everyone
 * slowly.
 *
 * The failure mode without it is specific and ugly. Node accepts every
 * connection it is offered, so under overload the queue of in-flight requests
 * grows without bound. Latency rises, clients time out and RETRY -- adding
 * more load -- and the server keeps doing work for requests nobody is waiting
 * for any more. Throughput collapses toward zero while CPU sits at 100%.
 * That is congestion collapse, and it does not recover on its own.
 *
 * Shedding turns it into a partial outage that recovers the moment demand
 * drops.
 *
 * ---------------------------------------------------------------------------
 * Why in-flight count rather than CPU or latency
 * ---------------------------------------------------------------------------
 *
 * CPU is a lagging signal and, on a container sharing cores (Phase 8 measured
 * exactly that), it reflects neighbours as much as this process.
 *
 * Latency is also lagging: by the time p99 is bad, the queue is already deep.
 *
 * In-flight count is the queue depth itself -- the thing that IS the problem,
 * measured directly and with no delay.
 */

export interface LoadSheddingOptions {
  /** Refuse new work above this many concurrent requests. */
  maxInFlight: number;
  /**
   * Paths that are never shed.
   *
   * Health endpoints especially: shedding `/readiness` under load would make
   * the load balancer pull an overloaded-but-working node out of rotation,
   * concentrating its traffic on the remaining nodes and knocking them over
   * too. That is how a capacity problem becomes a cascading failure.
   */
  exempt?: string[];
}

const DEFAULT_EXEMPT = ['/liveness', '/readiness', '/health', '/metrics'];

export const loadShedding = (options: LoadSheddingOptions): RequestHandler => {
  const exempt = new Set([...DEFAULT_EXEMPT, ...(options.exempt ?? [])]);
  let inFlight = 0;
  let shedTotal = 0;
  let lastLoggedAt = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (exempt.has(req.path)) {
      next();
      return;
    }

    if (inFlight >= options.maxInFlight) {
      shedTotal += 1;
      // The process-local counter above dies with the process and is visible
      // to nobody. Phase 16 found load shedding mounted since Phase 10 with no
      // metric at all -- there was no way to answer 'did we shed anything last
      // night'. A protection you cannot observe is a protection you cannot
      // tune, and cannot prove fired.
      httpRequestsShed.inc();

      // Log at most once a second. A shedding event by definition happens
      // thousands of times a second, and logging each one turns a capacity
      // problem into a disk-and-CPU problem as well.
      const now = Date.now();
      if (now - lastLoggedAt > 1000) {
        lastLoggedAt = now;
        log.warn(
          { inFlight, maxInFlight: options.maxInFlight, shedTotal },
          'shedding load: too many concurrent requests',
        );
      }

      // Retry-After tells a well-behaved client to back off rather than
      // retry immediately, which is what turns shedding into recovery instead
      // of a retry storm.
      res.setHeader('Retry-After', '1');
      next(
        new TooManyRequestsError('Server is at capacity. Retry shortly.', {
          reason: 'load_shed',
        }),
      );
      return;
    }

    inFlight += 1;

    const release = (): void => {
      inFlight -= 1;
    };

    // Both events: 'finish' for a normal response, 'close' for a client that
    // disconnected first. Missing 'close' leaks the counter upward and the
    // server eventually sheds everything while idle.
    res.once('finish', release);
    res.once('close', () => {
      if (!res.writableEnded) release();
    });

    next();
  };
};

/** Exposed for /health so an operator can see shedding is active. */
export const inFlightGauge = httpRequestsInFlight;
