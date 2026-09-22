# Phase 10 -- Failure Handling

> Built and verified 2026-09-22. Much of this phase was already built and
> proven in place -- degradation in Phase 6, at-least-once and the DLQ in
> Phase 7, node death in Phase 8. This phase adds what was missing and tests
> the rest under real failure.

---

## 1. What was added

```
  src/shared/resilience/circuitBreaker.ts   state machine + registry
  src/shared/resilience/timeout.ts          deadline helper
  src/middleware/loadShedding.ts            the answer to 10x traffic
  src/middleware/timeout.ts                 request deadline, last resort
  src/shared/db/prisma.ts                   statement_timeout + lock_timeout
  src/middleware/idempotency.ts             rewritten as an ATOMIC CLAIM
  tests/resilience.test.ts                  13 unit tests
  tests/chaos.int.test.ts                   8 tests that break real things
```

Tests: **30 unit + 96 integration**, up from 17 + 88.

---

## 2. The serious bug this phase found

A chaos test fired **five concurrent** requests with the same
`Idempotency-Key` -- what a flaky branch link plus an impatient client with
connection pooling actually produces.

It created **five vouchers**.

The middleware looked for an existing record, found none, let the request
proceed, and stored the response afterwards. That is check-then-act, and it
only ever worked for SEQUENTIAL retries. All five looked, all five found
nothing, all five posted. **On the money path.**

The phrase from Phase 7 -- *"check then act is not idempotency, it is a race
with good intentions"* -- was written about the audit worker and then not
applied here.

### The fix: let the database decide

The idempotency row is now **INSERTED BEFORE** the work runs, and the unique
constraint on `key` is what serialises the race. Exactly one request wins the
insert and does the work; the others lose it and are told so.

```
  first request         -> wins the claim, runs, stores its response
  concurrent duplicate  -> 409 + Retry-After ("in progress")
  retry after it settles-> stored response replayed
  retry, different body -> 409 (a real client bug, not hidden)
  the request FAILED    -> claim released, so a retry gets a real attempt
```

Two details that are easy to miss:

- **The claim is released on failure.** A failed request should be retryable
  with the same key -- if the database was briefly down, the retry must get a
  real attempt, not a replayed 503. Leaving the claim would permanently poison
  that key.
- **`res.on('close')` releases it too.** A handler that throws, or a client
  that disconnects, never reaches `res.json`. Without that listener the claim
  would be stranded and every retry would get "in progress" until it expired.

### Proven across nodes

Six concurrent requests through the load balancer, landing on all three nodes:

```
  req 1 -> HTTP 409  served by api-2
  req 2 -> HTTP 409  served by api-3
  req 3 -> HTTP 201  served by api-1
  req 4 -> HTTP 409  served by api-2
  req 5 -> HTTP 409  served by api-3
  req 6 -> HTTP 409  served by api-1

  vouchers created: 1
```

Then a retry, on a *different* node again:

```
  HTTP/1.1 201 Created
  X-Instance-Id: api-2
  Idempotency-Replayed: true

  vouchers created: 1
```

It holds across nodes because it is a Postgres unique constraint, not
per-process state -- the same property that made Phase 8's statelessness work.

---

## 3. The circuit breaker, and where it does NOT go

A breaker stops a caller hammering a dependency that is already failing. The
caller fails fast instead of holding a request open for a 30-second timeout,
and the struggling dependency gets room to recover.

It went on the **SMS gateway** -- the one genuinely external, optional,
slow-to-fail dependency.

**It deliberately did NOT go on Postgres**, and that is worth being explicit
about because "add a circuit breaker" is a reflex answer:

- If the database is down, the API cannot serve correct responses at all.
  A breaker converts slow failure into fast failure, which sounds better and is
  not -- there is no fallback and nothing useful to return.
- Worse, a breaker stays open for its whole cooldown **after the database
  recovers**. A 2-second blip becomes a 30-second outage that the breaker
  itself caused.
- Postgres already has the right tools: `statement_timeout`, `lock_timeout`,
  and a pool that queues. Those bound the damage without adding a state machine
  that can be wrong.

**Nor on Redis**: Phase 6 already fails open with a 150 ms command timeout,
which is a breaker's benefit without a breaker's state.

### Three details that matter

**`isFailure` excludes permanent errors.** An unroutable phone number is a bad
record, not a broken gateway. Counting it would take SMS out of service for
every customer because of one row.

**Consecutive failures, not cumulative.** One success clears the count. A
dependency that fails four times an hour is not broken, and a cumulative
counter would eventually open the circuit on a perfectly healthy service.

**HALF_OPEN admits exactly ONE probe.** Letting several through means a
dependency that is still down gets hit N times per cooldown -- the thundering
herd the breaker exists to prevent. Asserted in the tests: three concurrent
calls in HALF_OPEN, one admitted, two rejected.

### Layering

```
  RETRY + DLQ         (Phase 7 consumer harness)
    +-- CIRCUIT BREAKER
          +-- TIMEOUT
                +-- the actual call
```

The timeout is **inside** the breaker, so a hung call counts as a failure and
contributes to opening the circuit. Inverted, the breaker would never see the
hang and would stay closed forever while every job timed out.

---

## 4. Timeouts: the difference between bounding the caller and stopping the work

`withTimeout` races a promise against a clock. It does **not** cancel the
underlying work -- a promise cannot be cancelled, so the query carries on and
keeps holding its locks. A test asserts exactly that, because it is the point:

```
  it('does NOT cancel the underlying work -- which is why it is a second line of defence')
```

Using only a client-side timeout bounds the caller's wait while leaving the
dependency doing the expensive thing, which is the wrong half of the problem
under load.

So Phase 10 added the **server-side** limits, applied through the connection
string so they survive pooling (a `SET` on connect is lost the moment pgBouncer
hands out a different backend):

```
  statement_timeout=10s  lock_timeout=5s      (confirmed inside the container)
```

**`lock_timeout` is the one people forget, and it is the important one here.**
The posting path takes `SELECT ... FOR UPDATE` on balance rows (Phase 5). If
another transaction holds that lock and is itself stuck, the default is to wait
**indefinitely** -- and every later posting for that account queues behind it.
One stuck transaction silently freezes an account.

Proven by holding a lock and timing a second transaction's wait:

```
  ✓ aborts a lock wait rather than queueing forever
```

### The full timeout budget

| Boundary | Deadline | Added in |
|---|---|---|
| Redis command | 150 ms | Phase 6 |
| Postgres statement | 10 s (server-side) | **Phase 10** |
| Postgres lock wait | 5 s (server-side) | **Phase 10** |
| Prisma transaction | 5 s | Phase 3 |
| SMS gateway call | 5 s | **Phase 10** |
| HTTP request | 30 s (last resort) | **Phase 10** |
| nginx connect / read | 2 s / 30 s | Phase 8 |
| Job attempt | 5 tries, exponential | Phase 7 |
| Graceful shutdown | 15 s hard exit | Phase 3 |

The request deadline logs at **error**, not warn: if it fires, some upstream
bound is missing or wrong.

---

## 5. What happens at 10x traffic

Rate limiting (Phase 6) is about **fairness** -- stopping one caller consuming
everyone's capacity. Load shedding is about **survival**.

The failure mode without it is specific. Node accepts every connection it is
offered, so under overload the in-flight queue grows without bound. Latency
rises, clients time out and **retry** -- adding more load -- and the server
keeps doing work for requests nobody is waiting for any more. Throughput
collapses toward zero while CPU sits at 100%. That is congestion collapse, and
it does not recover on its own.

Shedding turns it into a partial outage that recovers the moment demand drops.

Three decisions:

**In-flight count, not CPU or latency.** CPU is lagging and, on a container
sharing cores (Phase 8 measured exactly that), reflects neighbours as much as
this process. Latency is also lagging -- by the time p99 is bad, the queue is
already deep. In-flight count *is* the queue depth, measured directly.

**Shed as early as possible**, before body parsing. Shedding is only useful if
it costs almost nothing; parsing the body of a request you are about to refuse
does the expensive part anyway.

**Health endpoints are never shed.** Shedding `/readiness` under load would
make the load balancer pull an overloaded-but-working node OUT of rotation,
concentrating its traffic on the remaining nodes and knocking them over too.
That is how a capacity problem becomes a cascading failure. Asserted in a test.

The ceiling is 200 per node -- Phase 8 measured ~9 in-flight at 145 rps with
healthy latency, so 200 is far above normal and far below unrecoverable. A
ceiling, not a target.

---

## 6. The complete failure-mode table

Every scenario the brief asks about, with the mechanism and where it was proven.

| Failure | What happens | Mechanism | Proven |
|---|---|---|---|
| **Node instance crashes** | nginx retries on another node; zero client-visible failures | Stateless API, `proxy_next_upstream error timeout` | Phase 8: `docker kill`, 20/20 succeeded |
| **Redis (cache) goes down** | API serves from Postgres, ~3x slower; readiness stays green | Fail open, 150 ms timeout, `safely()` wrapper | Phase 6: `docker stop`, all requests 200 |
| **Redis (queue) goes down** | Producers fail loudly; events stay PENDING in the outbox and are retried | `noeviction` (error, not eviction) + durable outbox | Phase 7 design; outbox durability proven |
| **Database becomes slow** | Queries abort at 10 s; lock waits at 5 s; alert fires | `statement_timeout`, `lock_timeout`, `DatabaseSlow` alert | **Phase 10 chaos tests** |
| **Database unavailable** | Writes fail fast with 503; readiness 503; LB drains the node. No breaker, on purpose | Readiness probe + connection failure | Phase 3 + section 3 |
| **A transaction holds a lock and hangs** | Waiters abort after 5 s instead of freezing the account forever | `lock_timeout` | **Phase 10 chaos test** |
| **Queue goes down** | Outbox accumulates durably; `outbox_oldest_pending_seconds` climbs and pages | Transactional outbox + the one metric that catches it | Phase 7 + Phase 9 (alert fired live) |
| **Worker crashes** | Job redelivered; consumers are idempotent | At-least-once + DB-enforced dedup | Phase 7 |
| **Relay stops** | Queue looks EMPTY and green; the outbox age gauge pages anyway | `outbox_oldest_pending_seconds` | Phase 9: alert FIRED at value=1388 |
| **Network becomes slow** | Every boundary has a deadline; the request deadline is the backstop | Timeout budget, section 4 | **Phase 10** |
| **External gateway hangs** | Timeout inside the breaker; 5 failures opens it; caller fails fast | Circuit breaker + timeout | **Phase 10**, 13 unit tests |
| **Traffic increases 10x** | Excess refused immediately with `Retry-After`; no congestion collapse | Load shedding at 200 in-flight | **Phase 10** |
| **One caller floods the API** | Per-IP on login, per-user on posting; counters shared in Redis | Sliding-window rate limit | Phase 6 + Phase 8 (shared across nodes) |
| **Duplicate request (sequential)** | Stored response replayed | Idempotency record | Phase 5 |
| **Duplicate request (CONCURRENT)** | One wins the claim, the rest get 409 + Retry-After | **Atomic claim** | **Phase 10**, across 3 nodes |
| **Duplicate event** | Consumer dedups on a unique constraint | `dedupe_key`, `(entity, action, requestId)` | Phase 7 |
| **Deployment fails** | Health-checked rolling deploy; old tasks stay until new ones pass readiness | Graceful drain + readiness gate | Phase 3 + Phase 12 (exit 0 under `docker stop -t 30`); rollback is Phase 13 |
| **Deploy mid-transaction** | Drain finishes in-flight work; nothing lives in process memory | Graceful shutdown | Phase 3 / Phase 12 |
| **A node is unready but up** | nginx keeps sending until 2 requests fail -- a known gap | Passive health checks only | Phase 8, fixed by an ALB in Phase 11 |

---

## 7. What is still missing

1. **nginx is a single point of failure** and does no active health checking.
   Both resolved by an ALB in Phase 11. Carried from Phase 8.
2. **No bulkheads.** The API and workers share one Prisma pool per process. A
   slow report query can starve the posting path. Separate pools per workload
   is the fix, and it is not built.
3. **No backpressure from the queue to the API.** If workers fall far behind,
   the API keeps accepting postings and the outbox keeps growing. That is
   arguably correct -- refusing to post money because SMS is backed up would be
   worse -- but it is a choice, not an accident, and it is unbounded.
4. **No chaos testing in CI.** The chaos tests run against a real Postgres but
   nothing kills containers on a schedule.
5. **`ConnectionPoolExhausted` is still a proxy metric** (Phase 9). pgBouncer
   in Phase 11 exposes the real one.
6. **No automated rollback.** Phase 13.
7. **Carried over and still open:** `invalidateBusinessDate` has no caller
   (Phase 6); the AML alert workflow is data only (Phase 7).

---

## 8. Interview questions this phase should let you answer

1. A client retries a POST five times concurrently with the same idempotency
   key. What happens? What happened before you fixed it?
2. Why does the idempotency row get inserted BEFORE the work runs?
3. What releases the idempotency claim if the handler throws?
4. Where did you put a circuit breaker, and where did you deliberately refuse
   to? Defend the refusal.
5. Why would a circuit breaker on the database make an outage worse?
6. Why is the timeout inside the breaker rather than outside?
7. Your `withTimeout` helper does not cancel the work. Why is that acceptable,
   and what covers the gap?
8. What is `lock_timeout` and what specifically goes wrong without it in a
   ledger?
9. Why set the Postgres timeouts through the connection string rather than a
   `SET` on connect?
10. Describe congestion collapse. What stops it here, and why in-flight count
    rather than CPU?
11. Why are health endpoints exempt from load shedding?
12. Circuit breaker: consecutive or cumulative failures? Why?
13. How many requests does HALF_OPEN admit, and what breaks if it admits more?
14. Walk me through your timeout budget from the browser to the database.

---

## 9. Next

**Phase 11 -- AWS deployment.** Route 53, CloudFront, ALB, ECS, RDS,
ElastiCache, SQS, pgBouncer -- each with why, what problem it solves, what the
alternative is, and what the trade-off costs. Several of the gaps above are
resolved there, and the brief is explicit that services do not go on the
diagram just because they exist.
