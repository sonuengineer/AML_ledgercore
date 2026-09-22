import type { NextFunction, Request, Response } from 'express';
import { logger } from '../shared/logging/logger';
import { getContext } from '../shared/logging/context';

/**
 * Access log.
 *
 * Phase 9 lists the fields this must carry: requestId, timestamp, method,
 * endpoint, status, latency, userId, error. They are emitted here, once per
 * request, on the `finish` event so the status and duration are final.
 *
 * `req.route?.path` rather than `req.originalUrl` for the `route` field: the
 * templated path (`/api/v1/branches/:id`) is what you group by in a dashboard.
 * The raw URL would give one cardinality bucket per branch id.
 */

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const ctx = getContext();

    const payload = {
      method: req.method,
      path: req.originalUrl,
      route: req.route?.path ?? req.baseUrl ?? undefined,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: ctx?.userId,
      staffCode: ctx?.staffCode,
      branchId: ctx?.branchId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      contentLength: res.getHeader('content-length'),
    };

    if (res.statusCode >= 500) {
      logger.error(payload, 'request failed');
    } else if (res.statusCode >= 400) {
      logger.warn(payload, 'request rejected');
    } else {
      logger.info(payload, 'request completed');
    }
  });

  next();
};
