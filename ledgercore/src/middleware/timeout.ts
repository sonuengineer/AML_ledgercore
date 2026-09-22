import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { moduleLogger } from '../shared/logging/logger';
import { fail } from '../shared/http/respond';

const log = moduleLogger('request-timeout');

/**
 * Request deadline.
 *
 * The backstop for a handler that never completes -- a dependency that hangs
 * without closing the connection, a bug that awaits something unresolved.
 * Without it such a request holds a socket, a connection-pool slot and a
 * load-shedding slot indefinitely.
 *
 * Deliberately GENEROUS (30s default) and deliberately the LAST line of
 * defence. Everything upstream should bite first: Redis at 150ms, Postgres
 * statement_timeout at 10s, nginx read timeout at 30s. If this fires, the
 * upstream bound is missing or wrong, so it logs at error rather than warn.
 */
export const requestTimeout = (ms = 30_000, exempt: string[] = []): RequestHandler => {
  const skip = new Set(['/liveness', '/readiness', '/health', '/metrics', ...exempt]);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip.has(req.path)) {
      next();
      return;
    }

    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;

      log.error(
        { method: req.method, path: req.originalUrl, timeoutMs: ms },
        'request exceeded its deadline -- an upstream timeout is missing or too high',
      );

      // 503, not 504: this process IS the origin. A 504 would claim an
      // upstream gateway failed, which misdirects whoever reads the log.
      fail(res, 503, 'REQUEST_TIMEOUT', 'The request took too long and was abandoned.', {
        timeoutMs: ms,
      });
    }, ms);

    // unref so a pending timer never keeps the process alive during a
    // graceful shutdown drain.
    timer.unref();

    res.once('finish', () => clearTimeout(timer));
    res.once('close', () => clearTimeout(timer));

    next();
  };
};
