import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RevokeReason } from '@prisma/client';
import { config } from '../../config';
import { UnauthorizedError } from '../../shared/errors/AppError';
import { moduleLogger } from '../../shared/logging/logger';
import { transaction } from '../../shared/db/prisma';
import * as repo from './refreshToken.repository';

const log = moduleLogger('refresh-token');

/**
 * Refresh tokens: rotation, reuse detection, revocation.
 *
 * Phase 0 found that the legacy "refresh token" was just a second JWT signed
 * with the same secret and a longer expiry. No store, no id, no revocation.
 * Logout was `window.location.reload()` on the client -- nothing server-side
 * was invalidated. A stolen refresh token was valid until it expired and there
 * was no way to know it had been stolen, let alone stop it.
 *
 * ---------------------------------------------------------------------------
 * The design
 * ---------------------------------------------------------------------------
 *
 * A refresh token here is NOT a JWT. It is 32 bytes of CSPRNG output. It
 * carries no claims, because claims in a refresh token are a liability: they
 * go stale, and the only thing this token needs to do is identify a database
 * row.
 *
 *   Problem   A long-lived credential must survive an access token expiring,
 *             without becoming a permanent skeleton key if it leaks.
 *   Options   (a) long-lived access token, no refresh -- huge exposure window
 *             (b) opaque refresh token, no rotation -- one leak lasts 30 days
 *             (c) rotation with reuse detection -- a leak is detectable
 *   Chosen    (c)
 *   Why       Rotation means each token is single-use. If an attacker steals
 *             one and uses it, the legitimate client's next refresh presents
 *             an already-used token -- and that is a signal no other scheme
 *             gives you. We burn the whole family and force re-login.
 *   Trade-off A lost race (two tabs refreshing at once, or a dropped response
 *             on a flaky connection) looks identical to theft and logs the
 *             user out. That false positive is accepted deliberately: for a
 *             banking back-office, an unnecessary re-login is cheaper than a
 *             missed session hijack. The grace window below softens the most
 *             common benign case without reopening the hole.
 *
 * Family: every token descended from one login shares a `familyId`. Reuse
 * detection revokes the FAMILY, not just the presented token -- otherwise the
 * attacker's freshly rotated token would survive.
 *
 * Storage: only SHA-256 of the token. A database leak yields hashes, not
 * sessions. A fast hash is correct here -- the input is 256 bits of entropy,
 * so there is nothing for a slow KDF to protect against. Passwords are the
 * opposite case and use scrypt (see password.service.ts).
 */

/**
 * Rotation here is STRICT: a token is single-use, full stop. There is no grace
 * window in which a replay is forgiven.
 *
 * I built a grace window first and removed it, because every version of it
 * forks the family. Re-issuing the successor is impossible (its plaintext was
 * never stored), and minting a second token leaves two live chains from one
 * login -- which is exactly the state reuse detection exists to prevent. A
 * window that reintroduces the hole it is meant to soften is not a trade-off,
 * it is a bug with a comment.
 *
 * The cost is real: two tabs refreshing simultaneously, or a response lost in
 * flight and retried, look identical to theft and log the user out. The fix
 * belongs on the client -- refreshes must be single-flight, one in-flight
 * request shared by every waiting caller. That is a five-line mutex in the API
 * client, and it is where the problem actually is.
 *
 * For a banking back-office the asymmetry is clear anyway: an unnecessary
 * re-login costs a user fifteen seconds; a missed session hijack costs a lot
 * more than that.
 */

const TOKEN_BYTES = 32;

export interface IssuedRefreshToken {
  /** The plaintext. Returned once, to the client. Never stored, never logged. */
  token: string;
  familyId: string;
  expiresAt: Date;
}

export interface RefreshContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** SHA-256 hex. The lookup key, and all we ever persist. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const generateToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

const expiryFromNow = (): Date =>
  new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000);

/** Starts a new family. Called on successful password login only. */
export const issueForNewSession = async (
  userId: string,
  context: RefreshContext,
): Promise<IssuedRefreshToken> => {
  const token = generateToken();
  const familyId = randomUUID();
  const expiresAt = expiryFromNow();

  await repo.insertToken({
    familyId,
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    createdByIp: context.ip,
    userAgent: context.userAgent,
  });

  log.info({ userId, familyId }, 'refresh token family opened');
  return { token, familyId, expiresAt };
};

export interface RotationResult {
  userId: string;
  refresh: IssuedRefreshToken;
}

/**
 * Outcome of the rotation transaction.
 *
 * Rejections are RETURNED, not thrown.
 *
 * This is not stylistic. Throwing out of `prisma.$transaction` rolls the
 * transaction back -- so a `throw` on the reuse path would have undone the
 * very family revocation that the reuse path exists to perform. The attacker
 * would get a 401 and keep a working session. An integration test caught this:
 * after "detecting" reuse, the legitimate successor still refreshed fine.
 *
 * So the transaction commits its decision, and the caller turns a rejection
 * into an error afterwards.
 */
type RotationOutcome =
  | { kind: 'ok'; userId: string; refresh: IssuedRefreshToken }
  | { kind: 'reject'; reason: string };

/**
 * Exchange a refresh token for its successor.
 *
 * The row is locked FOR UPDATE, because two concurrent refreshes of the same
 * token must not both pass the `usedAt IS NULL` check and both mint a
 * successor. Without the lock, a race forks the family.
 */
export const rotate = async (presented: string, context: RefreshContext): Promise<RotationResult> => {
  const presentedHash = hashToken(presented);

  const outcome = await transaction<RotationOutcome>(async (tx) => {
    const existing = await repo.findByHashForUpdate(presentedHash, tx);

    // Unknown token. Either forged, or from a family the cleanup job already
    // deleted. Nothing to revoke, nothing to learn.
    if (!existing) {
      log.warn('refresh rejected: unknown token');
      return { kind: 'reject', reason: 'unknown_token' };
    }

    // ---- reuse detection -------------------------------------------------
    // `usedAt` is checked BEFORE `revokedAt`, because a rotated token is both
    // used and revoked, and the interesting fact is that it was replayed.
    if (existing.usedAt) {
      const revoked = await repo.revokeFamily(
        existing.familyId,
        'REUSE_DETECTED' satisfies RevokeReason,
        tx,
      );
      // Logged at error, not warn: this is the signal that a token leaked.
      // It should page someone, and in Phase 9 it becomes a metric.
      log.error(
        {
          userId: existing.userId,
          familyId: existing.familyId,
          tokensRevoked: revoked,
          usedAt: existing.usedAt,
        },
        'REFRESH TOKEN REUSE DETECTED -- family revoked, every session in it killed',
      );
      return { kind: 'reject', reason: 'reuse_detected' };
    }

    if (existing.revokedAt) {
      log.warn(
        { userId: existing.userId, familyId: existing.familyId, reason: existing.revokedReason },
        'refresh rejected: token already revoked',
      );
      return { kind: 'reject', reason: 'revoked' };
    }

    if (existing.expiresAt <= new Date()) {
      log.info({ userId: existing.userId, familyId: existing.familyId }, 'refresh rejected: expired');
      return { kind: 'reject', reason: 'expired' };
    }

    // ---- rotate ----------------------------------------------------------
    const token = generateToken();

    // Absolute session lifetime: a successor never outlives the family's
    // original expiry. Without this the "7 day" limit would mean nothing --
    // anyone refreshing regularly (including an attacker) would hold the
    // session forever.
    const expiresAt = new Date(
      Math.min(expiryFromNow().getTime(), existing.familyExpiresAt.getTime()),
    );

    const successor = await repo.insertToken(
      {
        familyId: existing.familyId,
        userId: existing.userId,
        tokenHash: hashToken(token),
        expiresAt,
        createdByIp: context.ip,
        userAgent: context.userAgent,
      },
      tx,
    );

    await repo.markRotated(existing.id, successor.id, tx);

    return {
      kind: 'ok',
      userId: existing.userId,
      refresh: { token, familyId: existing.familyId, expiresAt },
    };
  });

  if (outcome.kind === 'reject') {
    // One message for every rejection. Telling a caller which of "unknown",
    // "revoked", "expired" or "reuse detected" applied would help an attacker
    // map the state of a token they hold. The reason goes in `details` for the
    // client's own diagnostics and, more usefully, into the log above.
    throw new UnauthorizedError('Session expired. Sign in again.', { reason: outcome.reason });
  }

  return { userId: outcome.userId, refresh: outcome.refresh };
};

/** Logout: revoke just this session's family. */
export const revokeSession = async (presented: string): Promise<void> => {
  const existing = await repo.findByHash(hashToken(presented));
  if (!existing) return; // Already gone. Logout is idempotent by design.

  const revoked = await repo.revokeFamily(existing.familyId, 'LOGOUT' satisfies RevokeReason);
  log.info({ userId: existing.userId, familyId: existing.familyId, revoked }, 'session revoked');
};

/** Logout everywhere, and the hammer used after a password change. */
export const revokeAllForUser = async (userId: string, reason: RevokeReason): Promise<number> => {
  const revoked = await repo.revokeAllForUser(userId, reason);
  log.info({ userId, reason, revoked }, 'all sessions revoked for user');
  return revoked;
};

export interface SessionView {
  familyId: string;
  issuedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/**
 * The user's active sessions. A banking system should let someone see where
 * they are logged in -- it is how a user notices a session they did not start.
 */
export const listSessions = async (
  userId: string,
  currentToken?: string,
): Promise<SessionView[]> => {
  const currentFamily = currentToken
    ? (await repo.findByHash(hashToken(currentToken)))?.familyId
    : undefined;

  const families = await repo.listActiveFamilies(userId);

  return families.map((family) => ({
    familyId: family.familyId,
    issuedAt: family.issuedAt,
    expiresAt: family.expiresAt,
    lastUsedAt: family.lastUsedAt,
    ip: family.ip,
    userAgent: family.userAgent,
    current: family.familyId === currentFamily,
  }));
};

/** Housekeeping. Becomes a scheduled worker job in Phase 7. */
export const purgeExpired = async (): Promise<number> => repo.deleteExpiredBefore(new Date());
