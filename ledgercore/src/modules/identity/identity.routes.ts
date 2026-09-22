import { Router } from 'express';
import { asyncHandler } from '../../shared/http/asyncHandler';
import { validate } from '../../shared/http/validate';
import { authenticate } from '../../middleware/authenticate';
import { authorize } from '../../middleware/authorize';
import { loginRateLimit } from '../../middleware/rateLimit';
import * as controller from './identity.controller';

export const authRouter = Router();

/**
 * Anonymous by necessity -- this is where a session begins, so it is also the
 * one endpoint where brute force is the entire threat model.
 *
 * Two layers, because they catch different attacks:
 *   - the per-ACCOUNT lockout from Phase 4 stops credential stuffing against
 *     one account;
 *   - the per-IP limit here stops password SPRAYING, where one common password
 *     is tried across many staff codes and no single account ever reaches its
 *     threshold.
 *
 * Only failed attempts count, so a busy teller is never throttled while an
 * attacker -- who only fails -- is.
 */
authRouter.post(
  '/login',
  loginRateLimit,
  validate({ body: controller.loginBodySchema }),
  asyncHandler(controller.login),
);

/**
 * Deliberately NOT behind `authenticate`: the whole point of refresh is that
 * the access token has already expired. Authorisation comes from possession of
 * the httpOnly cookie, and the rotation logic treats a replayed token as
 * hostile.
 */
authRouter.post('/refresh', asyncHandler(controller.refresh));

/**
 * Also not behind `authenticate`. A user whose access token has expired must
 * still be able to log out -- forcing a valid access token here would leave
 * dead refresh families alive precisely when someone is trying to end a
 * session they are worried about.
 */
authRouter.post('/logout', asyncHandler(controller.logout));

authRouter.get('/me', authenticate, asyncHandler(controller.me));

authRouter.get('/sessions', authenticate, asyncHandler(controller.listSessions));

authRouter.post('/sessions/revoke-all', authenticate, asyncHandler(controller.logoutAll));

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: controller.changePasswordBodySchema }),
  asyncHandler(controller.changePassword),
);

export const userRouter = Router();

userRouter.use(authenticate);

userRouter.get(
  '/',
  authorize('user:read'),
  validate({ query: controller.listUsersQuerySchema }),
  asyncHandler(controller.listUsers),
);

userRouter.get(
  '/:id',
  authorize('user:read'),
  validate({ params: controller.userIdParamSchema }),
  asyncHandler(controller.getUser),
);
