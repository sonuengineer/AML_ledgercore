# Phase 7 -- Async Processing

> Built and verified 2026-09-22. Step 2 of the topology is now complete:
> React -> Node API -> Redis -> PostgreSQL -> Queue -> Workers.
> Load balancing and multiple nodes are Phase 8.

---

## 1. What we built

```
  src/worker.ts                       separate process, own lifecycle
  src/shared/queue/types.ts           the JobQueue contract (broker-agnostic)
  src/shared/queue/bullmq.ts          BullMQ adapter + queue depth
  src/shared/outbox/relay.ts          FOR UPDATE SKIP LOCKED -> publish
  src/workers/consumer.ts             shared harness: trace, retry, DLQ, replay
  src/workers/audit.worker.ts         append-only audit trail
  src/workers/notification.worker.ts  simulated SMS, with real failure modes
  src/workers/aml.worker.ts           the Phase 1 Direction-2 slice
  src/workers/maintenance.worker.ts   scheduled purges + partition creation
```

New tables: `aml_rule`, `aml_alert`, `dead_letter`.
New infrastructure: a **second** Redis, for the queue.

---

## 2. The pipeline, proven end to end

```
  POST /api/v1/vouchers
       |
       |  ONE transaction: voucher + lines + balances + outbox row
       v
  outbox_event (PENDING)          <-- durable. The worker was not even running.
       |
       |  relay: FOR UPDATE SKIP LOCKED, publish, mark SENT
       v
  queue (BullMQ on redis-queue)
       |
       +--> audit         -> audit_event
       +--> notifications -> SMS (simulated)
       \--> aml           -> aml_alert
```

With the worker stopped:

```
   event_type    | status  | attempts | has_trace
-----------------+---------+----------+-----------
 voucher.created | PENDING |        0 | t
 voucher.posted  | PENDING |        0 | t

audit_event rows: 0
aml_alert rows: 0
```

Then the worker starts, and everything drains:

```
   event_type    | status | attempts | sent
-----------------+--------+----------+------
 voucher.created | SENT   |        1 | t
 voucher.posted  | SENT   |        1 | t
```

```
  consumer      job completed   queue=aml            job=voucher.created  reqId=80ee3b7d
  consumer      job completed   queue=notifications  job=voucher.created  reqId=80ee3b7d
  consumer      job completed   queue=audit          job=voucher.created  reqId=80ee3b7d
  outbox-relay  outbox batch relayed  published=2
  consumer      job completed   queue=audit          job=voucher.posted   reqId=80ee3b7d
  consumer      job completed   queue=notifications  job=voucher.posted   reqId=80ee3b7d
  consumer      job completed   queue=aml            job=voucher.posted   reqId=80ee3b7d
```

And the API log for the request that started it:

```
  API   POST  /api/v1/vouchers   status=201   reqId=80ee3b7d
```

**Same request id in the API and in three workers, across a process
boundary.** That is what AsyncLocalStorage in Phase 3 and the `request_id`
column on `outbox_event` in Phase 5 were laid down for. "What happened to that
voucher?" is one grep, not four.

---

## 3. The decisions that matter

### 3.1 A SEPARATE Redis for the queue

| | cache (6379) | queue (6380) |
|---|---|---|
| `maxmemory-policy` | `allkeys-lru` | **`noeviction`** |
| persistence | none | **AOF, everysec** |
| `enableOfflineQueue` | `false` | `true` |
| `maxRetriesPerRequest` | `1` | **`null`** |
| command timeout | 150 ms | none |

Every row is the opposite, and every one is deliberate.

**Running a queue on an LRU cache is a real trap.** Under memory pressure
Redis evicts keys; the keys are jobs; work vanishes with no error anywhere.
`noeviction` makes Redis return an error on write instead -- a loud failure the
producer can handle.

`maxRetriesPerRequest: null` is not optional either: BullMQ's blocking
commands sit idle for long periods, and any finite retry count makes ioredis
abort them with "max retries per request exceeded".

The cache must never block a request. The queue must never silently drop work.
Those are different jobs and they get different instances.

### 3.2 The relay: `FOR UPDATE SKIP LOCKED`

```sql
SELECT ... FROM outbox_event
 WHERE status IN ('PENDING','FAILED') AND available_at <= now()
 ORDER BY available_at, id
 LIMIT $1
   FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` is what makes this safe on every node at once. Without it, three
relays all try to lock the same oldest rows: two block behind the first, do
nothing useful, and serialise the pipeline. With it, each steps over what
another has claimed and takes the next free batch.

Three relays means three times the throughput, not three times the contention
-- and no leader election, no coordination service, no split-brain.

### 3.3 At-least-once, stated honestly

The relay publishes, **then** marks the row SENT. Die in between and the row is
still PENDING and gets published again.

The other ordering -- mark sent, then publish -- loses events instead, which is
strictly worse. A duplicate is a consumer's problem and a solvable one; a lost
posting event is silent data loss.

So every consumer is idempotent, and each one says how:

| Consumer | Mechanism |
|---|---|
| audit | UNIQUE `(entity_id, action, request_id)` |
| AML | UNIQUE `aml_alert.dedupe_key` = rule:version:customer:window |
| notification | naturally at-least-once; a duplicate SMS is acceptable, a missed one is not |

There is no broker that gives exactly-once. **Exactly-once is at-least-once
plus consumer-side dedup**, and pretending otherwise is how people ship
double-charged customers.

### 3.4 Retry, backoff, and what the DLQ is for

Five attempts, exponential backoff 1s / 2s / 4s / 8s / 16s. Exponential rather
than fixed because the usual cause of failure is a dependency under load --
retrying at a fixed interval hammers a struggling service and turns a blip into
an outage.

On final failure a **dead letter is written to Postgres**, not left in Redis.
BullMQ has a failed set, but it is capped, evictable and gone on a flush. A
dead letter is evidence that work was lost: it belongs where it can be
queried, alerted on and replayed months later.

And it can be replayed -- **once**. `replayedAt` is stamped so two operators
reacting to the same alert cannot double-apply the work. The replay also gets a
NEW job id, because the original may still be in Redis's completed set, where
re-enqueueing it would be a silent no-op: the operator would see "replayed" and
nothing would run.

### 3.5 The AML slice, and where Phase 1's sketch was wrong

Phase 1 sketched Redis sorted sets for the rolling-window counters. That is the
textbook answer and genuinely right at high throughput. It is wrong here, for
two reasons worth stating rather than following the sketch:

1. **An alert must be explainable to a regulator.** "Which transactions made up
   this total?" is the first question asked, and a sorted set of scores cannot
   answer it -- it holds sums, not evidence. `aml_alert.evidence` carries the
   contributing voucher ids, and they come from the ledger.
2. **Redis is evictable**, and the cache instance is `allkeys-lru`. A counter
   that silently loses a week of history produces a **false negative** in a
   compliance system -- the worst possible failure, and an invisible one.

Redis still earns its place: the RULE SET is cached, because it is read on
every posting and changes a few times a year. **Caching the rules is safe;
caching the evidence is not.** That distinction is the whole point.

Rules are also **versioned and never edited in place**, and each alert pins the
version it fired under. Otherwise changing a threshold silently rewrites the
history of every alert it ever produced.

Live result:

```
rule              | CTR-CASH-10L
rule_version      | 1
customer          | Rohit Gaikwad
observed_amount   | 3154090.0000
window_from       | 2026-08-22
window_to         | 2026-09-21
status            | OPEN
txns              | 1212
evidence_vouchers | 200
```

(The large totals come from the synthetic bulk data loaded in Phase 5.)

Dedup holds: **6 alerts, 6 distinct dedupe keys, 0 duplicate (rule, customer,
window) groups.**

### 3.6 Why the relay runs in the worker, not the API

It only needs Postgres and the queue, so it could run in either. Putting it in
the worker keeps the API purely request/response, and means the relay scales
with the thing that consumes its output rather than with inbound traffic.

### 3.7 Maintenance as repeatable jobs, not `setInterval`

Every "becomes a scheduled worker job in Phase 7" note from earlier phases is
now real: refresh-token purge, idempotency-key purge, sent-outbox purge, and
partition creation.

They are queue jobs because a cron inside the API means N nodes each running it
-- a purge running three times, a partition created three times. A repeatable
job is claimed by exactly one worker.

**Partition creation is the one that matters operationally.** Phase 5 flagged
it: an INSERT with no matching partition is an ERROR, not a degradation, so
running out of partitions is an outage arriving at midnight on a quarter
boundary. The job runs two quarters ahead, giving three months of slack before
a failure becomes urgent.

---

## 4. Four real bugs

### 4.1 Prisma's migration diff had been silently dropping my indexes

The worst of the four, and it had been happening since Phase 5.

`prisma migrate diff` compares the database to the Prisma schema and emits
DROPs for anything the schema cannot express. The Phase 5 `voucher_list_index`
migration therefore contained, unnoticed:

```sql
DROP INDEX "account_title_trgm_idx";
DROP INDEX "customer_full_name_trgm_idx";
```

An ad-hoc EXPLAIN script then recreated one of them by hand -- **which masked
the loss**. The Phase 5 search benchmark measured an index the migrations do
not produce. Nothing failed. Nothing warned. The only symptom would have been a
slow customer search in production, months later.

Two fixes, because reviewing generated SQL depends on a human being careful:

1. A `restore_handwritten_objects` migration, idempotent, recreating them.
2. **`tests/schema.int.test.ts`** -- 15 tests asserting that every object the
   Prisma schema cannot express still exists: the trigram indexes (and that
   they are still GIN), the partial indexes (by name, not by count), the
   balanced-voucher trigger (and that it is still DEFERRABLE and still
   ENABLED), the four-eyes trigger, the CHECK constraints, the
   available-balance view, the partitioning strategy, and that nothing has
   landed in the DEFAULT partition.

The general lesson: **if your schema tool cannot express something, it will
eventually try to delete it.** Either keep everything in the tool, or test that
what it cannot express is still there.

### 4.2 "Check then act" is not idempotency

The audit worker did a read-then-write existence check and called itself
idempotent. An integration test proved otherwise: two redeliveries at
concurrency 10 both passed the check and both inserted.

Under at-least-once delivery that is not a rare race -- it is the expected
behaviour under load.

Fixed with a UNIQUE constraint. The insert IS the check; a duplicate raises
P2002 and the consumer treats it as success, because the work was already done.
Same approach the ledger and the AML worker already used.

I had written a comment defending the read-then-write version. The comment was
wrong and is now replaced by one explaining why.

### 4.3 BullMQ rejects `:` in a custom job id

```
Custom Id cannot contain :
```

`:` is BullMQ's Redis key separator. My idempotency key was
`${queue}:${outboxId}`.

Worth noting how it surfaced: the relay handled it **correctly** -- events went
to FAILED with that message, backoff applied, nothing was lost -- but the
pipeline published nothing until it was fixed. Good failure handling made a
bug quiet, which is its own lesson about needing the oldest-pending-age metric.

### 4.4 BullMQ 6 removed `repeat` from job options

Repeatable jobs are now `upsertJobScheduler(id, { pattern }, template)`. The
scheduler id is the unit of idempotency, so every worker can register the same
schedule at startup and one series results. The old API also required a
repeatable job to avoid a fixed jobId, or every occurrence collided with the
first and it ran exactly once -- the new API removes that footgun.

Installing BullMQ also bumped ioredis 5 -> 6. The Phase 6 cache tests were run
immediately to confirm nothing broke; 15/15 still green.

---

## 5. Verified behaviour

**17 unit + 88 integration** tests, all green (up from 61).

New in Phase 7: 12 queue tests + 15 schema-guard tests.

```
outbox relay
  publishes a pending event and marks it SENT
  fans one voucher event out to three queues
  leaves a pending event alone when it is not yet available
  reports the oldest unsent age -- the metric that catches a stopped relay

retry, backoff and the dead-letter queue
  retries a failing job and then writes a dead letter to Postgres
  succeeds on a later attempt when the failure was transient
  replays a dead letter exactly once

at-least-once delivery and idempotent consumers
  a redelivered event does not write the audit row twice

queue observability
  reports depth per queue -- the autoscaling and alerting signal

maintenance jobs
  creates partitions ahead of time and is idempotent
  purges outbox rows that were sent long ago
  does not purge a recently sent row
```

Dead letters from the run, including a replayed one:

```
 queue_name | job_name | attempts |            error                       | replayed
------------+----------+----------+----------------------------------------+----------
 events     | probe    |        5 | SIMULATED failure                      | t
 events     | probe    |        3 | SIMULATED permanent downstream failure | f
```

---

## 6. What can fail

| Failure | Response |
|---|---|
| Worker not running | Events sit PENDING in Postgres. Durable. Proven by posting with the worker stopped. |
| Worker dies mid-job | Job is redelivered; consumers are idempotent |
| Relay dies after publishing, before marking SENT | Row republished; BullMQ dedups on job id, consumers dedup independently |
| Relay stops entirely | Queue looks EMPTY and healthy -- which is why `oldestPendingAgeSeconds` exists and is the thing to alert on |
| A poison event | Row-level exponential backoff capped at 5 min, so one bad row cannot starve the healthy ones behind it |
| A job fails permanently | 5 attempts, then a dead letter in Postgres with the full stack |
| Dead letter needs rerunning | `replayDeadLetter`, once, with a new job id |
| Queue Redis down | Producers fail loudly (`noeviction`), events stay PENDING and are retried. No silent loss. |
| Queue Redis out of memory | Write error, not eviction |
| Three relays running | `SKIP LOCKED` -- 3x throughput, no contention |
| Duplicate AML evaluation | `dedupe_key` unique constraint |
| Duplicate audit delivery | `(entity_id, action, request_id)` unique constraint |
| Running out of partitions | Maintenance job runs two quarters ahead; DEFAULT partition catches strays; schema test asserts it is empty |
| Outbox table growing | Sent rows purged after 48h; the durable history is `audit_event` |

### Honest gaps at the end of Phase 7

1. **`invalidateBusinessDate` still has no caller.** Day-begin and day-end
   endpoints do not exist yet, so the 60-second TTL from Phase 6 is still the
   only mechanism. Carried from Phase 6, still open.
2. **The AML alert workflow is data only.** No triage API, no assignment, no
   STR generation. The Phase 1 direction scoped this as a slice, and it is one.
3. **The notification worker simulates the gateway.** Deliberate, and labelled
   as such everywhere -- the engineering being demonstrated is the retry/DLQ
   behaviour around an unreliable dependency, not a provider SDK.
4. **No SQS adapter.** The `JobQueue` interface exists so it is one file; it is
   not written.
5. **Queue depth is not yet a metric or an autoscaling signal** -- `queueDepths()`
   exists and is tested, but nothing scrapes it. Phase 9.
6. **No dead-letter API or UI.** `replayDeadLetter` is a function an operator
   can only reach through a script.
7. **The relay polls.** Postgres logical decoding would remove the interval, at
   the cost of a replication slot that pins WAL if it stops being consumed.
   Named as the next step, not built.

---

## 7. Interview questions this phase should let you answer

1. Walk me through what happens between a voucher posting and an SMS arriving.
2. Why is the outbox event written in the same transaction as the balance
   update? What breaks with each of the two obvious alternatives?
3. What does `FOR UPDATE SKIP LOCKED` buy you, and what happens without it?
4. Your delivery is at-least-once. How do you get exactly-once?
5. Your relay publishes then marks SENT. Why that order and not the reverse?
6. Why two Redis instances? What are the settings, and what goes wrong if you
   share one?
7. Why exponential backoff rather than a fixed retry interval?
8. Why is the dead-letter queue in Postgres rather than Redis?
9. Why does a replayed dead letter get a new job id?
10. Your relay stops. Queue depth is zero and every dashboard is green. How do
    you find out?
11. You cached the AML rules but not the transaction aggregates. Why the
    difference?
12. Why are AML rules versioned?
13. An audit event is delivered twice. What stops a duplicate row -- and what
    was wrong with the first version?
14. Why are the purges repeatable queue jobs rather than a `setInterval` in the
    API?
15. What happens if you run out of table partitions? How far ahead do you
    create them, and why that far?
16. How does a worker's log line end up with the same request id as the API
    call that caused it?

---

## 8. Next

**Phase 8 -- load balancing and horizontal scale.** Run three API instances
behind nginx, prove the API is genuinely stateless by killing one mid-session,
show that sticky sessions are not needed, and demonstrate that the relay's
`SKIP LOCKED` really does let multiple nodes share the outbox without
contention. Health checks, round robin, connection handling, and what actually
has to change to add a node.
