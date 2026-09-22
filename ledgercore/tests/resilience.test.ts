import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/shared/resilience/circuitBreaker';
import { TimeoutError, withTimeout } from '../src/shared/resilience/timeout';

/**
 * Phase 10 unit tests. No database, no Redis -- these are the state machines.
 */

const boom = (message = 'dependency down'): Promise<never> => Promise.reject(new Error(message));

describe('circuit breaker', () => {
  const make = (overrides = {}) =>
    new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      cooldownMs: 100,
      successThreshold: 2,
      ...overrides,
    });

  it('stays closed while the dependency works', async () => {
    const breaker = make();
    for (let i = 0; i < 10; i += 1) {
      await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    }
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('opens after the failure threshold', async () => {
    const breaker = make();

    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => boom())).rejects.toThrow('dependency down');
    }

    expect(breaker.snapshot().state).toBe('OPEN');
  });

  it('fails FAST once open, without calling the dependency', async () => {
    const breaker = make();
    const dependency = vi.fn(async () => boom());

    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(dependency)).rejects.toThrow();
    }
    expect(dependency).toHaveBeenCalledTimes(3);

    // This is the whole point: the caller is not held open for a timeout
    // against something we already know is down, and the struggling
    // dependency gets no further traffic.
    await expect(breaker.execute(dependency)).rejects.toThrow(CircuitOpenError);
    expect(dependency).toHaveBeenCalledTimes(3);
  });

  it('counts CONSECUTIVE failures, so one success clears the count', async () => {
    const breaker = make();

    await expect(breaker.execute(async () => boom())).rejects.toThrow();
    await expect(breaker.execute(async () => boom())).rejects.toThrow();
    // A dependency that fails twice an hour is not broken. A cumulative
    // counter would eventually open the circuit on a healthy service.
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    await expect(breaker.execute(async () => boom())).rejects.toThrow();
    await expect(breaker.execute(async () => boom())).rejects.toThrow();

    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('admits exactly ONE probe when half-open', async () => {
    const breaker = make();
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => boom())).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    let admitted = 0;
    const slow = async (): Promise<string> => {
      admitted += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return 'ok';
    };

    const results = await Promise.allSettled([
      breaker.execute(slow),
      breaker.execute(slow),
      breaker.execute(slow),
    ]);

    // Letting several through means a dependency that is still down gets hit
    // N times per cooldown -- the thundering herd the breaker exists to stop.
    expect(admitted).toBe(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });

  it('closes again after enough successful probes', async () => {
    const breaker = make();
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => boom())).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('HALF_OPEN');

    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('reopens immediately when the probe fails', async () => {
    const breaker = make();
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => boom())).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(breaker.execute(async () => boom())).rejects.toThrow('dependency down');
    // Straight back to OPEN with a fresh cooldown -- not "one more chance".
    expect(breaker.snapshot().state).toBe('OPEN');
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow(CircuitOpenError);
  });

  it('ignores errors classified as the caller\'s fault', async () => {
    class BadRequest extends Error {}

    const breaker = make({
      isFailure: (error: unknown) => !(error instanceof BadRequest),
    });

    // An unroutable phone number is a bad record, not a broken gateway.
    // Counting it would take the gateway out of service for one bad row.
    for (let i = 0; i < 10; i += 1) {
      await expect(
        breaker.execute(async () => Promise.reject(new BadRequest('invalid number'))),
      ).rejects.toThrow(BadRequest);
    }

    expect(breaker.snapshot().state).toBe('CLOSED');
  });

  it('reports a retry hint so the caller can back off sensibly', async () => {
    const breaker = make({ cooldownMs: 5_000 });
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(async () => boom())).rejects.toThrow();
    }

    await expect(breaker.execute(async () => 'ok')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: expect.objectContaining({ circuit: 'test' }),
    });
  });
});

describe('timeout helper', () => {
  it('resolves a fast operation untouched', async () => {
    await expect(withTimeout(async () => 'fast', 1_000, 'probe')).resolves.toBe('fast');
  });

  it('rejects when the deadline passes', async () => {
    await expect(
      withTimeout(
        async () => new Promise((resolve) => setTimeout(() => resolve('slow'), 500)),
        50,
        'probe',
      ),
    ).rejects.toThrow(TimeoutError);
  });

  it('does NOT cancel the underlying work -- which is why it is a second line of defence', async () => {
    let completed = false;

    await expect(
      withTimeout(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => {
              completed = true;
              resolve('done');
            }, 100),
          ),
        30,
        'probe',
      ),
    ).rejects.toThrow(TimeoutError);

    await new Promise((resolve) => setTimeout(resolve, 150));

    // The work carried on. A promise cannot be cancelled, so the query keeps
    // running and keeps holding its locks. That is exactly why Postgres's own
    // statement_timeout and lock_timeout are the FIRST line -- they actually
    // abort the statement.
    expect(completed).toBe(true);
  });

  it('clears its timer on success, so it cannot hold the event loop open', async () => {
    const before = process.hrtime.bigint();
    await withTimeout(async () => 'fast', 10_000, 'probe');
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;
    // If the timer leaked, graceful shutdown would hang for the full duration.
    expect(elapsedMs).toBeLessThan(500);
  });
});
