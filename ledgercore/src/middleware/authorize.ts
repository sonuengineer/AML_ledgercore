import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError } from '../shared/errors/AppError';
import { logger } from '../shared/logging/logger';
import { requireActor } from './authenticate';

/**
 * Permission enforcement.
 *
 * This replaces the legacy model, where `Setup/Fin_{GroupId}.mnu` files on each
 * API server's disk carried Add/Modify/Delete/Inquire/Authorize flags per form
 * code -- and those flags only drove what the React app rendered. No hub method
 * or controller checked them. Hiding a button is not authorisation.
 *
 * Here the check is server-side, on the route, and a route with no `authorize`
 * is a deliberate decision rather than an oversight (see the route files).
 *
 * Permission codes are `resource:action`:
 *   branch:read  user:read  voucher:create  voucher:authorize  dayend:run
 *
 * The legacy five verbs map onto them: Add -> create, Modify -> update,
 * Delete -> delete, Inquire -> read, Authorize -> authorize.
 */

/** Caller must hold ALL of these. */
export const authorize = (...required: string[]): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const actor = requireActor(req);
      const missing = required.filter((permission) => !actor.permissions.has(permission));

      if (missing.length > 0) {
        logger.warn(
          { required, missing, roleCode: actor.roleCode, path: req.originalUrl },
          'authorization denied',
        );
        // The client is told what it needed. That is not a leak -- the route
        // itself is public knowledge -- and it makes support calls tractable.
        throw new ForbiddenError('You do not have permission to perform this action', {
          required: missing,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/** Caller must hold AT LEAST ONE of these. */
export const authorizeAny = (...accepted: string[]): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const actor = requireActor(req);

      if (!accepted.some((permission) => actor.permissions.has(permission))) {
        logger.warn(
          { accepted, roleCode: actor.roleCode, path: req.originalUrl },
          'authorization denied',
        );
        throw new ForbiddenError('You do not have permission to perform this action', {
          requiredAnyOf: accepted,
        });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Branch scoping.
 *
 * A teller at branch 101 must not read branch 102's data just by changing an
 * id in the URL. This is the check the legacy system could not make at all,
 * because the branch arrived in the request body.
 *
 * `multiBranchAccess` is the legacy D002001.MultiBrAccess flag, now enforced.
 */
export const assertBranchAccess = (req: Request, branchId: string): void => {
  const actor = requireActor(req);
  if (actor.branchId === branchId) return;
  if (actor.multiBranchAccess) return;

  logger.warn(
    { actorBranchId: actor.branchId, requestedBranchId: branchId, userId: actor.userId },
    'cross-branch access denied',
  );
  throw new ForbiddenError('You may only access your own branch');
};
