# Phase 15 -- System Design at Scale

Status: complete.

This phase could easily have been an essay about sharding. Instead it measured
the path that actually matters for a ledger -- the WRITE path -- for the first
time, and found that it sustains **5 to 6 postings per second**, that the limit
is a lock rather than a resource, and that the biggest cost of a posting is not
the posting.

Every number below was measured. Where a measurement contradicted the intended
conclusion, the measurement is what is reported.

---

## 1. What we did

1. Built a write-path load generator (`scripts/load-post.mjs`) with a `spread`
   and a `hot` mode, reporting errors by CODE rather than by count.
2. Measured posting throughput, found the serialisation point, and proved it
   with `pg_locks`.
3. Replaced an O(total vouchers) scan in the critical section with an O(1)
   counter.
4. Measured whether the serialisation partitions by branch -- the question that
   decides whether this design reaches 100 branches.
5. Found that a posting burst starved the unrelated read path, and traced it to
   downstream AML work.
6. Found that nginx had been silently serving three upstreams from two nodes.
7. Built a capacity model from the measured numbers and worked out what 10x and
   100x actually require.

---

## 2. The write path, measured

The load generator posts balanced two-line TRANSFER vouchers of 1.00, each with
a fresh idempotency key, across several operators.

The first run measured the wrong thing, which is worth recording:

```
c=1   posts/s=5     <- 5 operators x 60/min rate limit = 5/s. Exactly.
```

The posting rate limit is 60/minute per operator -- a **product control** from
Phase 6, not a capacity limit. Leaving it on while measuring throughput measures
the limiter. `RATE_LIMIT_ENABLED` is now overridable in compose for exactly this.

With it off:

| concurrency | posts/sec | p50 | p99 | errors |
|---|---|---|---|---|
| 1 | 5 | 162ms | 504ms | 0 |
| 4 | 3 | 1,027ms | 3,771ms | 0 |
| 8 | 3 | 2,379ms | 5,141ms | 1 INTERNAL_ERROR |
| 16 | 4 | 2,617ms | 4,974ms | 12 INTERNAL_ERROR |

Read that table again. **Throughput does not rise with concurrency at all** --
it stays at 3-5 -- while latency rises almost exactly linearly. That is the
signature of a fully serialised resource: the queue grows, the service rate does
not.

The `INTERNAL_ERROR`s are the second-order effect:

```
Transaction already closed: A query cannot be executed on an expired
transaction. The timeout for this transaction was 5000 ms, however 6279 ms
passed since the start of the transaction.
```

Postings were waiting so long for the lock that they exceeded the 5-second
transaction timeout while still queued.

---

## 3. Where the serialisation is, proved

`nextVoucherNumber` took a `pg_advisory_xact_lock(branchCode, YYYYMMDD)` --
transaction-scoped, so held until COMMIT. Acquired partway through the posting
transaction, released only when the whole posting finishes.

Direct evidence, sampled during concurrent posting:

```
wait_event_type | wait_event    | count
----------------+---------------+------
Lock            | transactionid |     4
LWLock          | WALWrite      |     2
IO              | WALSync       |     1

locktype      | rel              | mode             | granted | count
--------------+------------------+------------------+---------+------
transactionid |                  | ExclusiveLock    | t       |    10
relation      | voucher_sequence | RowExclusiveLock | t       |     5
transactionid |                  | ShareLock        | f       |     4   <- waiters
tuple         | voucher_sequence | ExclusiveLock    | t       |     1
```

Four sessions blocked on another transaction's id, queued behind one holder.

### Why a gapless number forces this

**Problem.** The voucher number must reset daily and be gapless within the day.
An auditor treats a missing voucher number as a missing voucher.

| Option | Why not |
|---|---|
| Postgres `SEQUENCE` | `nextval` is non-transactional. A rolled-back voucher burns its number permanently -- gaps |
| Application-side counter | Same serialisation, plus a cache to keep consistent |
| Block allocation per teller | Concurrent, but produces gaps when a block is not fully used |
| Counter inside the transaction | Gapless, rolls back with the voucher -- and SERIALISES |

There is no fourth option, and this is worth saying plainly in an interview:
**gapless numbering and concurrent insertion are in direct conflict.** You can
have a gapless sequence, or you can have parallel postings, and any design that
appears to offer both has moved the number out of the transaction.

The current system chose gapless. That is defensible for a ledger. What is NOT
defensible is how much work was inside the critical section.

---

## 4. Fix 1: an O(1) counter instead of a growing scan

The old query:

```sql
SELECT COALESCE(MAX(SUBSTRING(voucher_number FROM n)::int), 0) + 1
  FROM voucher WHERE voucher_number LIKE 'V101-20260922-%'
```

A btree CAN serve a prefix `LIKE` as a range scan -- but only under the C
collation or with `varchar_pattern_ops`. This database has neither. Measured at
200,439 vouchers:

```
Parallel Index Only Scan using voucher_voucher_number_key
  Filter: (voucher_number ~~ 'V101-20260922-%')
  Rows Removed by Filter: 66,813      (per worker, x3 = the entire table)
Execution Time: 19.699 ms
```

**19.7ms, growing linearly with every voucher the bank has ever posted, executed
while holding the lock that serialises everything.** The system got slower every
day and no code changed.

Replaced with a `voucher_sequence (branch_id, entry_date, last_seq)` table and
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. The row lock provides the same
mutual exclusion, so the advisory lock was removed rather than duplicated, and
gaplessness still comes from running inside the posting transaction.

| concurrency | before | after |
|---|---|---|
| 4 | 3/s, p50 1,027ms | **6/s, p50 589ms** |
| 8 | 3/s, p50 2,379ms | **5/s, p50 1,188ms** |

Real, and modest. Which raised the obvious question: if a 19.7ms scan was not
the main cost, what is?

---

## 5. The answer: 21.6 database round trips per posting

From the metrics of one node during a posting run:

```
postings on this node     : 36
total DB operations       : 779
DB operations PER POSTING : 21.6
DB time per posting       : 663ms
HTTP time per posting     : 712ms
=> 663ms / 21.6 ops = 30.7ms per round trip (under contention)
```

At concurrency 1, where there is no contention: 212ms / 21.6 = **~10ms per round
trip**, and 21.6 x 10ms = 216ms. The single-posting latency is not one slow
query. It is **twenty-one sequential conversations** with the database, each
paying Prisma engine IPC, pgBouncer and network.

That is the shape of the problem:

```
posting latency  ~= round trips x RTT
posting throughput ~= 1 / (serialised portion of that)
```

Neither term is a resource limit. Nothing was saturated -- Postgres sat at 9%
CPU while this was happening.

**The lever with the most room is round-trip count**, and it is an application
design question, not a database one: the balance reads, line inserts and balance
updates are issued one at a time where a single statement with a CTE, or one
`UPDATE ... FROM (VALUES ...)`, would do the same work in one trip.

---

## 6. Does the serialisation partition by branch?

This is the question that decides whether the design reaches 100 branches,
because the lock key is `(branch, date)`.

Measured, with a second branch given 40 funded test accounts:

```
branch 101 alone     : 4 posts/s
branch 102 alone     : 7 posts/s
both concurrently    : 4 + 4 = 8 posts/s
```

Branch 101's own rate did not move when branch 102 started posting (4 -> 4), and
total throughput went from 4 to 8. The branches do not block each other.

**So the ledger scales by BRANCH, not by node.** That matters more than it
sounds: it means throughput grows with the number of branches -- which is
exactly how a bank grows -- and it means a single very busy branch is the shape
that hurts, not a busy bank.

Honest caveat: branch 102 fell from 7/s to 4/s when both ran. They do not
contend on the lock, but they do contend for CPU, WAL and the connection pool.
Partitioned locking removes one wall; it does not create capacity.

---

## 7. The hot account, and why it measured nothing

`hot` mode makes every voucher credit the same account -- a cash GL, a suspense
account. That is the classic ledger scaling wall: every concurrent posting wants
one balance row.

```
spread  c=4  6 posts/s    hot  c=4  5 posts/s
spread  c=8  6 posts/s    hot  c=8  7 posts/s
```

**No difference.** Not because hot accounts are harmless, but because the
voucher-number lock already serialises the entire branch upstream of the balance
locks. A second queue behind a closed door adds no waiting.

This is a general lesson worth keeping: **you cannot see the second bottleneck
until you remove the first.** Anyone who measured this system and concluded "hot
accounts are not a problem for us" would be measuring the numbering lock and
calling it a balance result. Remove the numbering serialisation and this
experiment will produce a completely different number.

---

## 8. The most expensive part of a posting is not the posting

After a burst of ~2,000 postings, the unrelated READ path collapsed. The stack
looked healthy. Postgres did not:

```
ledgercore-postgres   594.41%      <- six cores
ledgercore-worker-1    49.78%
ledgercore-api-1        1.22%      <- the API is idle
```

Everything running in Postgres was the same query:

```sql
SELECT COALESCE(SUM(vl.amount), 0)::text ...
```

The AML screening job. **Every posting enqueues AML work, and that work is a
windowed aggregation.** The write path's real cost is not its own transaction;
it is the downstream work each posting creates.

And the aggregation had a bug with an instructive comment above it:

> Bounded by `post_date`, so the partition pruning from Phase 5 applies -- a
> 30-day window reads one partition, not the whole ledger.

True of `voucher_line`, which IS range partitioned and did prune. **False of the
`voucher` it joins to**, which is not partitioned and carried no date predicate
at all:

```
Parallel Seq Scan on voucher v
  Filter: (status = 'POSTED')
  actual rows=67374 loops=3        -- 202,122 rows: the whole table
```

One full table scan per posting.

### The fix, and an honest negative result

Added `AND v.post_date BETWEEN ...` plus a partial index
`voucher_posted_post_date_idx ON voucher (post_date) WHERE status = 'POSTED'`.
The plan changed as intended -- `Bitmap Index Scan`, voucher rows touched
dropped from 202,122 to 20,907.

The runtime did not change:

```
OLD  Execution Time: 61.055 ms   Buffers: shared hit=7711   seq-scan-on-voucher=1
NEW  Execution Time: 61.417 ms   Buffers: shared hit=8062   seq-scan-on-voucher=0
```

**No improvement today, and slightly more buffers.** At 200k total vouchers with
20k in the window, a sequential scan of a cached table is simply not worse than a
bitmap scan. The change is still right -- it converts a cost that grows with
TOTAL HISTORY into one that grows with the WINDOW -- but claiming it as a
performance win would be a lie. At 2M vouchers with the same 30-day window the
old plan reads 10x more and the new one reads the same; that is the argument,
and it is a projection, not a measurement.

---

## 9. nginx had been serving three upstreams from two nodes

While chasing the read-path numbers, the load generator's own distribution
report gave it away:

```
api-1   3641   50.0%
api-3   3644   50.0%
api-2      0    0.0%
```

api-2 sat at 8% CPU while the other two ran at 120%.

```
nginx was sending to   172.20.0.8 / .9 / .10
api-2's actual address 172.20.0.6
```

**nginx OSS resolves upstream hostnames once, at startup or reload, and caches
them forever.** `docker compose restart` keeps a container's IP -- which is why
the Phase 13 rolling deploy was safe. `docker compose up -d --force-recreate`,
which is what a real image rollout does, assigns a NEW one. nginx kept the old
address, 8 requests failed, `max_fails` marked the node down, and a third of the
fleet was gone. No errors. No alert. Just less capacity.

A reload restored a clean 33/33/33 split.

There is no good fix inside nginx OSS: `resolve` on a server directive is an
nginx Plus feature, and moving the address into a variable to force per-request
DNS abandons the upstream block -- losing round robin, keepalive and passive
health checks. So the fix is operational (reload after replacing a node) and it
is a concrete argument for the Phase 11 ALB design, where a replaced task is a
registration event rather than a stale cache entry.

### A measurement honesty note

The read path measured 849 rps in Phase 14 and ~420 in this session's quiet
state, and the stale-DNS bug turned out NOT to explain it: after the reload
restored all three nodes, throughput was 344 rps, not 849.

The evidence points at the host rather than the code. nginx's configuration did
not change at all, yet it burned 31% CPU for 344 rps here against 41.9% for
1,064 rps in Phase 14 -- roughly four times less work per CPU-percent, in a
component that was not touched. After many hours of sustained load on a 6-core
laptop also running Windows, Docker Desktop and an unrelated Supabase stack, the
machine is simply delivering less.

**Conclusion: same-session A/B comparisons in these documents are valid;
cross-phase absolute numbers are not.** That limitation was flagged in Phase 14
and this is what it looks like in practice.

---

## 10. What CI caught that local testing could not

The voucher counter shipped with `VALUES (..., 1)` -- start at 1 if no row
exists. The migration backfills from numbers already issued, so every local test
passed.

CI, which builds a database from nothing every run:

```
Unique constraint failed on the fields: (voucher_number)
  at tx.voucher.create() in posting.service.ts:295
```

A database created AFTER the migration gets its vouchers from the seed script,
which writes `voucher_number` directly. The counter knew nothing about them,
started at 1, and collided on the first posting.

The fix makes the row self-initialise from `MAX(...)` -- the O(n) scan the
counter exists to avoid, but now once per branch per day instead of once per
posting, and self-healing for any voucher written outside the function: a seed, a
data fix, a restore.

This is the second time in three phases that CI caught a defect whose only
symptom was "works on the machine where the data already existed".

---

## 11. Capacity model

Building this from measured numbers, with every assumption labelled.

**Measured:**

- 5-6 postings/sec per branch, serialised
- ~21.6 DB round trips per posting, ~10ms each uncontended
- Branches do not contend with each other on the numbering lock
- Each posting enqueues AML work costing ~61ms of database time

**Assumption (not measured -- a plausible co-operative bank):** a branch handles
2,000 postings on a working day, over 6 banking hours, with a 4x peak in the
first and last hour.

**Calculated from those two:**

```
average         2000 / (6 x 3600)          = 0.09 postings/sec
peak (4x)                                  = 0.37 postings/sec
measured capacity per branch               = 5-6 postings/sec
headroom at peak                           ~ 15x
```

So for one branch the current system is not close to its limit. The design
question is what happens as branches multiply.

| Scale | Postings/sec (peak, calculated) | What gives first |
|---|---|---|
| 1 branch | 0.4 | nothing -- 15x headroom |
| 10 branches | 4 | nothing on the lock (per-branch); AML at ~4 x 61ms = 24% of one core |
| 100 branches | 37 | **AML screening**: 37 x 61ms = 2.3 cores of pure aggregation, continuous, plus 37 x 21.6 = 800 DB round trips/sec |
| 1,000 branches | 370 | the database, comprehensively |

The first thing to break is NOT the posting lock. It is the asynchronous work
each posting creates -- which is exactly what the 594% CPU episode was, in
miniature.

### What each step would actually require

**To 10x (about 40 postings/sec):**

1. **Cut round trips.** 21.6 to ~6 by batching the balance reads, line inserts
   and balance updates into set-based statements. This is the single largest
   lever and needs no new infrastructure.
2. **Make AML cheaper per event.** Maintain rolling aggregates incrementally --
   a `customer_window_total` row updated by the posting's own outbox event --
   instead of recomputing a 30-day sum from scratch for every voucher. Turns
   O(window) per posting into O(1).
3. **Read replica for reporting.** Statement lookups, voucher lists and AML case
   review are all point-in-time reads that tolerate replication lag. Balance
   reads on the posting path must NOT go to a replica: reading a stale balance
   to decide a debit is a correctness bug, not a performance trade. This is the
   same argument Phase 11 used to refuse a read replica, now with a boundary.

**To 100x (about 400 postings/sec):**

4. **Decouple the human-facing voucher number from the transaction.** This is
   the only way past the gapless-versus-concurrent conflict. The voucher gets
   its UUID and posts immediately; a single-threaded assigner walks committed
   vouchers in commit order and stamps the gapless number within seconds.
   Auditors get their gapless sequence; the posting path stops serialising. The
   cost is that the number is not available in the response -- a genuine UX and
   integration change, which is why it is a 100x decision and not a 10x one.
5. **Partition by branch, then shard by branch.** `voucher` and `voucher_line`
   already partition by date; adding branch gives a shard key that matches the
   access pattern, because a branch's postings only ever touch that branch's
   accounts. Inter-branch transfers become the exception that needs two-phase
   handling -- which is precisely the modular-monolith boundary Phase 2 drew.
6. **Separate the AML fleet.** It is read-heavy, latency-tolerant and bursty --
   the opposite of the posting path. It should run against a replica with its
   own connection pool, so an AML backlog cannot starve postings. **That is the
   specific failure this phase observed**, and the fix is isolation, not
   optimisation.

### The sharding trigger

Not "when the data is big". The trigger is when a **single branch's** posting
rate approaches the serialised ceiling, or when the write volume exceeds what
one primary can absorb. Until then sharding adds a distributed transaction to
every inter-branch transfer -- paying the cost of a distributed system for a
problem that is not distributed yet.

---

## 12. Extracting a module into a service

Phase 2 chose a modular monolith and promised to show how a module could be
extracted. AML is the one that has now EARNED extraction, on evidence rather
than taste:

- It is the component that starved the database (594% CPU).
- It scales on a different axis: queue depth, not request rate.
- It is latency-tolerant -- an alert raised two seconds later is the same alert.
- It already communicates only through the outbox, never by calling into the
  ledger.

The extraction is therefore mostly deployment, not rewriting:

```
now      one image, `node dist/worker.js`, same database, same pool
step 1   its own connection pool and pgBouncer database entry
         -> an AML backlog can no longer exhaust the posting path's connections
step 2   point it at a read replica
         -> its aggregations stop competing with postings for the primary
step 3   its own service and repository, consuming the same outbox events
         -> independent deploy and scale; the contract is already the event
```

Each step is independently reversible and each removes a specific, measured
coupling. Nothing about it requires a rewrite, which is the payoff of having
drawn the module boundary before it was needed.

The modules that should NOT be extracted: ledger and identity. A posting needs
the account, the balance, the business date and the limits in ONE transaction. A
service boundary there converts a row lock into a distributed transaction -- the
exact trade Phase 2 refused, and nothing measured since has changed it.

---

## 13. What can fail

- **Measuring through a rate limiter.** The first write-path number was
  5/s, which was the limiter, not the ledger.
- **Concluding from one concurrency point.** Throughput flat across concurrency
  while latency rises linearly means serialisation, and a single data point
  cannot show that.
- **A second bottleneck hidden behind a first.** The hot-account experiment
  measured nothing because the numbering lock dominated.
- **An expensive critical section.** Serialisation is survivable; serialisation
  around growing work is not.
- **Asynchronous work with no budget.** Each posting enqueued a job with an
  unbounded aggregation. The synchronous path looked fine.
- **A comment that is true of one table in a join.** The partition-pruning
  comment was correct about `voucher_line` and wrong about the query.
- **A load balancer caching DNS.** A third of capacity, silently, with no error.
- **A counter that assumes it was there first.** Correct on every migrated
  database, broken on every new one.

---

## 14. How to debug it

```bash
# Write path -- and turn the rate limiter off, or you measure the limiter
RATE_LIMIT_ENABLED=false docker compose --profile scale up -d --force-recreate api-1 api-2 api-3
docker exec ledgercore-nginx nginx -s reload      # ALWAYS after --force-recreate
node scripts/load-post.mjs http://localhost:8080 accounts.json spread 8 20000
node scripts/load-post.mjs http://localhost:8080 accounts.json hot    8 20000

# Is it serialised? Throughput flat + latency linear in concurrency = yes.
# Then find out on what:
docker exec ledgercore-postgres psql -U ledgercore -d ledgercore -c "
  select wait_event_type, wait_event, count(*) from pg_stat_activity
   where datname='ledgercore' and state='active' group by 1,2 order by 3 desc;"
docker exec ledgercore-postgres psql -U ledgercore -d ledgercore -c "
  select locktype, relation::regclass, mode, granted, count(*)
    from pg_locks group by 1,2,3,4 order by 5 desc;"

# Round trips per request
... /metrics | grep db_query_duration_seconds_count     # sum / http count

# Who is actually burning the database
docker exec ledgercore-postgres psql -U ledgercore -d ledgercore -c "
  select pid, backend_type, state, left(query,60) from pg_stat_activity
   where state='active';"

# Is the load balancer even using every node?
node scripts/load.mjs http://localhost:8080 x 20 15000   # check `distribution`
docker logs ledgercore-nginx | grep -oE 'upstream=[0-9.]+' | sort | uniq -c
for n in 1 2 3; do docker inspect ledgercore-api-$n -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'; done
```

**Test data note.** The per-branch experiment created 40 funded accounts in
branch 102, named `P15-102-*`. To remove them:

```sql
DELETE FROM account_balance WHERE account_id IN
  (SELECT id FROM account WHERE account_number LIKE 'P15-102-%');
DELETE FROM account WHERE account_number LIKE 'P15-102-%';
```

They are attached to one existing customer, which inflates that customer's AML
window -- worth knowing before quoting an AML timing from this database.

---

## 15. Interview questions

**Q1. How many transactions per second does your system handle?**
Reads, about 850 per second per three nodes when the machine is fresh, and the
bottleneck there is the load generator rather than the API. Writes are the
interesting number: **5 to 6 postings per second per branch**, and it does not
improve with concurrency -- throughput stays flat while latency rises linearly,
which is the signature of a fully serialised resource. Per branch matters,
because the serialisation partitions by branch: I measured two branches posting
concurrently and total throughput doubled while neither slowed the other.

**Q2. What serialises it?**
The voucher number. It has to reset daily and be gapless, because an auditor
treats a missing number as a missing voucher. Gapless means the number must be
allocated inside the posting transaction so it rolls back with a failed voucher
-- and that makes it a single point every posting in the branch passes through,
with the lock held until COMMIT. I confirmed it in `pg_locks`: four sessions
blocked on `transactionid` behind one holder of the `voucher_sequence` row.

**Q3. So how would you make posting concurrent?**
You cannot, while the gapless number is allocated in the transaction -- those
two requirements are in direct conflict. The way out is to stop allocating it
there: the voucher gets its UUID and posts immediately, and a single-threaded
assigner stamps the gapless human-facing number from the commit order a moment
later. Auditors still get a gapless sequence. The price is that the number is
not in the API response any more, which is a real integration change, and that
is why it is a 100x decision rather than a 10x one.

**Q4. You found a 19.7ms scan inside that lock. Did fixing it help much?**
Some -- concurrency 4 went from 3 to 6 postings a second and latency halved --
but much less than I expected, and that is the useful part. It told me the
19.7ms was not the main cost. The main cost is that one posting makes **21.6
sequential database round trips**, about 10ms each. Latency is round trips times
RTT, and the throughput ceiling is one over the serialised part of that. Nothing
was saturated: Postgres was at 9% CPU. That is why the biggest remaining lever
is batching the statements, not tuning the database.

**Q5. What breaks first if traffic goes up 100x?**
Not the posting lock -- that partitions by branch, and branch count is how a
bank grows. It is the asynchronous work each posting creates. AML screening runs
a windowed aggregation per voucher, and I watched a burst of two thousand
postings push Postgres to 594% CPU and drag the unrelated read path from 849 to
176 requests a second. The API was idle the whole time. At 100 branches that
aggregation alone is a couple of cores running continuously.

**Q6. And the fix for that?**
Three things, in order. Make the aggregate incremental -- keep a rolling total
per customer updated by the posting's own event, instead of recomputing thirty
days of history for every voucher. Give AML its own connection pool, so a
backlog cannot exhaust the pool the posting path needs. Then point it at a read
replica. The third is the cheapest to say and the least important: isolation
matters more than speed here, because the failure I actually observed was
starvation, not slowness.

**Q7. Would you add a read replica?**
For reporting, statement lookups and AML review, yes -- all of those tolerate
replication lag. For the posting path, no, and this is a correctness argument
rather than a preference: reading a stale balance to decide whether a debit is
allowed is a wrong answer, not a slow one. So the replica is defined by which
QUERIES go to it, not by which service asks.

**Q8. When would you shard?**
When a single branch's posting rate approaches the serialised ceiling, or when
write volume exceeds one primary. Not when the data gets big -- big data on one
primary is a partitioning and archiving problem, and the tables are already
range partitioned by date. Sharding earlier means every inter-branch transfer
becomes a distributed transaction, which is paying the cost of a distributed
system before you have a distributed problem. When it does come, the shard key
is the branch, because a branch's postings only touch that branch's accounts.

**Q9. Your Phase 2 decision was a modular monolith. Has anything changed?**
One module has earned extraction on evidence: AML. It scales on queue depth
rather than request rate, it is latency-tolerant, it already communicates only
through outbox events, and it is the thing that starved the database. Extraction
is three reversible steps -- its own pool, then a replica, then its own
deployment -- and none of them is a rewrite, because the boundary was drawn
before it was needed. Ledger and identity stay together: a posting needs the
account, balance, business date and limits in one transaction, and a service
boundary there turns a row lock into a distributed transaction.

**Q10. Tell me about a measurement that surprised you.**
The hot-account test. Every concurrent posting crediting the same cash GL is the
classic ledger wall, and it measured **nothing** -- 5-7 postings a second either
way. Not because hot accounts are fine, but because the numbering lock already
serialised the whole branch upstream of the balance locks, so a second queue
behind a closed door adds no waiting. If I had shipped that as "hot accounts are
not a problem for us" I would have been quoting the numbering lock and calling
it a balance result. You cannot see the second bottleneck until you remove the
first.

**Q11. Tell me about a fix that did not work.**
The AML query was seq scanning all 200,000 vouchers per posting, because the
date bound was on `voucher_line`, which is partitioned, and not on the `voucher`
it joins to. I added the predicate and a partial index. The plan changed exactly
as intended -- bitmap index scan, voucher rows touched down from 202,122 to
20,907 -- and the runtime did not move: 61.0ms to 61.4ms, with slightly more
buffers. At this data size, scanning a cached table is simply not worse. I kept
the change, because it converts a cost that grows with total history into one
that grows with the window, but reporting it as a performance win would have
been false.

**Q12. Anything embarrassing?**
Yes. For part of this session nginx was serving three upstreams from two nodes.
`--force-recreate` gives a container a new IP, and nginx OSS resolves upstream
hostnames once at startup and caches them forever -- eight requests failed,
`max_fails` marked the node down, and a third of capacity disappeared with no
error and no alert. The only visible symptom was one node at 8% CPU while the
others ran at 120%. I found it because the load generator reports which instance
served each request. It is also the cleanest argument I have for a load balancer
with real service discovery instead of a static upstream list.

---

## 16. Honest gaps

- **The 10x and 100x figures are calculated projections**, not load tests. The
  measured inputs are real; the branch volumes are a stated assumption.
- **Round-trip batching was identified, not implemented.** It is the largest
  lever and it is future work.
- **Incremental AML aggregates were designed, not built.**
- **No replica, no shard, no extracted service was actually built.** This phase
  established the triggers and the order; it did not execute them.
- **The write-path numbers come from a machine whose absolute performance
  drifted during the session** (section 9). Ratios and A/B comparisons within a
  run are sound; absolute postings/sec is a floor, not a capacity rating.
- **Branch 102's account pool is synthetic** and attached to one customer, which
  inflates that customer's AML window.
- **Only the TRANSFER posting path was measured.** Reversals, approvals and
  batch operations were not.

---

## 17. Measured summary

| Metric | Value |
|---|---|
| Write throughput | **5-6 postings/sec per branch**, flat across concurrency |
| Latency at c=16 (before fix) | p50 2,617ms |
| DB round trips per posting | **21.6** |
| Per round trip, uncontended | ~10ms |
| Voucher numbering scan (before) | 19.7ms, scanning all 200,439 vouchers |
| Voucher numbering (after) | O(1) counter; c=4 went 3 -> **6 posts/s** |
| Two branches concurrently | 4 + 4 = **8/s**, neither slowed the other |
| Hot account vs spread | **no difference** -- masked by the numbering lock |
| AML burst effect | Postgres **594% CPU**, read path 849 -> 176 rps |
| AML join before | Seq Scan, **202,122** voucher rows per job |
| AML join after | Bitmap Index Scan, **20,907** rows -- same runtime today |
| nginx stale DNS | **1 of 3 nodes** receiving no traffic, silently |
| Tests | 30/30 unit, **100/100** integration |
