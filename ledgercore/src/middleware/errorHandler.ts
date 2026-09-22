import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { AppError, InternalError, NotFoundError, isAppError } from '../shared/errors/AppError';
import { logger } from '../shared/logging/logger';
import { fail } from '../shared/http/respond';
import { vouchersRejected } from '../shared/metrics/registry';

/**
 * The single exit point for every failure.
 *
 * Contract:
 *  - A known AppError is reported with its own status, code and safe details.
 *  - Anything else becomes a 500 with no detail. An unexpected error's message
 *    can contain a connection string, a SQL fragment or a file path; none of
 *    that goes over the wire.
 *  - Expected failures log at warn without a stack, unexpected ones at error
 *    with the stack. This keeps the error log meaningful: a 404 is not noise
 *    an on-call engineer should have to filter out.
 */

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new NotFoundError('Route', `${req.method} ${req.originalUrl}`));
};

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Express requires the 4-arity signature to recognise this as error
  // middleware, and delegates to the default handler if headers already went out.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError: AppError = isAppError(error) ? error : new InternalError();

  // Handed to the metrics middleware, which reads it on 'finish'. The error
  // CODE is a bounded set and safe as a label; the message is not -- it
  // interpolates account numbers and amounts.
  res.locals.errorCode = appError.code;

  // Why a posting was refused, by rule. A spike in INSUFFICIENT_FUNDS is a
  // business event; a spike in DAY_NOT_OPEN means somebody forgot to run
  // day-begin. Both are bounded label sets, both are actionable, and neither
  // is visible in an HTTP status code alone -- they are all 422.
  if (appError.status === 422) vouchersRejected.inc({ reason: appError.code });

  if (appError.isExpected) {
    logger.warn(
      { code: appError.code, status: appError.status, details: appError.details },
      appError.message,
    );
  } else {
    logger.error(
      {
        code: appError.code,
        status: appError.status,
        err: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      },
      'unhandled error',
    );
  }

  // In development, surface the real message for an InternalError so debugging
  // does not require tailing logs. Never in production.
  const message =
    !appError.isExpected && !config.isProduction && error instanceof Error
      ? error.message
      : appError.message;

  fail(res, appError.status, appError.code, message, appError.details);
};
