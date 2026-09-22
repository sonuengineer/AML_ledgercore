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

export const findUserById = async (
  id: string,
  db: TxClient = prisma,
): Promise<UserWithRoleAndBranch | null> =>
  db.user.findUnique({
    where: { id },
    include: { role: true, homeBranch: true },
  });

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
};

export type { User, UserStatus };
