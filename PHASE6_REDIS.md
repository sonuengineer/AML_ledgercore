# Phase 6 -- Redis

> Built and verified 2026-09-22. Step 2 of the three-step topology begins here:
> React -> Node API -> **Redis** -> PostgreSQL. The queue and workers are
> Phase 7.

---

## 1. What we built

```
  src/shared/cache/redis.ts        client, degradation, health
  src/shared/cache/cacheAside.ts   cache-aside + stampede protection + invalidation
  src/shared/cache/lock.ts         distributed lock, fencing tokens
  src/middleware/rateLimit.ts      sliding-window limiter
```

Wired into: role permissions, branch master, business date, the idempotency
fast path, `/auth/login` (per IP), `POST /vouchers` (per user), `/health`,
and the startup/shutdown lifecycle.

`CACHE_ENABLED` is a kill switch. It is also how everything below was measured:
same build, same data, one environment variable.

---

## 2. The measurement

Phases 3 to 5 deliberately left these costs visible so Phase 6 would have a
before/after rather than a claim. 400 requests each, after warm-up.

### `GET /auth/me` -- user + role-permission lookup on every request

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| cache OFF | 26.76 ms | 44.72 ms | 59.77 ms | 77.60 ms |
| cache ON | 9.59 ms | 15.32 ms | 18.80 ms | 19.97 ms |
| **improvement** | **2.8x** | **2.9x** | **3.2x** | **3.9x** |

### `GET /branches/:id/business-date/current`

| | p50 | p95 | p99 | max |
|---|---|---|---|---|
| cache OFF | 20.15 ms | 32.57 ms | 41.47 ms | 80.90 ms |
| cache ON | 11.73 ms | 20.17 ms | 23.45 ms | 27.99 ms |
| **improvement** | **1.7x** | **1.6x** | **1.8x** | **2.9x** |

Hit ratio over the run: **0.998** (1,719 hits, 3 misses).

**The interesting number is not p50, it is max.** 77.6 ms -> 19.97 ms. A cache
does not just make the average faster; it removes the long tail, because the
tail was queries queueing behind each other for connections. That is what a
user actually notices, and it is why p50 alone is a misleading way to report
a cache.

---

## 3. Where the cache IS used, and where it is refused

| Data | TTL | Why it is safe to cache |
|---|---|---|
| Role permissions | 5 min | Read on every authenticated request, changed a few times a year |
| Branch master | 15 min | Read on every posting, changed when a branch opens or is suspended |
| Business date | **60 s** | Read on every posting -- but see below |
| Idempotency record | 1 h | A retry arriving within the hour is a network retry |

**Account balances are never cached. Not at any TTL.**

The balance *is* the product. A stale read can authorise a debit that overdraws
an account, and there is no reconciliation that makes that acceptable after the
fact. Balances are read from Postgres under a row lock at the moment they are
about to change -- `posting.service.ts`. Being able to explain that refusal is
worth more than the latency it costs.

**Voucher drafts are not cached either.** Putting them in Redis would recreate
the legacy system's per-socket conversational state, just distributed. The
client holds the draft; the server sees one complete command.

### Why the business date gets a 60-second TTL, not 300

It is the one cached value where staleness has teeth: it decides which date a
voucher is stamped with, and it changes exactly when day-begin or day-end runs.
A stale entry would let a teller post into a day that just closed.

Three layers, not one: a 60-second TTL bounds it; `invalidateBusinessDate()` on
the day-begin/day-end paths closes it entirely; and the posting transaction
re-reads the status under a lock, so the cache is never the thing that decides.

---

## 4. Failure policy -- and why it differs per component

This is the part worth being able to defend.

| Component | On Redis failure | Why |
|---|---|---|
| Cache | **fail open** -- serve from Postgres | Everything in it is reconstructible. A cache miss is slow, not wrong. |
| Rate limiting | **fail open** -- allow the request | A limiter protects against excess load. Making it a hard dependency means a Redis blip takes down the login page for everyone -- far worse than briefly allowing more requests. |
| Idempotency fast path | **fail open** -- fall through to Postgres | A cache MISS proves nothing. It can only ever short-circuit a hit; it can never authorise a second posting. |
| Distributed lock | **fail CLOSED** -- refuse to start | If Redis is down we cannot know whether another node is already running day-end. Refusing is recoverable; posting interest twice is not. |
| Readiness probe | **ignores Redis entirely** | Failing readiness on a Redis blip pulls every node out of the load balancer at once, turning a degradation into an outage. |

The rule underneath: **fail open when the component is an optimisation, fail
closed when it is a correctness guarantee.**

### Proven, not asserted

Redis was stopped with the API running:

```
before:  {"status":"ready","cache":"available"}
         GET /auth/me -> HTTP 200 in 0.027s

docker stop ledgercore-redis

after:   {"status":"ready","cache":"degraded"}     <- node stays in the LB
         GET /auth/me -> HTTP 200 in 0.037s
         GET /auth/me -> HTTP 200 in 0.036s
         POST /auth/login -> HTTP 200               <- rate limiter failed open

/health: status: healthy
         database: {"status":"up","latencyMs":4}
         cache   : {"status":"down","error":"unavailable -- serving from the database"}
```

Slower. Not broken. And on `docker start`, the client reconnected on its own --
`"cache connected"` appears twice in the log, once per connection.

---

## 5. Implementation notes that matter

### 5.1 ioredis defaults will hang your API

`ioredis` queues commands while disconnected and retries forever. A naive
integration therefore turns a Redis blip into an API-wide hang: requests pile
up waiting on a cache lookup that will never resolve.

```ts
enableOfflineQueue: false,          // fail fast, do not queue
maxRetriesPerRequest: 1,
commandTimeout: 150,                // a slow cache must not become a slow API
retryStrategy: (n) => Math.min(n * 200, 5_000),   // capped backoff
```

And an `'error'` handler is **mandatory**: an unhandled `'error'` event on an
EventEmitter throws, so without one a Redis blip kills the process -- the exact
opposite of the goal.

### 5.2 Cache-aside, not read-through or write-through

- **read-through** needs the cache to know how to load from the database, which
  puts domain queries in the cache layer. Wrong place for that knowledge.
- **write-through** writes to the cache first, so a cache failure becomes a
  WRITE failure. Unacceptable when the cache is allowed to be down.
- **cache-aside** the application owns both sides. A cache failure degrades
  reads and touches writes not at all.

### 5.3 Stampede protection

On a miss for a hot key, N concurrent requests each run the same query. Sharing
one in-flight promise collapses them into a single load. Verified: 20
simultaneous requests for a cold key produce **1** loader call.

It is per-process, so three API nodes cost at most three queries instead of N.
A cross-process lock would reduce that to one, at the cost of a Redis round
trip on every miss and a new failure mode when the lock holder dies. Three
queries is not worth that.

### 5.4 SCAN, never KEYS

`KEYS *` is O(n) and blocks the single-threaded Redis server for the whole
scan. On a large keyspace it is an outage. `invalidatePrefix` uses a SCAN
cursor and yields between batches.

Gotcha found while writing it: the client has `keyPrefix: 'lc:'`, which
`SCAN ... MATCH` does **not** apply automatically, while `DEL` does. So the
pattern must carry the prefix and the delete must strip it.

### 5.5 Dates do not survive JSON

A cached Prisma row comes back with `Date` fields as strings. The uncached path
returns `Date`, the cached path returns `string`, and the difference only
appears after the first request warms the key -- so it passes every test that
starts cold. The cached readers revive them explicitly.

### 5.6 Permissions are keyed by ROLE, not by user

Invalidating one role then invalidates it for every user who holds it, for
free. Keying by user would have needed a reverse index that itself needed
invalidating -- a second cache to keep consistent with the first.

### 5.7 Sliding window, not fixed window

A fixed window ("100 per minute", counter resets on the minute) allows a burst
of 200 across a boundary: 100 at 10:00:59 and 100 at 10:01:00. On a login
endpoint that doubling is exactly what is being defended against.

The whole check is one Lua script -- one round trip, and atomic. Four separate
commands would be four round trips **and** a race, where two concurrent
requests both read a count below the limit and both proceed.

---

## 6. The login gap from Phase 4 is now closed

Phase 4 shipped with a named hole: a per-account lockout stops credential
stuffing against ONE account, but does nothing about **password spraying** --
one common password tried across a thousand staff codes, where no single
account ever reaches its threshold.

Two layers now, catching different attacks:

```
22 failed logins from one IP (limit 20 per 15 min):
  attempt 1  -> HTTP 401   remaining=19
  attempt 2  -> HTTP 401   remaining=18
  attempt 19 -> HTTP 401   remaining=1
  attempt 20 -> HTTP 401   remaining=0
  attempt 21 -> HTTP 429   <- per-IP limit (catches spraying)
  attempt 22 -> HTTP 429

and the account itself:
  O001 | LOCKED | failed=5   <- per-account lockout (catches stuffing)
```

**Successful logins do not consume budget**, so a real teller is never
throttled while an attacker -- who only ever fails -- is:

```
  success 1 -> HTTP 200  remaining=19
  success 5 -> HTTP 200  remaining=19
```

Posting is limited **per user, not per IP**: a branch sits behind one NAT
address, so an IP limit would throttle everyone because one teller is fast.

---

## 7. The distributed lock, and what it is NOT

A TTL-based lock is not safe against a process that pauses past its TTL. A long
GC or a suspended VM leaves the holder believing it still owns a lock that has
expired and been taken by someone else. That is the well-known limitation of
every TTL lock, Redlock included, and pretending otherwise is how people ship
double-posted interest.

Two mitigations, both implemented:

1. **A fencing token** -- a monotonically increasing number handed out with the
   lock. A resource that accepts a token only if it exceeds the last one it saw
   rejects a stale holder's write even if that holder still thinks it owns the
   lock. Verified monotonic in the tests.
2. **For day-end, the real guard is in Postgres**: `pg_advisory_xact_lock` plus
   the business-date status transition, both inside the transaction that does
   the work. The Redis lock is the cheap first line that avoids a database
   round trip; the database is the line that is actually authoritative.

Release uses a Lua compare-and-delete. GET-then-DEL is a race: the lock can
expire and be re-acquired between the two commands, and the DEL then frees
*somebody else's* lock. Verified: a forged handle with the wrong token cannot
release, and the real owner still holds it.

---

## 8. Verified behaviour

**17 unit + 61 integration tests**, all green (up from 46 -- 15 new cache/lock
tests). `typecheck` clean, `build` clean.

The 15 new tests assert properties, not plumbing:

```
cache-aside
  is actually connected (otherwise every test below is vacuous)
  loads on a miss and serves the next read from the cache
  collapses concurrent misses into a single load        <- 20 requests, 1 load
  invalidation removes the entry so the next read reloads
  honours a TTL
  invalidates a whole prefix with SCAN, not KEYS
  survives a corrupt entry by discarding and reloading
  bypass skips the cache entirely
  counts hits and misses so the hit ratio can be reported
  builds keys through one place, so invalidation cannot miss a spelling

distributed lock
  is mutually exclusive
  hands out monotonically increasing fencing tokens
  refuses to release a lock it does not own
  releases even when the work throws
  serialises concurrent attempts: exactly one runs      <- 5 nodes, 1 runs
```

---

## 9. What can fail

| Failure | Response |
|---|---|
| Redis down | Cache and rate limiting fail open; lock fails closed; readiness stays green; API is slower, not broken. Proven by stopping the container. |
| Redis slow | 150 ms command timeout, then the database answers |
| Redis restarts | Client reconnects on its own with capped backoff; cache refills on demand |
| Redis evicts under memory pressure | Correct behaviour -- `allkeys-lru`, everything is reconstructible |
| Stale permission after a role change | Bounded by TTL, or immediate via `invalidateRolePermissions` |
| Stale business date | 60 s TTL, explicit invalidation, and the posting transaction re-reads under lock |
| Cache stampede on a cold hot key | In-flight de-duplication: one load per process |
| Corrupt cache entry | Discarded and reloaded; the request succeeds |
| Two nodes start day-end | Redis lock refuses the second; Postgres advisory lock is the authoritative backstop |
| Lock holder pauses past its TTL | Fencing token, plus the database-side guard |
| Password spraying | Per-IP sliding-window limit on login |
| One teller saturating a branch's quota | Posting limit is per user, so it cannot happen |

### Honest gaps at the end of Phase 6

1. **No queue yet.** The outbox from Phase 5 still has no relay; rows
   accumulate. That is Phase 7 and is the next thing to build.
2. **Cache stats are per-process counters**, not real metrics. Phase 9.
3. **The lock is single-instance Redis.** If that node fails during an
   operation the lock evaporates. Redlock across independent masters is the
   textbook answer and is also widely criticised; the position taken here is
   that the database guard is what makes day-end safe, and the Redis lock is an
   optimisation. Worth saying out loud rather than adding Redlock and implying
   a guarantee it does not give.
4. **`invalidateBusinessDate` and `invalidateRolePermissions` exist but have no
   callers yet** -- the day-begin/day-end and role-admin endpoints are Phase 7
   and later. Until then the TTLs are the only mechanism, which is why they are
   short.
5. **No cache warming.** A cold start means every key misses once. Fine at this
   scale; worth revisiting if a deploy of all three nodes at once ever shows up
   as a database spike.
6. **Rate limits are fixed constants**, not per-branch configuration.

---

## 10. Interview questions this phase should let you answer

1. Where did you use Redis, and where did you deliberately refuse to?
2. Why is an account balance never cached, at any TTL?
3. Cache-aside, read-through or write-through -- which did you pick and why?
4. Your cache fails open but your lock fails closed. Explain.
5. Does your readiness probe check Redis? Why not?
6. What happens to the API when Redis dies? Show me.
7. What is a cache stampede and how did you stop it? What did you choose NOT
   to do, and why?
8. Why SCAN rather than KEYS?
9. Why is the business date cached for 60 seconds when everything else is 300?
10. Why is the permission cache keyed by role rather than by user?
11. Fixed window vs sliding window rate limiting. Which, and what does the other
    one let through?
12. Why is the rate-limit check a Lua script?
13. Your login limiter is per IP but your posting limiter is per user. Why the
    difference?
14. Is your distributed lock safe? (Expected answer: no, not by itself -- no
    TTL lock is. Fencing token plus the Postgres advisory lock is what makes
    day-end safe.)
15. Why does releasing the lock need Lua?
16. You added a cache. What did it actually improve -- and which percentile
    tells the real story?

---

## 11. Next

**Phase 7 -- async processing.** The outbox relay (`FOR UPDATE SKIP LOCKED`),
a worker process, BullMQ on a **second** Redis with `noeviction` and AOF,
retries with exponential backoff, a dead-letter queue, idempotent consumers,
and the AML rule-worker slice from the Phase 1 direction.

Plus the invalidation callers this phase left dangling: day-begin/day-end will
call `invalidateBusinessDate`, and the partition-creation and
idempotency/refresh-token purge jobs become scheduled worker tasks.
