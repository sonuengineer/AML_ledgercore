import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../shared/errors/AppError';
import { enrichContext } from '../shared/logging/context';
import { resolveActor, type Actor } from '../modules/identity/identity.service';
import { verifyAccessToken } from '../modules/identity/token.service';

/**
 * Turns a bearer token into `req.actor`.
 *
 * Two-step on purpose:
 *   1. Verify the JWT signature, issuer, audience, expiry and type. Cheap,
 *      no I/O, rejects garbage before it can cost a database round trip.
 *   2. Load the user's CURRENT state and permissions.
 *
 * Step 2 is what a stateless-JWT purist would skip. It is here because a
 * disabled user or a removed permission must take effect now, not in up to 15
 * minutes. The cost is one small indexed lookup, and Phase 6 moves it to Redis.
 */

const BEARER = /^Bearer (.+)$/i;

const extractToken = (header: string | undefined): string => {
  if (!header) throw new UnauthorizedError('Authorization header missing');
  const match = BEARER.exec(header.trim());
  if (!match?.[1]) throw new UnauthorizedError('Authorization header must be "Bearer <token>"');
  return match[1];
};

export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extractToken(req.headers.authorization);
    const claims = verifyAccessToken(token);
    const actor = await resolveActor(claims.sub);

    // Access tokens are stateless, so they cannot be individually revoked.
    // Rather than pay for a denylist lookup on every request, the token
    // carries the credential version it was minted against. Any mismatch --
    // in either direction -- means this token belongs to a different password
    // than the account currently has, so it is refused immediately.
    //
    // Exact equality, not "older than": that avoids every clock-precision
    // edge case, and it also catches the odd case of a token minted against a
    // future value.
    if (claims.pwd !== actor.passwordChangedAt.getTime()) {
      throw new UnauthorizedError('Session ended because the password was changed', {
        reason: 'password_changed',
      });
    }

    // The branch in the token must still be one this user may act on.
    // Without this check a user moved to another branch keeps posting to the
    // old one until their token expires.
    if (actor.branchId !== claims.br && !actor.multiBranchAccess) {
      throw new UnauthorizedError('Session branch is no longer valid', { reason: 'branch_changed' });
    }

    req.actor = actor;

    // From here every log line in this request carries the actor.
    enrichContext({
      userId: actor.userId,
      staffCode: actor.staffCode,
      branchId: actor.branchId,
      roleCode: actor.roleCode,
    });

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Narrowing helper. A handler that calls this can rely on the actor existing;
 * if `authenticate` was not wired onto the route, this throws rather than
 * letting the handler run with `undefined`.
 */
export const requireActor = (req: Request): Actor => {
  if (!req.actor) {
    throw new UnauthorizedError('Authentication required');
  }
  return req.actor;
};
