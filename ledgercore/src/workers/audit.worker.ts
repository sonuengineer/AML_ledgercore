import { Prisma } from '@prisma/client';
import { prisma } from '../shared/db/prisma';
import { moduleLogger } from '../shared/logging/logger';
import { QUEUES } from '../shared/queue/types';
import { createConsumer } from './consumer';

const log = moduleLogger('audit-worker');

interface EventPayload {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * Audit trail writer.
 *
 * Phase 5 created `audit_event` and left it unwritten, because writing it
 * inside the posting transaction is the wrong shape: audit volume is high, the
 * rows are wide, and a slow audit insert would add latency to the money path
 * for something nobody reads synchronously.
 *
 * So it consumes the same outbox events the notifier does, on its own queue
 * with its own retry budget. A failing SMS gateway cannot block the audit
 * trail, and a slow audit write cannot delay a notification.
 *
 * IDEMPOTENCY: a UNIQUE constraint on `(entityId, action, requestId)`.
 *
 * The first version of this worker did a read-then-write existence check and
 * called itself idempotent. An integration test proved otherwise: two
 * redeliveries processed concurrently both passed the check and both
 * inserted. Under at-least-once delivery that is not a rare race, it is the
 * expected behaviour under load -- the queue delivers a burst, the consumer
 * runs at concurrency 10, and the reads interleave with the writes.
 *
 * The fix is the same one the ledger and the AML worker use: let the database
 * decide. The insert IS the check, a duplicate raises P2002, and the consumer
 * treats that as success because the work was already done.
 *
 * The general rule: "check then act" is not idempotency, it is a race with
 * good intentions.
 */
export const startAuditWorker = () =>
  createConsumer<EventPayload>({ queue: QUEUES.AUDIT, concurrency: 10 }, async (data, job) => {
    const requestId = job.data.requestId ?? `job:${job.id}`;

    try {
      await prisma.auditEvent.create({
        data: {
          action: data.eventType,
          entityType: data.aggregateType,
          entityId: data.aggregateId,
          // `after` only: an outbox event is a statement of what happened, not
          // a diff. A real before/after would have to be captured in the
          // posting transaction -- a Phase 9 change if auditors ask for it.
          after: data.payload as Prisma.InputJsonValue,
          requestId,
        },
      });
      log.debug({ eventType: data.eventType, aggregateId: data.aggregateId }, 'audit event written');
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Already recorded by another delivery of the same event. Success:
        // the work is done, and doing it again would be the bug.
        log.debug(
          { eventType: data.eventType, aggregateId: data.aggregateId },
          'audit event already recorded, skipping',
        );
        return;
      }
      throw error;
    }
  });
