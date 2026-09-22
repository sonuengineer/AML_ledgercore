import { createSecretKey } from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { config } from '../../config';
import { UnauthorizedError } from '../../shared/errors/AppError';

/**
 * The signing secret as a KeyObject, built ONCE at module load.
 *
 * This is a four-line change that removed a quarter of the API's CPU, and the
 * only way it was ever going to be found is a profiler.
 *
 * Phase 14 CPU profile of a node under load, by self time:
 *
 *   (idle)                                   26.8%
 *   createPublicKey [node:internal/crypto]   25.5%   <- here
 *   @prisma/client                            7.7%
 *   express                                   4.1%
 *
 * `createPublicKey` has no business running on an HS256 path at all. HS256 is
 * a symmetric HMAC; there is no public key anywhere in this system.
 *
 * It comes from jsonwebtoken 9's key handling (verify.js:120):
 *
 *   if (secretOrPublicKey != null && !(secretOrPublicKey instanceof KeyObject)) {
 *     try {
 *       secretOrPublicKey = createPublicKey(secretOrPublicKey);   // line 122
 *     } catch (_) {
 *       secretOrPublicKey = createSecretKey(...);                 // line 125
 *     }
 *   }
 *
 * Pass a STRING and every single verify attempts to parse that string as a
 * PEM/DER public key, fails, THROWS, and only then falls back to the symmetric
 * path that was correct all along. An exception constructed and unwound on
 * every authenticated request, plus a full key-parse attempt, purely to
 * discover something the code already knew.
 *
 * Pass a KeyObject and `instanceof KeyObject` short-circuits the whole block.
 *
 * The wider lesson: this cost nothing to write and was invisible in every
 * metric we had. `http_request_duration` said 114ms, `db_query_duration` said
 * 106ms of it was "the database", and Postgres itself executed the query in
 * 0.385ms. Aggregate metrics tell you WHERE time is spent by layer. Only a
 * profiler tells you what the CPU is actually doing.
 */
const jwtKey = createSecretKey(Buffer.from(config.auth.jwtSecret, 'utf8'));

/**
 * Access token issuing and verification.
 *
 * This is the direct answer to the worst defect found in Phase 0: the legacy
 * `JwtUtil.GenerateJSONWebToken` produced a token with NO claims at all --
 * no subject, no branch, no role. The token proved only that somebody, at some
 * point, hit the login endpoint. Identity then had to travel in the request
 * body, which means the server trusted the client for who it was.
 *
 * Here the token is the sole source of identity. Nothing downstream reads a
 * user id, branch or role from a payload.
 *
 * Phase 4 adds: refresh token rotation, a token family with reuse detection,
 * and revocation on logout. Phase 3 issues access tokens only.
 */

export interface AccessTokenClaims {
  /** Standard `sub`: the user's UUID. */
  sub: string;
  /** Staff code (legacy UsrCode1). Present for log readability, not for authz. */
  sc: string;
  /** The branch the user is operating in for this session. */
  br: string;
  /** Role code. Permissions are resolved server-side, not carried in the token. */
  rl: string;
  /** Token type, so a refresh token can never be presented as an access token. */
  typ: 'access';
  /**
   * Credential version: the user's `passwordChangedAt` in epoch milliseconds
   * at the moment this token was minted.
   *
   * This is how an outstanding access token is invalidated after a password
   * change WITHOUT a denylist. `authenticate` compares this against the user's
   * current value and refuses on any mismatch.
   *
   * Why not compare the standard `iat` claim against `passwordChangedAt`
   * instead? I tried that first and an integration test failed. `iat` is
   * whole SECONDS, while `passwordChangedAt` has sub-second precision, so a
   * token minted at 12:29:41.500 and a password changed at 12:29:41.900 are
   * indistinguishable -- the stale token survived. Adding slack to absorb the
   * truncation just moved the hole. An exact equality on an explicit claim has
   * no edge case at all.
   */
  pwd: number;
  /** Issued-at, seconds. Standard claim, kept for observability. */
  iat: number;
}

export interface IssueAccessTokenInput {
  userId: string;
  staffCode: string;
  branchId: string;
  roleCode: string;
  /** The user's current passwordChangedAt. Becomes the `pwd` claim. */
  passwordChangedAt: Date;
}

export interface IssuedToken {
  token: string;
  expiresInSeconds: number;
  expiresAt: Date;
}

/**
 * Why permissions are NOT in the token:
 *
 * A JWT cannot be un-issued. If permissions are baked in, revoking a teller's
 * authorise right takes effect only when their token expires -- up to 15
 * minutes of a user holding a privilege an officer already removed. For a
 * banking system that window is not acceptable, so permissions are resolved
 * per request from the database (Phase 3) and from Redis (Phase 6).
 *
 * The trade-off is an extra lookup per request. That is a measurable cost with
 * a known fix, which is preferable to an unmeasurable security hole.
 */
export const issueAccessToken = (input: IssueAccessTokenInput): IssuedToken => {
  const claims: Omit<AccessTokenClaims, 'iat'> = {
    sub: input.userId,
    sc: input.staffCode,
    br: input.branchId,
    rl: input.roleCode,
    typ: 'access',
    pwd: input.passwordChangedAt.getTime(),
  };

  const options: SignOptions = {
    algorithm: 'HS256',
    expiresIn: config.auth.accessTokenTtlSeconds,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
  };

  const token = jwt.sign(claims, jwtKey, options);

  return {
    token,
    expiresInSeconds: config.auth.accessTokenTtlSeconds,
    expiresAt: new Date(Date.now() + config.auth.accessTokenTtlSeconds * 1000),
  };
};

export const verifyAccessToken = (token: string): AccessTokenClaims => {
  let payload: string | JwtPayload;

  try {
    payload = jwt.verify(token, jwtKey, {
      // Pinning the algorithm is not optional. Without it, a token signed with
      // `alg: none` (or an RS256/HS256 confusion) can be accepted.
      algorithms: ['HS256'],
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Access token expired', { reason: 'expired' });
    }
    throw new UnauthorizedError('Invalid access token', { reason: 'invalid' });
  }

  if (typeof payload === 'string' || payload.typ !== 'access') {
    throw new UnauthorizedError('Invalid access token', { reason: 'wrong_type' });
  }

  const { sub, sc, br, rl, iat, pwd } = payload as JwtPayload & Partial<AccessTokenClaims>;
  if (!sub || !sc || !br || !rl || typeof iat !== 'number' || typeof pwd !== 'number') {
    throw new UnauthorizedError('Invalid access token', { reason: 'missing_claims' });
  }

  return { sub, sc, br, rl, typ: 'access', iat, pwd };
};
