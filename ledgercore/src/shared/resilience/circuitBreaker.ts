import { ServiceUnavailableError } from '../errors/AppError';
import { moduleLogger } from '../logging/logger';

const log = moduleLogger('circuit-breaker');

/**
 * Circuit breaker.
 *
 * ---------------------------------------------------------------------------
 * What this is FOR, and what it is deliberately NOT for
 * ---------------------------------------------------------------------------
 *
 * A breaker stops a caller hammering a dependency that is already failing. The
 * value is twofold: the caller fails fast instead of holding a request open
 * for a 30-second timeout, and the struggling dependency gets room to recover
 * instead of being retried into the ground.
 *
 * It is the right tool when the dependency is EXTERNAL, OPTIONAL, and SLOW TO
 * FAIL. In this system that means the SMS gateway, and later the sanctions
 * screening API.
 *
 * It is the WRONG tool for Postgres, and putting one there would be a mistake
 * worth being explicit about:
 *
 *   - If the database is down, the API cannot serve correct responses at all.
 *     A breaker would convert "slow failure" into "fast failure", which sounds
 *     better and is not -- there is no fallback and nothing useful to return.
 *   - Worse, a breaker that opens on the database keeps it open for the cool-
 *     down even after the database recovers, so a 2-second blip becomes a
 *     30-second outage that the breaker itself caused.
 *   - Postgres already has the right tools: `statement_timeout`,
 *     `lock_timeout`, and a connection pool that queues. Those bound the
 *     damage without adding a state machine that can be wrong.
 *
 * Redis likewise does not need one: Phase 6 already fails open with a 150 ms
 * command timeout, which is a breaker's benefit without a breaker's state.
 *
 * ---------------------------------------------------------------------------
 * The state machine
 * ---------------------------------------------------------------------------
 *
 *   CLOSED ---- failures >= threshold ----> OPEN
 *      ^                                     |
 *      |                              cooldown elapsed
 *      |                                     v
 *      +---- probe succeeds ----------- HALF_OPEN
 *                                            |
 *                              probe fails --+--> back to OPEN
 *
 * HALF_OPEN admits exactly ONE request. Letting several through means a
 * dependency that is still down gets hit N times per cooldown, which is the
 * thundering-herd the breaker exists to prevent.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name: string;
  /** Consecutive failures before opening. */
  failureThreshold?: number;
  /** How long to stay open before admitting a probe. */
  cooldownMs?: number;
  /** Consecutive successes in HALF_OPEN before closing. */
  successThreshold?: number;
  /**
   * Which errors count as a dependency failure.
   *
   * Default: everything. Override it when the dependency distinguishes "I am
   * broken" from "your request was invalid" -- a 400 from a gateway means the
   * phone number was wrong, and counting that towards opening the circuit
   * would take the gateway out of service because of one bad record.
   */
  isFailure?: (error: unknown) => boolean;
}

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  openedAt: number | null;
  lastError: string | null;
}

export class CircuitOpenError extends ServiceUnavailableError {
  constructor(name: string, retryAfterMs: number) {
    super(`${name} is unavailable and the circuit is open.`, {
      circuit: name,
      retryAfterMs,
    });
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;
  private lastError: string | null = null;
  /** True while a HALF_OPEN probe is in flight, so only one is admitted. */
  private probing = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly isFailure: (error: unknown) => boolean;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 2;
    this.isFailure = options.isFailure ?? (() => true);
  }

  snapshot(): CircuitSnapshot {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      openedAt: this.openedAt,
      lastError: this.lastError,
    };
  }

  /** Test seam. Never called by application code. */
  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
    this.lastError = null;
    this.probing = false;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.openedAt ?? 0);

      if (elapsed < this.cooldownMs) {
        // Fast failure. The caller is not held open for a timeout against a
        // dependency we already know is down.
        throw new CircuitOpenError(this.options.name, this.cooldownMs - elapsed);
      }

      this.state = 'HALF_OPEN';
      this.successes = 0;
      this.probing = false;
      log.info({ circuit: this.options.name }, 'circuit half-open, admitting a probe');
    }

    if (this.state === 'HALF_OPEN') {
      if (this.probing) {
        // Another probe is already in flight. Admitting this one too would
        // mean N requests hitting a dependency that may still be down.
        throw new CircuitOpenError(this.options.name, this.cooldownMs);
      }
      this.probing = true;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isFailure(error)) this.onFailure(error);
      else if (this.state === 'HALF_OPEN') this.probing = false;
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.probing = false;
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        log.info({ circuit: this.options.name }, 'circuit closed, dependency recovered');
        this.reset();
      }
      return;
    }

    // Consecutive, not cumulative: one success clears the count. A dependency
    // that fails 4 times an hour is not broken, and a cumulative counter would
    // eventually open the circuit on a perfectly healthy service.
    this.failures = 0;
  }

  private onFailure(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);

    if (this.state === 'HALF_OPEN') {
      // The probe failed. Straight back to OPEN with a fresh cooldown.
      this.probing = false;
      this.state = 'OPEN';
      this.openedAt = Date.now();
      log.warn(
        { circuit: this.options.name, err: this.lastError },
        'circuit probe failed, reopening',
      );
      return;
    }

    this.failures += 1;

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      log.error(
        {
          circuit: this.options.name,
          failures: this.failures,
          cooldownMs: this.cooldownMs,
          err: this.lastError,
        },
        'circuit OPENED -- failing fast until the dependency recovers',
      );
    }
  }
}

/** Registry, so /health can report every breaker's state. */
const breakers = new Map<string, CircuitBreaker>();

export const getBreaker = (options: CircuitBreakerOptions): CircuitBreaker => {
  let breaker = breakers.get(options.name);
  if (!breaker) {
    breaker = new CircuitBreaker(options);
    breakers.set(options.name, breaker);
  }
  return breaker;
};

export const allBreakers = (): CircuitSnapshot[] =>
  [...breakers.values()].map((breaker) => breaker.snapshot());
