import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config';
import { UnauthorizedError } from '../../shared/errors/AppError';
import { noContent, ok } from '../../shared/http/respond';
import { paginationQuerySchema } from '../../shared/http/pagination';
import { requireActor } from '../../middleware/authenticate';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwordPolicy';
import type { IssuedRefreshToken, RefreshContext } from './refreshToken.service';
import * as service from './identity.service';

export const loginBodySchema = z.object({
  staffCode: z.string().trim().min(1).max(16),
  // Bounded on both ends. The lower bound is policy; the upper bound stops a
  // 1 MB "password" from costing a full scrypt run and becoming a cheap DoS.
  password: z.string().min(8).max(MAX_PASSWORD_LENGTH),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  // The real policy lives in passwordPolicy.ts and throws a typed business
  // error naming the rule that failed. zod only enforces the cheap bounds, so
  // the user gets "must not contain your name" rather than a generic 400.
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

export const listUsersQuerySchema = paginationQuerySchema.extend({
  branchId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'DISABLED', 'LOCKED']).optional(),
});

export const userIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * Refresh-token cookie.
 *
 *   httpOnly  JavaScript cannot read it, so an XSS payload cannot exfiltrate
 *             the long-lived credential. This is the whole reason the refresh
 *             token is a cookie while the access token is not: the access
 *             token is short-lived and lives in JS memory; the refresh token
 *             is long-lived and must be unreachable from JS.
 *   secure    HTTPS only. Off in development because a Secure cookie is simply
 *             not stored over plain http, which would break the local loop
 *             silently rather than loudly.
 *   sameSite  'strict' -- the browser will not attach this cookie to a
 *             cross-site request, which is the primary CSRF defence for the
 *             refresh endpoint. A dedicated CSRF token would be belt and
 *             braces; the trade-off is noted in the Phase 4 write-up.
 *   path      '/api/v1/auth' only. An ordinary business call never carries
 *             this cookie, so it cannot leak through a logging proxy on some
 *             unrelated endpoint.
 */
const refreshCookieOptions = (expiresAt?: Date): CookieOptions => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: 'strict',
  path: config.auth.refreshCookiePath,
  ...(expiresAt ? { expires: expiresAt } : {}),
});

const setRefreshCookie = (res: Response, token: IssuedRefreshToken): void => {
  res.cookie(config.auth.refreshCookieName, token.token, refreshCookieOptions(token.expiresAt));
};

const clearRefreshCookie = (res: Response): void => {
  // Must match path/sameSite/secure exactly or the browser keeps the old one.
  res.clearCookie(config.auth.refreshCookieName, refreshCookieOptions());
};

const readRefreshToken = (req: Request): string | undefined => {
  const fromCookie = req.cookies?.[config.auth.refreshCookieName] as string | undefined;
  if (fromCookie) return fromCookie;
  // Fallback for non-browser clients (a native app, a smoke test) that cannot
  // hold cookies. Browsers must use the cookie -- a refresh token in a JSON
  // body is reachable from JavaScript, which defeats httpOnly.
  const fromBody = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof fromBody === 'string' && fromBody.length > 0 ? fromBody : undefined;
};

const contextFrom = (req: Request): RefreshContext => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

const sessionPayload = (actor: service.Actor) => ({
  id: actor.userId,
  staffCode: actor.staffCode,
  displayName: actor.displayName,
  roleCode: actor.roleCode,
  branchId: actor.branchId,
  branchCode: actor.branchCode,
});

export const login = async (req: Request, res: Response): Promise<void> => {
  const { staffCode, password } = req.body as z.infer<typeof loginBodySchema>;
  const result = await service.login(staffCode, password, contextFrom(req));

  setRefreshCookie(res, result.refreshToken);

  // The refresh token itself is NOT in the body. It is in the httpOnly cookie
  // and nowhere else, so no amount of XSS can read it.
  ok(res, {
    accessToken: result.accessToken.token,
    expiresIn: result.accessToken.expiresInSeconds,
    tokenType: 'Bearer',
    mustChangePassword: result.mustChangePassword,
    user: sessionPayload(result.actor),
  });
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  const presented = readRefreshToken(req);
  if (!presented) {
    throw new UnauthorizedError('No refresh token supplied', { reason: 'missing_cookie' });
  }

  try {
    const result = await service.refresh(presented, contextFrom(req));
    setRefreshCookie(res, result.refreshToken);

    ok(res, {
      accessToken: result.accessToken.token,
      expiresIn: result.accessToken.expiresInSeconds,
      tokenType: 'Bearer',
      user: sessionPayload(result.actor),
    });
  } catch (error) {
    // Any refresh failure -- expired, revoked, reuse detected -- leaves a dead
    // cookie in the browser that would be replayed on every subsequent attempt.
    // Clear it so the client lands cleanly on the login screen.
    clearRefreshCookie(res);
    throw error;
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  await service.logout(readRefreshToken(req));
  clearRefreshCookie(res);
  // 204 whether or not a session existed. Logout is idempotent, and telling a
  // caller "that token was not valid" is information they have no use for.
  noContent(res);
};

export const logoutAll = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const revoked = await service.logoutAll(actor.userId);
  clearRefreshCookie(res);
  ok(res, { sessionsRevoked: revoked });
};

export const listSessions = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const sessions = await service.listSessions(actor.userId, readRefreshToken(req));
  ok(res, sessions, { count: sessions.length });
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordBodySchema>;

  await service.changePassword(actor.userId, currentPassword, newPassword);

  clearRefreshCookie(res);
  ok(res, {
    changed: true,
    // Said plainly so the client can show the right message instead of
    // silently bouncing the user to a login screen they did not expect.
    message: 'Password changed. All sessions have been signed out -- sign in again.',
  });
};

/** The client's view of its own session. Drives the UI's menu and guards. */
export const me = async (req: Request, res: Response): Promise<void> => {
  const actor = requireActor(req);
  ok(res, {
    ...sessionPayload(actor),
    multiBranchAccess: actor.multiBranchAccess,
    mustChangePassword: actor.mustChangePassword,
    // Sent so the UI can hide what the user cannot do. The server still
    // enforces every one of these independently -- hiding a button is not
    // authorisation, which is the mistake the legacy .mnu model made.
    permissions: [...actor.permissions].sort(),
  });
};

export const listUsers = async (req: Request, res: Response): Promise<void> => {
  const query = req.query as unknown as z.infer<typeof listUsersQuerySchema>;
  const page = await service.listUsers(query);
  ok(res, page.items, { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: query.limit });
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as z.infer<typeof userIdParamSchema>;
  ok(res, await service.getUser(id));
};
