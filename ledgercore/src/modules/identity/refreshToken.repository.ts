import type { RefreshToken, RevokeReason } from '@prisma/client';
import { prisma, type TxClient } from '../../shared/db/prisma';

/**
 * All SQL for refresh tokens.
 *
 * Two of these use raw SQL rather than Prisma's query API, for reasons that
 * are worth stating rather than hiding:
 *
 *  - `findByHashForUpdate` needs `SELECT ... FOR UPDATE`, which Prisma does
 *    not express. Without the row lock, two concurrent refreshes of the same
 *    token can both pass the `usedAt IS NULL` check and both mint a successor,
 *    forking the family -- the exact state reuse detection exists to prevent.
 *
 *  - `revokeFamily` and `revokeAllForUser` are set-based updates whose row
 *    count is the useful result. One statement beats a read-then-write loop
 *    and cannot race.
 *
 * This is the split the Phase 2 ORM decision predicted: Prisma for the
 * ordinary 90%, raw SQL exactly where locking and set operations live.
 */

export interface InsertTokenInput {
  familyId: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdByIp?: string | undefined;
  userAgent?: string | undefined;
}

export const insertToken = async (
  input: InsertTokenInput,
  db: TxClient = prisma,
): Promise<RefreshToken> =>
  db.refreshToken.create({
    data: {
      familyId: input.familyId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdByIp: input.createdByIp ?? null,
      // Bounded: it lands in a VarChar(255) and in logs.
      userAgent: input.userAgent?.slice(0, 255) ?? null,
    },
  });

export const findByHash = async (
  tokenHash: string,
  db: TxClient = prisma,
): Promise<RefreshToken | null> => db.refreshToken.findUnique({ where: { tokenHash } });

export interface LockedToken {
  id: string;
  familyId: string;
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
  replacedById: string | null;
  /** Expiry of the FIRST token in this family -- the absolute session ceiling. */
  familyExpiresAt: Date;
}

/**
 * Fetch the token row under a row lock, together with the family's absolute
 * expiry (the first token's `expires_at`).
 *
 * `FOR UPDATE OF rt` locks only the refresh_token row, not the joined
 * aggregate -- locking an aggregate is not even legal, and we do not want to
 * lock anything we are merely reading.
 */
export const findByHashForUpdate = async (
  tokenHash: string,
  db: TxClient,
): Promise<LockedToken | null> => {
  const rows = await db.$queryRaw<LockedToken[]>`
    SELECT rt.id,
           rt.family_id        AS "familyId",
           rt.user_id          AS "userId",
           rt.issued_at        AS "issuedAt",
           rt.expires_at       AS "expiresAt",
           rt.used_at          AS "usedAt",
           rt.revoked_at       AS "revokedAt",
           rt.revoked_reason   AS "revokedReason",
           rt.replaced_by_id   AS "replacedById",
           (SELECT MIN(f.expires_at)
              FROM refresh_token f
             WHERE f.family_id = rt.family_id) AS "familyExpiresAt"
      FROM refresh_token rt
     WHERE rt.token_hash = ${tokenHash}
       FOR UPDATE OF rt
  `;
  return rows[0] ?? null;
};

/** Mark a token exchanged and point it at its successor. */
export const markRotated = async (
  id: string,
  successorId: string,
  db: TxClient = prisma,
): Promise<void> => {
  await db.refreshToken.update({
    where: { id },
    data: {
      usedAt: new Date(),
      replacedById: successorId,
      revokedAt: new Date(),
      revokedReason: 'ROTATED',
    },
  });
};

/**
 * Revoke every still-live token in a family. Returns how many were affected,
 * which is what gets logged during a reuse incident.
 */
export const revokeFamily = async (
  familyId: string,
  reason: RevokeReason,
  db: TxClient = prisma,
): Promise<number> => {
  const result = await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
};

export const revokeAllForUser = async (
  userId: string,
  reason: RevokeReason,
  db: TxClient = prisma,
): Promise<number> => {
  const result = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
};

export interface FamilySummary {
  familyId: string;
  issuedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * One row per live session. Grouped by family, because a family IS the
 * session -- showing the user one row per rotated token would be nonsense.
 */
export const listActiveFamilies = async (
  userId: string,
  db: TxClient = prisma,
): Promise<FamilySummary[]> =>
  db.$queryRaw<FamilySummary[]>`
    SELECT family_id            AS "familyId",
           MIN(issued_at)       AS "issuedAt",
           MAX(expires_at)      AS "expiresAt",
           MAX(used_at)         AS "lastUsedAt",
           (ARRAY_AGG(created_by_ip ORDER BY issued_at DESC))[1] AS "ip",
           (ARRAY_AGG(user_agent   ORDER BY issued_at DESC))[1] AS "userAgent"
      FROM refresh_token
     WHERE user_id = ${userId}::uuid
     GROUP BY family_id
    HAVING BOOL_OR(revoked_at IS NULL AND expires_at > now())
     ORDER BY MIN(issued_at) DESC
  `;

/**
 * Delete rows that expired before `cutoff`.
 *
 * Deleting rather than keeping forever is a deliberate trade-off: the audit
 * trail of who logged in when belongs in `audit_event` (Phase 5), not in a
 * table on the authentication hot path that would grow without bound.
 */
export const deleteExpiredBefore = async (cutoff: Date, db: TxClient = prisma): Promise<number> => {
  const result = await db.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
};
