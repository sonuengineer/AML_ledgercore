import type { RevokeReason, UserStatus } from '@prisma/client';
import {
  BusinessRuleError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors/AppError';
import { buildPage, type Page } from '../../shared/http/pagination';
import { moduleLogger } from '../../shared/logging/logger';
import { authFailures } from '../../shared/metrics/registry';
import * as repo from './identity.repository';
import { equaliseTiming, scryptHasher } from './password.service';
import { assertPasswordAcceptable } from './passwordPolicy';
import * as refreshTokens from './refreshToken.service';
import type { RefreshContext, SessionView } from './refreshToken.service';
import { issueAccessToken, type IssuedToken } from './token.service';

const log = moduleLogger('identity');

/**
 * Identity business rules. No SQL here, no Express here.
 *
 * Phase 4 scope: password login issuing an access token AND a rotating refresh
 * token, refresh with reuse detection, logout, logout-everywhere, session
 * listing, and password change with policy.
 */

/** Mirrors the legacy D002001.MaxBadLiPerInst, which was never enforced. */
const FAILED_LOGIN_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface Actor {
  userId: string;
  staffCode: string;
  displayName: string;
  branchId: string;
  branchCode: number;
  roleId: string;
  roleCode: string;
  permissions: ReadonlySet<string>;
  multiBranchAccess: boolean;
  /** Becomes the token's `pwd` claim, and is checked on every request. */
  passwordChangedAt: Date;
  mustChangePassword: boolean;
}

export interface LoginResult {
  accessToken: IssuedToken;
  refreshToken: refreshTokens.IssuedRefreshToken;
  actor: Actor;
  mustChangePassword: boolean;
}

const toActor = (
  user: repo.UserWithRoleAndBranch,
  permissions: readonly string[],
): Actor => ({
  userId: user.id,
  staffCode: user.staffCode,
  displayName: user.displayName,
  branchId: user.homeBranchId,
  branchCode: user.homeBranch.code,
  roleId: user.roleId,
  roleCode: user.role.code,
  permissions: new Set(permissions),
  multiBranchAccess: user.multiBranchAccess,
  passwordChangedAt: user.passwordChangedAt,
  mustChangePassword: user.mustChangePassword,
});

/**
 * Authenticate a staff code and password.
 *
 * Every failure path returns the SAME error. Distinguishing "no such user"
 * from "wrong password" from "account locked" hands an attacker a user
 * enumeration oracle. The specific reason goes to the log, not to the client.
 */
export const login = async (
  staffCode: string,
  password: string,
  context: RefreshContext = {},
): Promise<LoginResult> => {
  const invalid = () => new UnauthorizedError('Invalid staff code or password');

  const user = await repo.findUserByStaffCode(staffCode);

  if (!user) {
    // Burn the same CPU a real verification would, so response time does not
    // reveal whether the staff code exists.
    await equaliseTiming();
    // The REASON is recorded in the metric even though the client is told
    // nothing -- a spike in unknown_user is credential stuffing, a spike in
    // bad_password against known accounts is spraying. The response stays
    // identical either way so the attacker learns nothing.
    authFailures.inc({ reason: 'unknown_user' });
    log.warn({ staffCode }, 'login failed: unknown staff code');
    throw invalid();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await equaliseTiming();
    authFailures.inc({ reason: 'locked' });
    log.warn({ userId: user.id, lockedUntil: user.lockedUntil }, 'login failed: account locked');
    throw invalid();
  }

  if (user.status !== 'ACTIVE') {
    await equaliseTiming();
    authFailures.inc({ reason: 'inactive' });
    log.warn({ userId: user.id, status: user.status }, 'login failed: account not active');
    throw invalid();
  }

  const passwordMatches = await scryptHasher.verify(password, user.passwordHash);

  if (!passwordMatches) {
    await repo.recordFailedLogin(user.id, FAILED_LOGIN_THRESHOLD, LOCK_DURATION_MS);
    authFailures.inc({ reason: 'bad_password' });
    log.warn({ userId: user.id }, 'login failed: bad password');
    throw invalid();
  }

  if (user.homeBranch.status !== 'ACTIVE') {
    log.warn({ userId: user.id, branchId: user.homeBranchId }, 'login failed: branch not active');
    throw new ForbiddenError('Your branch is not currently active');
  }

  // Transparent hash upgrade. If the stored hash used weaker parameters than
  // we use today -- or a different algorithm entirely -- rehash it now, while
  // we legitimately hold the plaintext. This is the mechanism that lets a
  // scrypt -> argon2id migration happen with no flag day and no forced reset.
  //
  // `touchChangedAt: false` matters: this is not a credential change, so it
  // must not invalidate the user's other sessions.
  if (scryptHasher.needsRehash(user.passwordHash)) {
    const upgraded = await scryptHasher.hash(password);
    await repo.updatePasswordHash(user.id, upgraded, 'scrypt', { touchChangedAt: false });
    log.info({ userId: user.id }, 'password hash upgraded to current parameters');
  }

  await repo.recordSuccessfulLogin(user.id);

  const permissions = await repo.findPermissionCodesByRoleId(user.roleId);
  const actor = toActor(user, permissions);

  const accessToken = issueAccessToken({
    userId: actor.userId,
    staffCode: actor.staffCode,
    branchId: actor.branchId,
    roleCode: actor.roleCode,
    passwordChangedAt: actor.passwordChangedAt,
  });

  const refreshToken = await refreshTokens.issueForNewSession(actor.userId, context);

  log.info({ userId: actor.userId, roleCode: actor.roleCode }, 'login succeeded');

  return { accessToken, refreshToken, actor, mustChangePassword: user.mustChangePassword };
};

/**
 * Rebuild the actor from a verified token, for the authenticate middleware.
 *
 * The token is trusted for identity, but the user's CURRENT status and
 * permissions are read fresh. That is what makes a disabled account or a
 * revoked permission take effect immediately rather than at token expiry.
 */
export const resolveActor = async (userId: string): Promise<Actor> => {
  const user = await repo.findUserById(userId);

  if (!user) throw new UnauthorizedError('Session is no longer valid', { reason: 'user_missing' });
  if (user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Session is no longer valid', { reason: 'user_inactive' });
  }

  const permissions = await repo.findPermissionCodesByRoleId(user.roleId);
  return toActor(user, permissions);
};

export interface RefreshResult {
  accessToken: IssuedToken;
  refreshToken: refreshTokens.IssuedRefreshToken;
  actor: Actor;
}

/**
 * Exchange a refresh token for a new access token and a new refresh token.
 *
 * The user's current state is re-read here rather than carried over from
 * login. A user disabled, locked or moved to another branch an hour ago must
 * not be able to refresh their way into another 15 minutes of access.
 */
export const refresh = async (
  presentedToken: string,
  context: RefreshContext = {},
): Promise<RefreshResult> => {
  const rotation = await refreshTokens.rotate(presentedToken, context);

  // Throws if the user is gone or no longer ACTIVE.
  const actor = await resolveActor(rotation.userId);

  const accessToken = issueAccessToken({
    userId: actor.userId,
    staffCode: actor.staffCode,
    branchId: actor.branchId,
    roleCode: actor.roleCode,
    passwordChangedAt: actor.passwordChangedAt,
  });

  log.info({ userId: actor.userId }, 'access token refreshed');

  return { accessToken, refreshToken: rotation.refresh, actor };
};

/** Logout. Idempotent: an unknown or already-revoked token is not an error. */
export const logout = async (presentedToken: string | undefined): Promise<void> => {
  if (!presentedToken) return;
  await refreshTokens.revokeSession(presentedToken);
};

export const logoutAll = async (userId: string): Promise<number> =>
  refreshTokens.revokeAllForUser(userId, 'LOGOUT_ALL' satisfies RevokeReason);

export const listSessions = async (
  userId: string,
  currentToken?: string,
): Promise<SessionView[]> => refreshTokens.listSessions(userId, currentToken);

/**
 * Change password.
 *
 * Three things must happen together, and skipping any one of them is a common
 * real-world bug:
 *
 *   1. verify the CURRENT password -- otherwise a stolen access token is
 *      enough to take the account over permanently;
 *   2. stamp `passwordChangedAt` -- which invalidates every outstanding
 *      ACCESS token through the `iat` comparison in authenticate.ts;
 *   3. revoke every refresh family -- which invalidates every other session.
 *
 * The user is then signed out everywhere, including on this device. That is
 * intentional: if the reason for the change was "I think someone has my
 * password", leaving the attacker's session alive defeats the whole exercise.
 */
export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> => {
  const user = await repo.findUserById(userId);
  if (!user) throw new NotFoundError('User', userId);

  const currentMatches = await scryptHasher.verify(currentPassword, user.passwordHash);
  if (!currentMatches) {
    log.warn({ userId }, 'password change rejected: current password incorrect');
    throw new UnauthorizedError('Current password is incorrect');
  }

  if (await scryptHasher.verify(newPassword, user.passwordHash)) {
    throw new BusinessRuleError(
      'PASSWORD_UNCHANGED',
      'The new password must be different from the current one.',
    );
  }

  assertPasswordAcceptable(newPassword, {
    staffCode: user.staffCode,
    displayName: user.displayName,
    email: user.email,
  });

  const hash = await scryptHasher.hash(newPassword);
  await repo.updatePasswordHash(userId, hash, 'scrypt', { touchChangedAt: true });

  const revoked = await refreshTokens.revokeAllForUser(
    userId,
    'PASSWORD_CHANGED' satisfies RevokeReason,
  );

  log.info({ userId, sessionsRevoked: revoked }, 'password changed, all sessions invalidated');
};

export interface UserSummary {
  id: string;
  staffCode: string;
  displayName: string;
  email: string | null;
  status: UserStatus;
  roleCode: string;
  branchCode: number;
  branchName: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const toUserSummary = (user: repo.UserWithRoleAndBranch): UserSummary => ({
  id: user.id,
  staffCode: user.staffCode,
  displayName: user.displayName,
  email: user.email,
  status: user.status,
  roleCode: user.role.code,
  branchCode: user.homeBranch.code,
  branchName: user.homeBranch.name,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt,
});

export const listUsers = async (params: {
  limit: number;
  cursor?: string;
  branchId?: string;
  status?: UserStatus;
}): Promise<Page<UserSummary>> => {
  const rows = await repo.listUsers(params);
  return buildPage(rows.map(toUserSummary), params.limit);
};

export const getUser = async (id: string): Promise<UserSummary> => {
  const user = await repo.findUserById(id);
  if (!user) throw new NotFoundError('User', id);
  return toUserSummary(user);
};
