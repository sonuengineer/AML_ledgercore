import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { getBreaker } from '../shared/resilience/circuitBreaker';
import { withTimeout } from '../shared/resilience/timeout';
import { QUEUES } from '../shared/queue/types';
import { createConsumer } from './consumer';

const log = moduleLogger('notification-worker');

interface EventPayload {
  eventType: string;
  aggregateId: string;
  payload: {
    voucherId?: string;
    voucherNumber?: string;
    totalAmount?: string;
    accountIds?: string[];
  };
}

/**
 * Customer notification on a posting.
 *
 * The canonical fire-and-forget: the teller must not wait on an SMS gateway,
 * and a gateway outage must not stop money moving.
 *
 * There is no real SMS provider here. `deliver()` below SIMULATES one,
 * including its failure modes, because the interesting engineering is the
 * retry/backoff/DLQ behaviour around an unreliable dependency -- not the
 * provider SDK. Every simulated failure is labelled as such.
 */

/** Set by tests to force deterministic failures. */
export const simulation = {
  /** 0 to 1. Probability a delivery attempt fails transiently. */
  failureRate: 0,
  /** Recipients whose delivery always fails, to exercise the DLQ. */
  alwaysFail: new Set<string>(),
  /** Simulated gateway latency, to exercise the timeout. */
  latencyMs: 0,
  /** Delivered messages, for assertions. */
  delivered: [] as Array<{ to: string; body: string }>,
};

const GATEWAY_TIMEOUT_MS = 5_000;

class GatewayError extends Error {
  constructor(
    message: string,
    /** True when the request itself was bad -- retrying will never help. */
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * The circuit breaker sits HERE, on the one genuinely external dependency.
 *
 * Not on Postgres -- if the database is down there is no fallback and nothing
 * useful to return, and an open circuit would keep failing requests for its
 * whole cooldown after the database recovered. Not on Redis -- Phase 6 already
 * fails open with a 150ms command timeout, which is a breaker's benefit
 * without a breaker's state. See circuitBreaker.ts for the full argument.
 *
 * `isFailure` excludes PERMANENT errors on purpose. An unroutable phone number
 * is a bad record, not a broken gateway, and counting it towards opening the
 * circuit would take SMS out of service for every customer because of one row.
 */
const gatewayBreaker = getBreaker({
  name: 'sms-gateway',
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 2,
  isFailure: (error) => !(error instanceof GatewayError && error.permanent),
});

export const gatewayCircuit = () => gatewayBreaker.snapshot();

/**
 * SIMULATED SMS gateway.
 *
 * Models the two failure shapes that matter:
 *   - transient: the gateway is briefly unavailable. Retrying works, and this
 *     is what exponential backoff exists for.
 *   - permanent: the number is unroutable. Retrying will never work, and the
 *     job should reach the dead-letter queue rather than burn five attempts.
 *
 * A real integration would distinguish them by HTTP status. Here the
 * `alwaysFail` set stands in for permanent failure.
 */
const send = async (to: string, body: string): Promise<void> => {
  if (simulation.alwaysFail.has(to)) {
    throw new GatewayError(`SIMULATED permanent failure: ${to} is unroutable`, true);
  }
  if (Math.random() < simulation.failureRate) {
    throw new GatewayError('SIMULATED transient failure: gateway unavailable');
  }
  if (simulation.latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, simulation.latencyMs));
  }
  simulation.delivered.push({ to, body });
};

/**
 * Three layers, innermost first:
 *
 *   1. TIMEOUT      -- a gateway that accepts the connection and then goes
 *                      quiet must not hold this job open forever.
 *   2. BREAKER      -- after 5 consecutive failures, stop calling it at all.
 *                      Fails fast and gives the gateway room to recover.
 *   3. RETRY + DLQ  -- from the Phase 7 consumer harness, outside this call.
 *
 * Order matters. The timeout is INSIDE the breaker, so a hung call counts as
 * a failure and contributes to opening the circuit. Inverted, the breaker
 * would never see the hang and would stay closed forever while every job
 * timed out.
 */
const deliver = async (to: string, body: string): Promise<void> =>
  gatewayBreaker.execute(async () =>
    withTimeout(async () => send(to, body), GATEWAY_TIMEOUT_MS, 'sms-gateway'),
  );

export const startNotificationWorker = () =>
  createConsumer<EventPayload>(
    { queue: QUEUES.NOTIFICATIONS, concurrency: 5 },
    async (data) => {
      // Only a posted voucher is worth telling a customer about. A created or
      // rejected one is internal workflow.
      if (data.eventType !== 'voucher.posted') return;

      const accountIds = data.payload.accountIds ?? [];
      if (accountIds.length === 0) return;

      const accounts = await prisma.account.findMany({
        where: { id: { in: accountIds }, customerId: { not: null } },
        select: {
          accountNumber: true,
          customer: { select: { id: true, fullName: true, phone: true } },
        },
      });

      for (const account of accounts) {
        const phone = account.customer?.phone;
        if (!phone) continue;

        await deliver(
          phone,
          `Txn on A/c ${account.accountNumber.slice(-4).padStart(account.accountNumber.length, 'x')}: ` +
            `INR ${data.payload.totalAmount ?? '?'} (ref ${data.payload.voucherNumber ?? '?'}).`,
        );

        log.debug({ voucherId: data.payload.voucherId, accountNumber: account.accountNumber }, 'notification delivered');
      }
    },
  );
