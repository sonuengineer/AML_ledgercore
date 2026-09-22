/**
 * Error hierarchy.
 *
 * Two rules that the legacy system broke and this one will not:
 *
 *  1. A failure is never reported as a success. The legacy LoginController
 *     returned 200 OK with a token even when authentication failed, and asked
 *     the client to inspect `data.errMsg`. Here, failure is a thrown AppError
 *     and the status code tells the truth.
 *
 *  2. The message that reaches the client is written for the client. Internal
 *     detail (SQL, stack, driver text) is logged, never serialised.
 *
 * `code` is a stable machine-readable string. The frontend switches on `code`,
 * never on `message`, so wording can change without breaking a client.
 */

export type ErrorDetails = Record<string, unknown> | undefined;

export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;

  /** Safe to serialise to the client. */
  readonly details: ErrorDetails;

  /**
   * Expected failures (validation, not found, forbidden) are logged at warn.
   * Unexpected ones are logged at error with the stack.
   */
  readonly isExpected: boolean = true;

  constructor(message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly code = 'VALIDATION_FAILED';
}

export class UnauthorizedError extends AppError {
  readonly status = 401;
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'Authentication required', details?: ErrorDetails) {
    super(message, details);
  }
}

export class ForbiddenError extends AppError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';

  constructor(message = 'You do not have permission to perform this action', details?: ErrorDetails) {
    super(message, details);
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';

  constructor(resource: string, identifier?: string) {
    super(`${resource} not found`, identifier ? { resource, identifier } : { resource });
  }
}

/** Uniqueness violation, duplicate idempotency key, state already applied. */
export class ConflictError extends AppError {
  readonly status = 409;
  readonly code = 'CONFLICT';
}

/**
 * Optimistic concurrency failure: the row changed underneath us.
 * Separate from ConflictError because the client's correct response differs --
 * refetch and retry, rather than give up.
 */
export class ConcurrencyError extends AppError {
  readonly status = 409;
  readonly code = 'CONCURRENT_MODIFICATION';

  constructor(resource: string, identifier?: string) {
    super(
      `${resource} was modified by someone else. Reload and try again.`,
      identifier ? { resource, identifier } : { resource },
    );
  }
}

/**
 * The request was well-formed but violates a business rule.
 * This is the class the ledger will lean on hardest in Phase 5:
 * unbalanced voucher, closed batch, frozen account, maker equals checker.
 */
export class BusinessRuleError extends AppError {
  readonly status = 422;
  readonly code: string;

  constructor(code: string, message: string, details?: ErrorDetails) {
    super(message, details);
    this.code = code;
  }
}

export class TooManyRequestsError extends AppError {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';
}

/** A dependency we own is unavailable. Readiness should already be failing. */
export class ServiceUnavailableError extends AppError {
  readonly status = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
  override readonly isExpected = false;
}

/** Anything we did not anticipate. Never carries detail to the client. */
export class InternalError extends AppError {
  readonly status = 500;
  readonly code = 'INTERNAL_ERROR';
  override readonly isExpected = false;

  constructor(message = 'An unexpected error occurred') {
    super(message);
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
