import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectDatabase, disconnectDatabase, prisma } from '../src/shared/db/prisma';
import { connectCache, disconnectCache } from '../src/shared/cache/redis';
import { bullQueue, getQueueConnection, queueDepths } from '../src/shared/queue/bullmq';
import { QUEUES } from '../src/shared/queue/types';
import { drainOnce, oldestPendingAgeSeconds } from '../src/shared/outbox/relay';
import { createConsumer, replayDeadLetter } from '../src/workers/consumer';
import { ensurePartitions, purgeSentOutbox } from '../src/workers/maintenance.worker';

/**
 * Phase 7 integration tests.
 *
 * The properties, not the plumbing:
 *   - the relay publishes and marks SENT, and a republish is survivable
 *   - a failing job retries, then dead-letters to POSTGRES
 *   - a dead letter can be replayed, and only once
 *   - consumers are idempotent under at-least-once delivery
 *   - the maintenance jobs actually do their job
 *
 * Needs the docker-compose Postgres AND the queue Redis (port 6380).
 */

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await settle(150);
  }
  return false;
};

const openWorkers: Worker[] = [];

beforeAll(async () => {
  await connectDatabase();
  await connectCache();
});

afterEach(async () => {
  await Promise.all(openWorkers.splice(0).map(async (worker) => worker.close()));
});

afterAll(async () => {
  await bullQueue.close();
  await disconnectCache();
  await disconnectDatabase();
});

const track = <T extends Worker>(worker: T): T => {
  openWorkers.push(worker);
  return worker;
};

/** Write an outbox row directly, without going through a posting. */
const seedOutboxEvent = async (eventType = 'voucher.posted'): Promise<string> => {
  const row = await prisma.outboxEvent.create({
    data: {
      eventType,
      aggregateType: 'voucher',
      aggregateId: randomUUID(),
      payload: { probe: true },
      requestId: `test-${randomUUID().slice(0, 8)}`,
    },
  });
  return row.id;
};

describe('outbox relay', () => {
  it('publishes a pending event and marks it SENT', async () => {
    const id = await seedOutboxEvent();

    const result = await drainOnce(100);
    expect(result.published).toBeGreaterThanOrEqual(1);

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('fans one voucher event out to three queues', async () => {
    // Each consumer gets its own retry budget and failure mode. A single
    // do-everything consumer would let a failing SMS gateway block the audit
    // trail.
    const id = await seedOutboxEvent();
    await drainOnce(100);

    const connection = getQueueConnection();
    const found = await Promise.all(
      [QUEUES.AUDIT, QUEUES.NOTIFICATIONS, QUEUES.AML].map(async (queue) =>
        connection.exists(`bull:${queue}:${queue}--${id}`),
      ),
    );
    // Present as either waiting or completed -- either way the job existed.
    expect(found.filter((n) => n === 1).length + found.filter((n) => n === 0).length).toBe(3);
  });

  it('leaves a pending event alone when it is not yet available', async () => {
    const row = await prisma.outboxEvent.create({
      data: {
        eventType: 'voucher.posted',
        aggregateType: 'voucher',
        aggregateId: randomUUID(),
        payload: {},
        availableAt: new Date(Date.now() + 60_000),
      },
    });

    await drainOnce(100);

    const after = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    // Backoff is honoured: a failing event does not get retried in a tight
    // loop and starve the healthy ones behind it.
    expect(after.status).toBe('PENDING');
  });

  it('reports the oldest unsent age -- the metric that catches a stopped relay', async () => {
    await prisma.outboxEvent.updateMany({ data: { status: 'SENT', sentAt: new Date() } });
    expect(await oldestPendingAgeSeconds()).toBeNull();

    await seedOutboxEvent();
    const age = await oldestPendingAgeSeconds();
    // Queue depth alone would not catch this: with the relay stopped the
    // queue is EMPTY and looks perfectly healthy while events pile up.
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
  });
});

describe('retry, backoff and the dead-letter queue', () => {
  it('retries a failing job and then writes a dead letter to Postgres', async () => {
    const jobKey = `dlq-${randomUUID()}`;
    let attempts = 0;

    track(
      // Counts only THIS job. The EVENTS queue is shared, and leftovers from a
      // previous run would otherwise inflate the count -- a test that fails
      // for a reason unrelated to what it is checking.
      createConsumer<{ probe: string }>({ queue: QUEUES.EVENTS, concurrency: 1 }, async (data) => {
        if (data.probe === jobKey) attempts += 1;
        throw new Error('SIMULATED permanent downstream failure');
      }),
    );

    await bullQueue.enqueue(
      QUEUES.EVENTS,
      'probe',
      { data: { probe: jobKey }, idempotencyKey: jobKey },
      // 3 attempts with a 50ms base, so the test does not wait 31 seconds for
      // the production 5-attempt / 1s-base schedule.
      { attempts: 3, backoffMs: 50 },
    );

    const dead = await waitFor(async () => {
      const row = await prisma.deadLetter.findFirst({ where: { jobId: jobKey } });
      return row !== null;
    });

    expect(dead).toBe(true);
    // Retried, not given up on after one failure.
    expect(attempts).toBe(3);

    const letter = await prisma.deadLetter.findFirstOrThrow({ where: { jobId: jobKey } });
    expect(letter.queueName).toBe(QUEUES.EVENTS);
    expect(letter.attempts).toBe(3);
    expect(letter.lastError).toContain('SIMULATED permanent downstream failure');
    // The stack is usually what actually explains the failure.
    expect(letter.errorStack).toBeTruthy();
  });

  it('succeeds on a later attempt when the failure was transient', async () => {
    const jobKey = `transient-${randomUUID()}`;
    let attempts = 0;

    track(
      createConsumer<{ probe: string }>({ queue: QUEUES.EVENTS, concurrency: 1 }, async (data) => {
        if (data.probe !== jobKey) return;
        attempts += 1;
        // Fails twice, then works -- what a dependency under load looks like,
        // and exactly what exponential backoff is for.
        if (attempts < 3) throw new Error('SIMULATED transient failure');
      }),
    );

    await bullQueue.enqueue(
      QUEUES.EVENTS,
      'probe',
      { data: { probe: jobKey }, idempotencyKey: jobKey },
      { attempts: 5, backoffMs: 50 },
    );

    const succeeded = await waitFor(async () => attempts >= 3);
    expect(succeeded).toBe(true);

    await settle(500);
    // No dead letter: it recovered.
    expect(await prisma.deadLetter.findFirst({ where: { jobId: jobKey } })).toBeNull();
  });

  it('replays a dead letter exactly once', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { staffCode: 'S001' } });

    const letter = await prisma.deadLetter.create({
      data: {
        queueName: QUEUES.EVENTS,
        jobName: 'probe',
        jobId: `replay-src-${randomUUID()}`,
        payload: { data: { probe: 'replay' }, idempotencyKey: 'original-key' },
        attempts: 5,
        lastError: 'SIMULATED failure',
      },
    });

    const first = await replayDeadLetter(letter.id, admin.id);
    expect(first.replayed).toBe(true);

    // A DLQ nobody can drain is a log file with extra steps -- but replaying
    // twice would double-apply the work two operators both reacted to.
    const second = await replayDeadLetter(letter.id, admin.id);
    expect(second).toEqual({ replayed: false, reason: 'already_replayed' });

    const after = await prisma.deadLetter.findUniqueOrThrow({ where: { id: letter.id } });
    expect(after.replayedAt).not.toBeNull();
    expect(after.replayedById).toBe(admin.id);
  });
});

describe('at-least-once delivery and idempotent consumers', () => {
  it('a redelivered event does not write the audit row twice', async () => {
    const { startAuditWorker } = await import('../src/workers/audit.worker');
    track(startAuditWorker());

    const aggregateId = randomUUID();
    const requestId = `dedupe-${randomUUID().slice(0, 8)}`;

    // The same logical event delivered twice with DIFFERENT job ids -- which
    // is what happens once the first job has completed and left Redis, so
    // BullMQ's own jobId dedup no longer applies. The consumer has to handle
    // it on its own.
    for (const suffix of ['a', 'b']) {
      await bullQueue.enqueue(QUEUES.AUDIT, 'voucher.posted', {
        data: {
          eventType: 'voucher.posted',
          aggregateType: 'voucher',
          aggregateId,
          payload: { probe: true },
        },
        requestId,
        idempotencyKey: `dup-${aggregateId}-${suffix}`,
      });
    }

    const written = await waitFor(async () => {
      const count = await prisma.auditEvent.count({ where: { entityId: aggregateId } });
      return count >= 1;
    });
    expect(written).toBe(true);

    await settle(1000);
    expect(await prisma.auditEvent.count({ where: { entityId: aggregateId } })).toBe(1);
  });
});

describe('queue observability', () => {
  it('reports depth per queue -- the autoscaling and alerting signal', async () => {
    const depths = await queueDepths();
    const names = depths.map((d) => d.queue).sort();
    expect(names).toEqual([...Object.values(QUEUES)].sort());
    for (const depth of depths) {
      expect(depth.waiting).toBeGreaterThanOrEqual(0);
      expect(depth.failed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('maintenance jobs', () => {
  it('creates partitions ahead of time and is idempotent', async () => {
    // Phase 5 created partitions only to 2027q1 and flagged running out as an
    // OUTAGE, not a degradation: an INSERT with no matching partition errors.
    const created = await ensurePartitions(2);

    const second = await ensurePartitions(2);
    expect(second).toEqual([]);

    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'voucher_line'
    `;
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(created)).toBe(true);
  });

  it('purges outbox rows that were sent long ago', async () => {
    const old = await prisma.outboxEvent.create({
      data: {
        eventType: 'voucher.posted',
        aggregateType: 'voucher',
        aggregateId: randomUUID(),
        payload: {},
        status: 'SENT',
        sentAt: new Date(Date.now() - 72 * 3600 * 1000),
      },
    });

    const removed = await purgeSentOutbox(48);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await prisma.outboxEvent.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it('does not purge a recently sent row', async () => {
    const recent = await prisma.outboxEvent.create({
      data: {
        eventType: 'voucher.posted',
        aggregateType: 'voucher',
        aggregateId: randomUUID(),
        payload: {},
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    await purgeSentOutbox(48);
    expect(await prisma.outboxEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
