import type { Branch, BusinessDate } from '@prisma/client';
import { prisma, type TxClient } from '../../shared/db/prisma';
import { cached, cacheKeys, invalidate } from '../../shared/cache/cacheAside';

/** Data access for the organisation module. All SQL for branches and business dates. */

/**
 * Branch master. Read on every posting, changed when a branch opens or is
 * suspended -- so, effectively never. A long TTL is safe.
 *
 * `Date` fields do not survive JSON, so the cached copy is revived back into
 * Dates on the way out. Skipping that is a classic cache bug: the uncached
 * path returns a Date and the cached path returns a string, and the difference
 * only shows up after the first request warms the key.
 */
export const findBranchById = async (
  id: string,
  db: TxClient = prisma,
): Promise<Branch | null> => {
  const row = await cached(
    cacheKeys.branch(id),
    async () => db.branch.findUnique({ where: { id } }),
    { ttlSeconds: 900 },
  );
  if (!row) return null;
  return {
    ...row,
    openedOn: new Date(row.openedOn),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
};

export const invalidateBranch = async (id: string): Promise<void> =>
  invalidate(cacheKeys.branch(id));

export const listBranches = async (
  params: { bankId?: string },
  db: TxClient = prisma,
): Promise<Branch[]> =>
  db.branch.findMany({
    where: params.bankId ? { bankId: params.bankId } : {},
    orderBy: { code: 'asc' },
  });

/**
 * The branch's current business date.
 *
 * "Current" means the OPEN one, not today's calendar date. A branch that has
 * not run day-begin is still on yesterday, and a branch mid-day-end is CLOSING
 * and accepts no postings. Reading `new Date()` instead of this row is the bug
 * this table exists to prevent.
 */
export const findCurrentBusinessDate = async (
  branchId: string,
  db: TxClient = prisma,
): Promise<BusinessDate | null> => {
  /**
   * SHORT ttl on purpose -- 60 seconds, not the 5-minute default.
   *
   * This is the one cached value where staleness has teeth. The business date
   * decides which date a voucher is stamped with, and it changes exactly when
   * day-begin or day-end runs. A stale entry here would let a teller post into
   * a day that has just closed.
   *
   * 60 seconds bounds that, and `invalidateBusinessDate` on the day-begin and
   * day-end paths (Phase 7) closes it entirely. The TTL is the backstop for
   * the case where that call is missed or Redis was briefly down.
   *
   * It is still not trusted blindly: `assertPostingAllowed` re-reads the
   * status, and the posting transaction itself takes the row locks that decide
   * the outcome.
   */
  const row = await cached(
    cacheKeys.businessDate(branchId),
    async () =>
      db.businessDate.findFirst({
        where: { branchId, status: { in: ['OPEN', 'CLOSING'] } },
        orderBy: { workingDate: 'desc' },
      }),
    { ttlSeconds: 60 },
  );
  if (!row) return null;
  return {
    ...row,
    workingDate: new Date(row.workingDate),
    openedAt: row.openedAt ? new Date(row.openedAt) : null,
    closedAt: row.closedAt ? new Date(row.closedAt) : null,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
};

/** Must be called by day-begin and day-end. */
export const invalidateBusinessDate = async (branchId: string): Promise<void> =>
  invalidate(cacheKeys.businessDate(branchId));

export const findBusinessDate = async (
  branchId: string,
  workingDate: Date,
  db: TxClient = prisma,
): Promise<BusinessDate | null> =>
  db.businessDate.findUnique({
    where: { branchId_workingDate: { branchId, workingDate } },
  });

export type { Branch, BusinessDate };
