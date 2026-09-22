import { ServiceUnavailableError } from '../errors/AppError';

/**
 * Timeouts.
 *
 * The rule: **every call that crosses a process boundary has a deadline.**
 *
 * Without one, a dependency that stops responding without closing the
 * connection -- a hung database, a black-holed network route, a gateway that
 * accepts a TCP connection and then goes quiet -- holds a request open
 * forever. Those requests accumulate, the connection pool drains, and an API
 * that is nominally healthy stops serving anything. It is the single most
 * common way a slow dependency becomes a total outage.
 *
 * What already has a deadline, from earlier phases:
 *   Redis commands       150 ms      (Phase 6, config.cache.commandTimeoutMs)
 *   Prisma transactions  5 s         (Phase 3, config.db.statementTimeoutMs)
 *   nginx upstream       2 s connect / 30 s read   (Phase 8)
 *   Job attempts         5 with exponential backoff (Phase 7)
 *
 * What Phase 10 adds:
 *   Postgres statement_timeout and lock_timeout   -- see db/prisma.ts
 *   HTTP request deadline                         -- see middleware/timeout.ts
 *   This helper, for anything else.
 */

export class TimeoutError extends ServiceUnavailableError {
  constructor(operation: string, ms: number) {
    super(`${operation} did not complete within ${ms}ms.`, { operation, timeoutMs: ms });
  }
}

/**
 * Race an operation against a deadline.
 *
 * Note what this does NOT do: it does not cancel the underlying work. A
 * promise cannot be cancelled, so the query or HTTP call carries on in the
 * background and its result is discarded. That is why a timeout here is a
 * SECOND line of defence -- the first is a real server-side limit like
 * Postgres's `statement_timeout`, which actually stops the work.
 *
 * Using only this helper would bound the CALLER's wait while leaving the
 * dependency doing the expensive thing, which is exactly the wrong half of the
 * problem to solve under load.
 */
export const withTimeout = async <T>(
  operation: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });

  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    // Always clear it, or a fast success still holds the event loop open for
    // the full duration -- which makes graceful shutdown hang.
    if (timer) clearTimeout(timer);
  }
};
