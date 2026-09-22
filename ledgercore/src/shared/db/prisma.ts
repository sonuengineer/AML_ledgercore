import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../../config';
import { moduleLogger } from '../logging/logger';
import { ConcurrencyError, ConflictError, InternalError, NotFoundError } from '../errors/AppError';
import { dbPingDuration, dbQueryDuration } from '../metrics/registry';

const log = moduleLogger('db');

/**
 * Database access.
 *
 * Phase 3 uses one Postgres and Prisma's own pool. Two things are set up now
 * because retrofitting them later is painful:
 *
 *  - Every query is timed and logged INSIDE the caller's async context, so the
 *    line carries the requestId. See the note on `$extends` below -- this is
 *    the difference between "we log queries" and "I can pull up every query one
 *    teller's failed voucher made".
 *  - Prisma's driver errors are translated into our AppError hierarchy at this
 *    boundary, so services and controllers never import Prisma error codes.
 *
 * Phase 11 replaces the connection string with a pgBouncer one; because
 * nothing outside this file knows about Prisma's pool, that is a config change.
 */

const SLOW_QUERY_MS = 200;

/**
 * SERVER-SIDE limits, set once per session.
 *
 * `withTimeout` in shared/resilience races a promise against a clock, which
 * bounds the CALLER's wait but cannot stop the work -- a promise is not
 * cancellable, so the query keeps running and keeps holding its locks. Under
 * load that is the wrong half of the problem to solve.
 *
 * These two are enforced by Postgres itself and actually abort the statement.
 *
 * `statement_timeout` caps any single query. It is the guard against a query
 * that turns pathological after a plan change -- exactly the missing-index
 * case Phase 5's EXPLAIN work was about. Ten seconds is far above any query
 * this system issues and far below "a teller has given up and refreshed".
 *
 * `lock_timeout` is the more important one for a ledger and the one people
 * forget. The posting path takes `SELECT ... FOR UPDATE` on balance rows
 * (Phase 5). If another transaction holds that lock and is itself stuck, this
 * one waits INDEFINITELY by default -- and every subsequent posting for that
 * account queues behind it. One stuck transaction silently freezes an account.
 * Five seconds converts that into a clean, retryable error.
 *
 * Both are set via the connection string so they apply to every pooled
 * connection, including pgBouncer's in Phase 11 -- a `SET` issued once on
 * connect would be lost the moment the pool hands out a different backend.
 */
const withServerTimeouts = (url: string): string => {
  const parsed = new URL(url);
  const params = parsed.searchParams;

  if (!params.has('options')) {
    params.set(
      'options',
      `-c statement_timeout=${config.db.pgStatementTimeoutMs} -c lock_timeout=${config.db.pgLockTimeoutMs}`,
    );
  }

  return parsed.toString();
};


const baseClient = new PrismaClient({
  datasources: { db: { url: withServerTimeouts(config.db.url) } },
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

baseClient.$on('warn', (event: Prisma.LogEvent) => log.warn({ target: event.target }, event.message));
baseClient.$on('error', (event: Prisma.LogEvent) => log.error({ target: event.target }, event.message));

/**
 * Query timing via a client extension rather than `$on('query')`.
 *
 * Why it matters: `$on('query')` is an event emitter. Its callback runs on a
 * later tick, OUTSIDE the AsyncLocalStorage scope that `requestContext`
 * opened -- so the logger's mixin finds no context and the line has no
 * requestId. It is a query log you cannot correlate with anything.
 *
 * A client extension wraps the call inline, in the caller's async context, so
 * the requestId, userId and branchId attach automatically. That is what makes
 * "one id traces a request through every layer" (Phase 2, section 8) actually
 * true rather than aspirational.
 *
 * Cost: the extension sits on the hot path. It does two `hrtime` reads and, at
 * info level, logs nothing at all for a fast query.
 */
export const prisma = baseClient.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const startedAt = process.hrtime.bigint();
      try {
        return await query(args);
      } finally {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        // model+operation is bounded by the schema, so it is safe as a label.
        // The SQL text never is -- it would be unbounded AND would leak
        // parameters into metric names.
        dbQueryDuration.observe(
          { model: model ?? 'raw', operation: operation ?? 'unknown' },
          durationMs / 1000,
        );

        if (durationMs >= SLOW_QUERY_MS) {
          // No `args` in the payload: query parameters contain customer data.
          log.warn({ model, operation, durationMs: Math.round(durationMs) }, 'slow query');
        } else {
          log.debug({ model, operation, durationMs: Math.round(durationMs * 100) / 100 }, 'query');
        }
      }
    },
  },
});

export type ExtendedPrismaClient = typeof prisma;

/** Prisma transaction client -- what repositories accept so they compose. */
export type TxClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Repositories take `db: TxClient = prisma`, so the same repository call works
 * inside and outside a transaction. Phase 5 depends on this heavily: a voucher
 * commit writes voucher, lines, idempotency key and outbox row through four
 * repositories inside one transaction.
 */
export const transaction = async <T>(
  fn: (tx: TxClient) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeoutMs?: number },
): Promise<T> =>
  prisma.$transaction(
    (async (tx: TxClient) => {
      const result = await fn(tx);

      /**
       * Force DEFERRABLE constraint triggers to fire HERE, inside the
       * transaction, instead of at COMMIT.
       *
       * This is not a micro-optimisation. Prisma's interactive `$transaction`
       * SWALLOWS a commit failure: when the deferred balanced-voucher trigger
       * rejected at COMMIT, Prisma logged "transaction failed to commit",
       * rolled the data back correctly -- and then RESOLVED the promise. The
       * application would have told a teller the voucher posted while nothing
       * was written.
       *
       * A probe script confirmed it: outcome "COMMITTED", rows left 0.
       *
       * `SET CONSTRAINTS ALL IMMEDIATE` as the last statement makes those
       * triggers run while the transaction is still open, so the error comes
       * back through the normal path and reaches the error middleware.
       *
       * The alternative -- not using deferred constraints at all -- is worse:
       * the balanced-voucher check genuinely cannot run per-row, because a
       * voucher is legitimately unbalanced while its lines are being inserted.
       */
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');

      return result;
    }) as (tx: unknown) => Promise<T>,
    {
    // READ COMMITTED is Postgres's default and the right baseline: the ledger
    // gets its guarantees from explicit row locks (Phase 5), not from a
    // blanket isolation level that would serialise unrelated branches.
      isolationLevel: options?.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: options?.timeoutMs ?? config.db.statementTimeoutMs,
    },
  );

/**
 * Translate a Prisma error into a domain error.
 * Call this in repositories, not in services -- the point is that the driver
 * stops at the data layer.
 */
export const translateDbError = (error: unknown, resource: string): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        const target = (error.meta?.target as string[] | undefined)?.join(', ');
        throw new ConflictError(`${resource} already exists`, target ? { conflictingFields: target } : undefined);
      }
      case 'P2025':
        throw new NotFoundError(resource);
      case 'P2003':
        throw new ConflictError(`${resource} references something that does not exist`);
      case 'P2034':
        // Write conflict / deadlock detected by Postgres and surfaced by Prisma.
        throw new ConcurrencyError(resource);
      default:
        log.error({ code: error.code, meta: error.meta }, 'unhandled prisma error');
        throw new InternalError();
    }
  }
  throw error;
};

/** Cheap liveness probe for the readiness endpoint. */
export const pingDatabase = async (): Promise<void> => {
  const start = process.hrtime.bigint();
  await prisma.$queryRaw`SELECT 1`;
  dbPingDuration.observe(Number(process.hrtime.bigint() - start) / 1e9);
};

export const connectDatabase = async (): Promise<void> => {
  await baseClient.$connect();

  const applied = await baseClient.$queryRaw<Array<{ statement: string; lock: string }>>`
    SELECT current_setting('statement_timeout') AS statement,
           current_setting('lock_timeout')      AS lock
  `;

  log.info(
    { statementTimeout: applied[0]?.statement, lockTimeout: applied[0]?.lock },
    'database connected',
  );
};

export const disconnectDatabase = async (): Promise<void> => {
  await baseClient.$disconnect();
  log.info('database disconnected');
};
