/**
 * The queue contract.
 *
 * Producers depend on THIS, never on BullMQ. Phase 2 committed to BullMQ for
 * local development with SQS as the AWS option, and this interface is what
 * makes that swap a single adapter rather than a refactor: an SQS
 * implementation of `enqueue` is about forty lines.
 *
 * Keeping the interface this small is deliberate. Anything richer -- priorities,
 * job dependencies, flows -- is a BullMQ feature SQS does not have, and
 * depending on it would quietly weld the system to one broker.
 */

export const QUEUES = {
  /** Fan-out target for outbox events. */
  EVENTS: 'events',
  /** Simulated SMS/email. The classic fire-and-forget. */
  NOTIFICATIONS: 'notifications',
  /** Append-only audit trail. High volume, must never block a posting. */
  AUDIT: 'audit',
  /** AML rule evaluation -- the Phase 1 Direction-2 slice. */
  AML: 'aml',
  /** Scheduled housekeeping: purges, partition creation. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobEnvelope<T = unknown> {
  /** Business payload. */
  data: T;
  /**
   * Carried from the request that caused it, so a worker's logs join the same
   * trace as the API call. This is why AsyncLocalStorage was set up in Phase 3
   * and why `outbox_event` has a `request_id` column.
   */
  requestId?: string | undefined;
  /**
   * Stable identity for the work, NOT for the message.
   *
   * Delivery is at-least-once -- every queue is -- so a consumer will see the
   * same work twice. This is what it de-duplicates on. "Exactly once" is
   * at-least-once plus consumer-side dedup; there is no broker that gives it
   * to you.
   */
  idempotencyKey: string;
}

export interface EnqueueOptions {
  /** Delay before the job becomes visible. */
  delayMs?: number;
  /** Total attempts including the first. Default 5. */
  attempts?: number;
  /** Base for exponential backoff. Default 1000ms. */
  backoffMs?: number;
}

export interface JobQueue {
  enqueue<T>(
    queue: QueueName,
    jobName: string,
    envelope: JobEnvelope<T>,
    options?: EnqueueOptions,
  ): Promise<string>;

  /** Bulk enqueue. One round trip for a batch of outbox events. */
  enqueueMany<T>(
    queue: QueueName,
    jobs: Array<{ jobName: string; envelope: JobEnvelope<T>; options?: EnqueueOptions }>,
  ): Promise<string[]>;

  /** Repeatable job, cron-style. Housekeeping only. */
  schedule<T>(
    queue: QueueName,
    jobName: string,
    cron: string,
    envelope: JobEnvelope<T>,
  ): Promise<void>;

  close(): Promise<void>;
}

export interface QueueDepth {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}
