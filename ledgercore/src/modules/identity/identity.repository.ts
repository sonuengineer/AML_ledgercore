import { Prisma, type User, type UserStatus } from '@prisma/client';
import { prisma, translateDbError, type TxClient } from '../../shared/db/prisma';
import { decodeCursor } from '../../shared/http/pagination';
import { cached, cacheKeys, invalidate, invalidatePrefix } from '../../shared/cache/cacheAside';

/**
 * Data access for identity.
 *
 * Rules that hold for every repository in this codebase:
 *  - All SQL lives here. Services contain no query, controllers no data access.
 *  - Every method takes `db: TxClient = prisma`, so the same call works inside
 *    a transaction and outside one. Phase 5 needs this.
 *  - Prisma errors are translated at this boundary. Nothing above imports
 *    Prisma error codes.
 */

export type UserWithRoleAndBranch = Prisma.UserGetPayload<{
  include: { role: true; homeBranch: true };
}>;

export const findUserByStaffCode = async (
  staffCode: string,
  db: TxClient = prisma,
): Promise<UserWithRoleAndBranch | null> =>
  db.user.findUnique({
    where: { staffCode },
    include: { role: true, homeBranch: true },
  });

/**
 * JSON has no Date, so a cache hit returns ISO STRINGS where the type says
 * Date -- and `cached<T>` casts with `as T`, so the compiler happily agrees
 * with a lie. Every date has to be put back by hand.
 *
 * This is not hypothetical here. `authenticate.ts` compares the token's `pwd`
 * claim against `passwordChangedAt.getTime()` -- the Phase 4 fix that stops a
 * stale access token surviving a password change. On a cache hit without this
 * function, `passwordChangedAt` is a string, `.getTime` is undefined, and that
 * check throws. The same trap was already handled for the business date in
 * Phase 6; this is the same discipline applied to a security-critical field.
 */
const reviveUserDates = (row: UserWithRoleAndBranch): UserWithRoleAndBranch => ({
  ...row,
  passwordChangedAt: new Date(row.passwordChangedAt),
  lockedUntil: row.lockedUntil ? new Date(row.lockedUntil) : null,
  lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt) : null,
  createdAt: new Date(row.createdAt),
  updatedAt: new Date(row.updatedAt),
  role: {
    ...row.role,
    createdAt: new Date(row.role.createdAt),
    updatedAt: new Date(row.role.updatedAt),
  },
  homeBranch: {
    ...row.homeBranch,
    openedOn: new Date(row.homeBranch.openedOn),
    createdAt: new Date(row.homeBranch.createdAt),
    updatedAt: new Date(row.homeBranch.updatedAt),
  },
});

/**
 * Cached, with a DELIBERATELY SHORT ttl.
 *
 * WHY AT ALL: this runs on every authenticated request. The Phase 14 profile,
 * after the JWT fix, put @prisma/client at 14.6% of CPU and this was almost
 * all of it -- one round trip through the Rust query engine, for a row that
 * changes perhaps twice a day.
 *
 * WHY 10 SECONDS AND NOT THE 300s DEFAULT: the value being cached is the
 * user's CURRENT security state -- status, lock, role, passwordChangedAt.
 * Phase 4 chose to re-read it per request precisely so that disabling an
 * account takes effect immediately rather than at token expiry. Caching it
 * weakens that, so the window is made small enough to stay operationally
 * equivalent: "we disabled them and it took under ten seconds" is a different
 * sentence from "it took up to fifteen minutes".
 *
 * WHY THE WINDOW IS SMALLER THAN 10s IN PRACTICE: every write path in this
 * file calls `invalidateUser`, so an in-application change is visible at once.
 * The 10 seconds only ever applies to a change made OUTSIDE the application --
 * a DBA running UPDATE by hand, or a replica lag.
 *
 * The permission cache (5 minutes, keyed by role) already made this exact
 * trade in Phase 6. This is the same pattern with a tighter bound, because the
 * data is more dangerous.
 */
export const findUserById = async (
  id: string,
  db: TxClient = prisma,
): Promise<UserWithRoleAndBranch | null> => {
  const row = await cached(
    cacheKeys.user(id),
    async () =>
      db.user.findUnique({
        where: { id },
        include: { role: true, homeBranch: true },
      }),
    { ttlSeconds: 10 },
  );
  return row ? reviveUserDates(row) : null;
};

/**
 * Call after ANY write that changes a user row.
 *
 * The dangerous one is `recordFailedLogin`, which flips status to LOCKED.
 * Without this, a locked-out account would keep passing `authenticate` until
 * the entry expired -- the account lockout would be advisory for ten seconds.
 */
export const invalidateUser = async (userId: string): Promise<void> =>
  invalidate(cacheKeys.user(userId));

/**
 * Resolve the permission codes a user holds, via their role.
 *
 * This runs on EVERY authenticated request -- `authenticate` rebuilds the actor
 * fresh each time so that a disabled account or a revoked permission takes
 * effect immediately rather than at token expiry.
 *
 * Phases 3 to 5 left it as a plain database round trip on purpose, so the cost
 * stayed visible and Phase 6 could measure the improvement rather than assert
 * it. It is now cache-aside with a 5-minute TTL.
 *
 * The staleness this introduces is bounded and explicitly accepted: revoking a
 * permission takes effect within the TTL, or immediately if the write path
 * calls `invalidateRolePermissions`. That window is far smaller than putting
 * permissions in the JWT would give -- up to the whole token lifetime, with no
 * way to shorten it -- which is the option Phase 4 rejected for this reason.
 */
export const findPermissionCodesByRoleId = async (
  roleId: string,
  db: TxClient = prisma,
): Promise<string[]> =>
  cached(cacheKeys.rolePermissions(roleId), async () => {
    const rows = await db.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((row) => row.permission.code);
  });

/**
 * Call this whenever a role's grants change.
 *
 * Invalidating one role invalidates it for every user who holds it, which the
 * key structure gives for free: the cache is keyed by ROLE, not by user.
 * Keying by user would have needed a reverse index that itself needed
 * invalidating -- a second cache to keep consistent with the first.
 */
export const invalidateRolePermissions = async (roleId?: string): Promise<void> => {
  if (roleId) await invalidate(cacheKeys.rolePermissions(roleId));
  else await invalidatePrefix(cacheKeys.rolePermissionsPrefix);
};

/**
 * Keyset page of users. Note `take: limit + 1` -- the extra row tells the
 * caller whether a next page exists without a COUNT(*).
 */
export const listUsers = async (
  params: { limit: number; cursor?: string; branchId?: string; status?: UserStatus },
  db: TxClient = prisma,
): Promise<UserWithRoleAndBranch[]> => {
  const cursor = decodeCursor(params.cursor);

  const where: Prisma.UserWhereInput = {
    ...(params.branchId ? { homeBranchId: params.branchId } : {}),
    ...(params.status ? { status: params.status } : {}),
    // Walks the (created_at, id) index. Strictly-after semantics on the
    // composite key, which is what makes the page boundary exact even when
    // several users share a created_at.
    ...(cursor
      ? {
          OR: [
            { createdAt: { gt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { gt: cursor.id } },
          ],
        }
      : {}),
  };

  return db.user.findMany({
    where,
    include: { role: true, homeBranch: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: params.limit + 1,
  });
};

/**
 * Replace the stored hash.
 *
 * `touchChangedAt` is the important flag. A deliberate password CHANGE must
 * stamp `password_changed_at`, because that timestamp is what invalidates
 * every outstanding access token (see authenticate.ts). A transparent hash
 * UPGRADE at login must not -- the credential did not change, and stamping it
 * would sign the user out of their other devices for no reason.
 */
export const updatePasswordHash = async (
  userId: string,
  passwordHash: string,
  passwordAlgo: string,
  options: { touchChangedAt: boolean },
  db: TxClient = prisma,
): Promise<void> => {
  try {
    await db.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordAlgo,
        ...(options.touchChangedAt
          ? { passwordChangedAt: new Date(), mustChangePassword: false }
          : {}),
      },
    });
    await invalidateUser(userId);
  } catch (error) {
    translateDbError(error, 'User');
  }
};

/** Records a successful login. Resets the failed-login counter. */
export const recordSuccessfulLogin = async (userId: string, db: TxClient = prisma): Promise<void> => {
  try {
    await db.user.update({
      where: { id: userId },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
    await invalidateUser(userId);
  } catch (error) {
    translateDbError(error, 'User');
  }
};

/**
 * Increments the failed-login counter and locks the account when the threshold
 * is crossed. Mirrors the legacy D002001 policy fields (MaxBadLiPerDay,
 * NoOfBadLogins), which were present in the schema but not enforced anywhere.
 *
 * The increment is a single atomic UPDATE rather than read-modify-write, so
 * concurrent failed attempts cannot lose counts.
 */
export const recordFailedLogin = async (
  userId: string,
  threshold: number,
  lockForMs: number,
  db: TxClient = prisma,
): Promise<void> => {
  await db.$executeRaw`
    UPDATE "user"
       SET failed_login_count = failed_login_count + 1,
           locked_until = CASE
             WHEN failed_login_count + 1 >= ${threshold}
             THEN now() + ${`${lockForMs} milliseconds`}::interval
             ELSE locked_until
           END,
           status = CASE
             WHEN failed_login_count + 1 >= ${threshold} THEN 'LOCKED'::user_status
             ELSE status
           END,
           updated_at = now()
     WHERE id = ${userId}::uuid
  `;
  // NOT optional: this statement can set status = 'LOCKED'. Without the
  // invalidation an account lockout would be advisory until the entry
  // expired -- which defeats the lockout.
  await invalidateUser(userId);
};

export type { User, UserStatus };
