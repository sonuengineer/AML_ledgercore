import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ConflictError, ValidationError } from '../shared/errors/AppError';
import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { getRequestId } from '../shared/logging/context';
import { requireActor } from './authenticate';
import { safely } from '../shared/cache/redis';
import { cacheKeys } from '../shared/cache/cacheAside';

const log = moduleLogger('idempotency');

/**
 * Idempotency for unsafe requests.
 *
 * The problem: a teller posts a cash withdrawal, the response is lost to a
 * flaky branch link, the client retries, and the customer is debited twice.
 * HTTP retries are a fact of life, so the server has to make the SECOND
 * request harmless.
 *
 * ---------------------------------------------------------------------------
 * ATOMIC CLAIM, not check-then-act
 * ---------------------------------------------------------------------------
 *
 * The first version of this middleware looked for an existing record, found
 * none, let the request proceed, and stored the response afterwards. That is
 * check-then-act, and it only works for SEQUENTIAL retries.
 *
 * A Phase 10 chaos test fired five CONCURRENT requests with the same key --
 * what a flaky link plus an impatient client with connection pooling actually
 * produces -- and got **five vouchers**. All five looked, all five found
 * nothing, all five posted.
 *
 * The fix is the same one the ledger, the AML worker and the audit worker all
 * use: let the database decide. The row is INSERTED FIRST, and the unique
 * constraint on `key` is what serialises the race. Exactly one request wins
 * the insert and does the work; the others lose it and are told so.
 *
 * "Check then act is not idempotency, it is a race with good intentions" --
 * written in Phase 7 about the audit worker, and then not applied here.
 *
 * ---------------------------------------------------------------------------
 * The contract (the Stripe convention, because clients already know it)
 * ---------------------------------------------------------------------------
 *
 *   first request            -> runs, response stored against the key
 *   retry, same body         -> stored response replayed
 *   retry, DIFFERENT body    -> 409. Silently serving the first response hides
 *                               a real client bug; serving the new one defeats
 *                               the key entirely.
 *   concurrent duplicate     -> 409 with Retry-After. The work is in flight;
 *                               retry in a moment and get the replay.
 *   the request FAILED       -> the claim is released, so a retry gets a real
 *                               attempt rather than a replayed 503.
 */

const RETENTION_HOURS = 24;
/** Mirrors into Redis so a sequential retry costs a memory lookup. */
const FAST_PATH_TTL_SECONDS = 3600;

const hashBody = (body: unknown): string =>
  createHash('sha256').update(JSON.stringify(body ?? {}), 'utf8').digest('hex');

const writeFastPath = (
  key: string,
  userId: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown,
): void => {
  void safely(
    async (redis) =>
      redis.set(
        cacheKeys.idempotency(key),
        JSON.stringify({ userId, requestHash, responseStatus, responseBody }),
        'EX',
        FAST_PATH_TTL_SECONDS,
      ),
    'SKIPPED',
    `idem set ${key}`,
  );
};

export interface IdempotencyOptions {
  /** Reject the request if the header is absent. */
  required?: boolean;
}

export const idempotency = (options: IdempotencyOptions = {}): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.headers['idempotency-key'];

      if (typeof key !== 'string' || key.length === 0) {
        if (options.required) {
          throw new ValidationError(
            'This endpoint requires an Idempotency-Key header so a retry cannot post twice.',
            { header: 'Idempotency-Key' },
          );
        }
        next();
        return;
      }

      if (key.length > 80) {
        throw new ValidationError('Idempotency-Key must be at most 80 characters.');
      }

      const actor = requireActor(req);
      const requestHash = hashBody(req.body);

      // ---- fast path -------------------------------------------------------
      //
      // Redis answers a sequential retry without touching Postgres. A MISS
      // proves nothing -- Redis may have evicted the entry or be down -- so a
      // miss always falls through to the durable claim below. The cache can
      // only ever short-circuit a hit; it can never authorise a second posting.
      const fast = await safely(
        async (redis) => redis.get(cacheKeys.idempotency(key)),
        null,
        `idem ${key}`,
      );

      if (fast !== null) {
        try {
          const record = JSON.parse(fast) as {
            userId: string;
            requestHash: string;
            responseStatus: number;
            responseBody: unknown;
          };
          if (record.userId === actor.userId && record.requestHash === requestHash) {
            log.info({ key, source: 'cache' }, 'replaying stored idempotent response');
            res.setHeader('Idempotency-Replayed', 'true');
            res.status(record.responseStatus).json(record.responseBody);
            return;
          }
          throw new ConflictError(
            'This Idempotency-Key was already used with a different request body.',
            { key },
          );
        } catch (error) {
          if (error instanceof ConflictError) throw error;
          log.warn({ key }, 'cached idempotency entry unusable; falling back to database');
        }
      }

      // ---- atomic claim ----------------------------------------------------
      //
      // This INSERT is the whole mechanism. Exactly one concurrent request
      // succeeds; the rest hit the unique constraint.
      let claimed = false;
      try {
        await prisma.idempotencyKey.create({
          data: {
            key,
            userId: actor.userId,
            requestHash,
            expiresAt: new Date(Date.now() + RETENTION_HOURS * 3600 * 1000),
          },
        });
        claimed = true;
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
          throw error;
        }
      }

      if (!claimed) {
        const existing = await prisma.idempotencyKey.findUnique({ where: { key } });

        // Vanished between the failed insert and this read -- the purge job
        // ran, or it expired. Treat it as a fresh request.
        if (!existing) {
          next();
          return;
        }

        // Scoped per user, and per body. Reported as a plain conflict rather
        // than "that key belongs to someone else", which would leak that the
        // key exists.
        if (existing.userId !== actor.userId || existing.requestHash !== requestHash) {
          log.warn(
            { key, sameUser: existing.userId === actor.userId },
            'idempotency key reused with different content',
          );
          throw new ConflictError(
            'This Idempotency-Key was already used with a different request body.',
            { key },
          );
        }

        if (existing.completedAt === null) {
          // Still in flight. Telling the client to retry is correct and
          // honest: the work IS happening, and the result will be replayable
          // in a moment. Serving a 202 with no body would leave them guessing
          // whether the money moved.
          log.info({ key }, 'concurrent request with the same idempotency key');
          res.setHeader('Retry-After', '1');
          throw new ConflictError(
            'A request with this Idempotency-Key is already in progress. Retry shortly.',
            { key, reason: 'in_progress' },
          );
        }

        log.info(
          { key, status: existing.responseStatus, source: 'database' },
          'replaying stored idempotent response',
        );
        writeFastPath(
          key,
          actor.userId,
          requestHash,
          existing.responseStatus!,
          existing.responseBody,
        );
        res.setHeader('Idempotency-Replayed', 'true');
        res.setHeader('X-Request-Id', getRequestId() ?? '');
        res.status(existing.responseStatus!).json(existing.responseBody);
        return;
      }

      // ---- we own the claim: record the outcome ---------------------------
      const originalJson = res.json.bind(res);
      let settled = false;

      res.json = (body: unknown): Response => {
        if (settled) return originalJson(body);
        settled = true;

        if (res.statusCode >= 200 && res.statusCode < 300) {
          writeFastPath(key, actor.userId, requestHash, res.statusCode, body);

          // Fire and forget: the response must not wait on bookkeeping, and a
          // failure here cannot undo a transaction that already committed.
          void prisma.idempotencyKey
            .update({
              where: { key },
              data: {
                responseStatus: res.statusCode,
                responseBody: body as Prisma.InputJsonValue,
                completedAt: new Date(),
              },
            })
            .catch((error: unknown) => {
              log.error({ err: error, key }, 'failed to record idempotent response');
            });
        } else {
          // RELEASE the claim on failure.
          //
          // A failed request SHOULD be retryable with the same key -- if the
          // database was briefly down, the client's retry must get a real
          // attempt, not a replayed 503. Leaving the claim would permanently
          // poison that key.
          void prisma.idempotencyKey
            .delete({ where: { key } })
            .catch(() => undefined);
        }

        return originalJson(body);
      };

      // A handler that throws, or a client that disconnects, never reaches
      // res.json. Without this the claim would be stranded and every retry
      // would get "in progress" until it expired.
      res.once('close', () => {
        if (settled) return;
        settled = true;
        void prisma.idempotencyKey.delete({ where: { key } }).catch(() => undefined);
      });

      next();
    } catch (error) {
      next(error);
    }
  };
};

/** Housekeeping. Runs as a scheduled worker job (Phase 7). */
export const purgeExpiredIdempotencyKeys = async (): Promise<number> => {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
};
