import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config';
import {
  httpErrors,
  httpRequestDuration,
  httpRequestsInFlight,
  metricsSnapshot,
  registry,
} from '../shared/metrics/registry';

/**
 * HTTP metrics middleware.
 *
 * The whole file exists to get ONE thing right: the `route` label must be the
 * TEMPLATE, not the URL.
 *
 *   wrong:  /api/v1/branches/553bc38e-3968-43aa-b6c5-f7e660e1417c
 *   right:  /api/v1/branches/:id
 *
 * The wrong version creates a permanent time series per branch, per account,
 * per voucher -- unbounded cardinality, held in memory on every node, and the
 * classic one-line change that takes down a Prometheus server.
 */

/**
 * Express only populates `req.route` AFTER routing, and `req.route.path` is
 * relative to the router it was mounted on -- so `/branches/:id` comes back as
 * just `/:id`. `req.baseUrl` carries the mount prefix, and joining them gives
 * the full template.
 *
 * A request that never matched a route (404) has no `req.route` at all. Those
 * collapse to a single `unmatched` label rather than leaking whatever path a
 * scanner probed, which would otherwise be attacker-controlled cardinality.
 */
const routeLabel = (req: Request): string => {
  if (!req.route) {
    // Health endpoints are mounted directly and are worth seeing individually.
    if (['/health', '/readiness', '/liveness', '/metrics'].includes(req.path)) return req.path;
    return 'unmatched';
  }

  const base = req.baseUrl || '';
  const path = (req.route as { path?: string }).path ?? '';
  const joined = `${base}${path === '/' ? '' : path}`;
  return joined || '/';
};

/** 2xx -> "2xx". Keeps the label set at five values instead of sixty. */
const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

export const httpMetrics = (req: Request, res: Response, next: NextFunction): void => {
  // The scrape endpoint measuring itself is noise, and it skews the latency
  // histogram because it is far slower than a real request.
  if (req.path === '/metrics') {
    next();
    return;
  }

  httpRequestsInFlight.inc();
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    httpRequestsInFlight.dec();

    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_class: statusClass(res.statusCode),
    };

    httpRequestDuration.observe(labels, seconds);

    if (res.statusCode >= 400) {
      // `res.locals.errorCode` is set by the error handler. Falling back to the
      // status keeps the label bounded when a 4xx was produced without going
      // through an AppError.
      const code = (res.locals.errorCode as string | undefined) ?? `HTTP_${res.statusCode}`;
      httpErrors.inc({ code, status: String(res.statusCode) });
    }
  });

  // `close` fires when the CLIENT disconnects before a response. Without it,
  // the in-flight gauge leaks upward forever and eventually reads as a
  // permanent overload that is not happening.
  res.on('close', () => {
    if (!res.writableEnded) httpRequestsInFlight.dec();
  });

  next();
};

/**
 * The scrape endpoint.
 *
 * Deliberately NOT behind `authenticate`. Prometheus has no credentials, and
 * the standard answer is network-level restriction -- in AWS a security group
 * that only the scraper can reach, which Phase 11 sets up.
 *
 * What makes that acceptable is the cardinality discipline above: there are no
 * account numbers, user ids, amounts or messages in any label. The endpoint
 * exposes shape and volume, not content. If it exposed content, "restrict it
 * at the network layer" would not be good enough.
 */
export const metricsHandler: RequestHandler = async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', registry.contentType);
  res.send(await metricsSnapshot());
};

export const instanceLabel = config.instanceId;
