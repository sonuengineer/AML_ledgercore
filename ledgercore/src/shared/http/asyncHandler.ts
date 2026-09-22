import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not await async handlers. A rejected promise inside a handler
 * never reaches the error middleware -- it becomes an unhandled rejection and,
 * on Node 20 defaults, kills the process. Every async route goes through this.
 *
 * (Express 5 fixes this natively. Noting it here so the wrapper can be deleted
 * on upgrade rather than surviving as cargo cult.)
 */
export const asyncHandler =
  <Req extends Request = Request>(
    handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req as Req, res, next)).catch(next);
  };
