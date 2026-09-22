# Phase 2 -- New Node.js Architecture (LedgerCore + AML slice)

> Design only. No code. Every technology below must answer: why do we need it?
>
> Selected direction (Phase 1): **LedgerCore** -- a double-entry posting engine
> extracted from the FinCore CBS domain -- with a **Phase-7 AML slice**
> (posting events -> queue -> rule worker -> alerts) as the async showcase.
>
> Prior context: `PHASE0_DOMAIN_ANALYSIS.md`.

---

# 1. Design principles (derived from Phase 0, not invented)

Phase 0 found five concrete defects. Each one becomes a principle here.

| Phase 0 defect | Principle for LedgerCore |
|---|---|
| Voucher state in `Context.Items` (per-socket RAM) | **Stateless API.** Draft lives on the client or in a `voucher` row, never in process memory. |
| JWT with zero claims; identity in request body | **Identity comes from the token, never from the payload.** |
| Permissions in `.mnu` files on each server's disk | **Permissions in Postgres, cached in Redis, enforced server-side.** |
| Money in `FLOAT` | **`NUMERIC(19,4)` in the DB, `decimal.js` in the app. Never `number`.** |
| Long batch jobs inside a WebSocket call | **Anything over ~1s goes to a queue with a job id and progress.** |

Plus one rule that governs the whole build:

> Every component must earn its place. If I cannot say what breaks without it,
> it does not go in.

---

# 2. Architecture evolution -- three steps, not one

The prompt is explicit: do not build the full topology on day one. Here is the
sequencing, and what forces each step.

## Step 1 -- Phases 3 to 5: one process, one database

```
   React (Vite + TS)
        |
        |  HTTPS, JSON, JWT in Authorization header
        v
   Node.js + Express + TypeScript   (single process, modular monolith)
        |
        v
   PostgreSQL 16
```

What exists: config, Express app, routing, controllers, services, repositories,
validation, error handling, auth (JWT + refresh rotation), RBAC, structured
logging, DB pool, graceful shutdown, the full schema, transactions, indexes,
pagination.

What does NOT exist yet: Redis, queue, workers, load balancer. **Deliberately.**
At this point there is no measured problem for them to solve, and adding them
early hides which component is actually responsible for a behaviour.

## Step 2 -- Phases 6 to 7: Redis, then the queue and workers

```
   React
     |
   Node.js API  ---------------> Redis   (cache-aside, locks, rate limit,
     |                                    refresh-token store)
     |                              ^
     v                              |
   PostgreSQL                       |
     |                              |
     |  outbox table                |
     v                              |
   Relay  ---> Queue (BullMQ) ------+
                  |
                  v
             Workers (separate process, same codebase)
                  |
                  +-- notification worker
                  +-- audit writer
                  +-- statement/report generator
                  +-- day-end orchestrator
                  +-- AML rule worker   <- the Direction-2 slice
```

Redis arrives when Phase 5 measurement shows product/GL master lookups
dominating the voucher path. The queue arrives when Phase 7 identifies work
that does not need to be synchronous.

## Step 3 -- Phases 8 to 12: horizontal scale

```
                        React (S3 + CloudFront)
                                 |
                                 v
                           CloudFront / CDN
                                 |
                                 v
                        ALB (health checks, round robin)
                          /      |       \
                    Node-1    Node-2    Node-3      (ECS Fargate, stateless)
                          \      |       /
                    +------------+------------+
                    |                         |
              ElastiCache Redis          RDS PostgreSQL
                    |                    (primary + read replica)
                    |                         |
                    v                         v
                  Queue                  pgBouncer
                    |
                    v
              Worker-1 .. Worker-N   (separate ECS service, scales on queue depth)
```

The API only becomes replicable because Step 1 made it stateless. That
ordering is the whole point.

---

# 3. Request flow -- one voucher, end to end

```
  Teller fills the voucher form in React
        |
        |  client builds the WHOLE voucher locally (no server round trip
        |  per field -- this replaces the 10-20 *Validate calls)
        v
  POST /api/v1/vouchers
    Headers: Authorization: Bearer <access JWT>
             Idempotency-Key: <uuid v4 from the client>
             X-Request-Id: <uuid>
        |
        v
  [1] requestId middleware      -> AsyncLocalStorage context
  [2] helmet / cors / body limit
  [3] rate limit (Redis)        -> per user + per endpoint
  [4] authenticate              -> verify JWT, load {userId, branchId, roleId}
  [5] authorize                 -> permission 'voucher:create' from Redis cache
  [6] validate                  -> zod schema on the body
  [7] idempotency middleware    -> Redis SETNX, then durable check in Postgres
        |
        v
  VoucherController.create
        |
        v
  VoucherService.createVoucher(cmd, actor)
        |
        +-- BusinessDateService.current(branchId)    (Redis cached, short TTL)
        +-- BatchService.assertOpen(branchId, date, batchCode)
        +-- ProductService.getMany(productCodes)     (Redis cache-aside)
        +-- for each line: AccountService.assertPostable(...)
        |       - account exists, status active
        |       - product allows this transaction type (cashDr/trfrCr/...)
        |       - account/customer not frozen
        +-- assertBalanced(lines)                    sum(Dr) == sum(Cr), decimal.js
        +-- AuthPolicyService.requiredLevels(amount) -> 0..4 checkers
        |
        v
  BEGIN
    INSERT voucher (status = PENDING_AUTH or AUTHORIZED if levels = 0)
    INSERT voucher_line[]
    INSERT idempotency_key (unique on key)
    INSERT outbox (event = 'voucher.created')
  COMMIT
        |
        v
  201 Created { voucherId, status, requiredApprovals }
```

Then, separately:

```
  POST /api/v1/vouchers/:id/approve      (a DIFFERENT user -- maker != checker)
        |
        v
  BEGIN
    SELECT voucher FOR UPDATE
    assert actor != maker, actor has 'voucher:authorize', level not already given
    INSERT authorization_step
    if all required levels satisfied:
        status = POSTED
        SELECT account_balance FOR UPDATE   <- ORDERED BY account_id (deadlock rule)
        apply each line to the balance
        INSERT outbox ('voucher.posted')
  COMMIT
        |
        v
  outbox relay -> queue -> workers (notification, audit, AML rule evaluation)
```

Note what is absent: no server-side conversational state, no socket, no
`BuildVoucherArray`. Any of the three Node instances can serve any of these
calls.

---

# 4. Component by component -- why do we need it?

## 4.1 React + TypeScript (frontend)

**Why.** The existing UI already proves the domain needs rich forms, keyboard
flow and dense tables. Nothing about that requires server-rendered pages.

**Chosen:** React 18 + TypeScript + Vite + React Router + TanStack Query +
Tailwind + shadcn/ui + zod (shared validation schemas) + axios.

**Why TanStack Query specifically.** The authorisation queue, account search
and balance displays are all server state with staleness rules. Hand-rolling
that in Redux (what the existing app does) is where most of its complexity
lives.

**Trade-off.** SPA means no SEO and a bigger first paint. Irrelevant here --
it is an internal banking application behind a login.

## 4.2 Node.js

**Problem.** Need a runtime for an I/O-heavy API: most of a voucher request is
waiting on Postgres and Redis.

**Options.** Node.js, .NET (excluded by the brief), Go, Java/Spring.

**Chosen.** Node.js 20 LTS.

**Why.** The workload is I/O-bound, not CPU-bound. One event loop handles
thousands of concurrent waiting requests cheaply. Shared language and shared
zod schemas with the React frontend removes a whole class of contract drift.

**Trade-offs -- state these honestly in an interview:**
- Node is **bad at CPU-bound work**. Interest application over 500k accounts
  would block the event loop. Mitigation: that work never runs in the API
  process; it runs in worker processes, chunked.
- Single-threaded per process means one poison request can stall everything.
  Mitigation: timeouts everywhere, `clustering`/multiple containers, and no
  synchronous crypto or JSON over huge payloads on the request path.
- Numeric precision: JS `number` is IEEE-754 double -- the **exact** bug the
  legacy schema has. Mitigation is structural (section 4.6).

## 4.3 Express

**Problem.** HTTP routing, middleware pipeline.

**Options.** Express 4, Fastify, NestJS, Koa.

**Chosen.** Express (brief mandates it, and it is defensible).

**Why.** Smallest surface area, explicit middleware ordering, enormous
ecosystem. For a system whose value is in the domain layer, the framework
should be boring.

**Trade-offs.** Express gives no DI container, no built-in validation, no
async error handling (an unhandled rejection in a handler does not reach the
error middleware without a wrapper). So we build those four things ourselves:
a small composition root, zod validators, an `asyncHandler` wrapper, and a
single error middleware. NestJS would give these out of the box at the cost of
a lot of implicit magic.

## 4.4 TypeScript

**Why.** The domain has ~15 entities with subtle invariants (four date fields,
six balance fields, a five-state voucher machine). Branded types make
`AccountId`, `BranchId`, `Money` non-interchangeable. Discriminated unions make
the voucher state machine checkable at compile time.

**Trade-off.** Build step, and types do not survive the DB or HTTP boundary --
so zod validates at the edges and TypeScript infers from zod.

## 4.5 PostgreSQL

**Problem.** Need a relational store for a ledger with strict invariants.

**Options.** PostgreSQL, MySQL 8.

**Chosen.** PostgreSQL 16.

**Why -- specific features this design actually uses:**
- `NUMERIC(19,4)` -- exact decimal arithmetic. MySQL has `DECIMAL` too, so
  this alone is not decisive.
- **Declarative range partitioning** on `voucher_line(post_date)`. The legacy
  ledger is the one table that grows without bound; partitioning gives cheap
  pruning for statements and cheap archival by detaching partitions.
- `SELECT ... FOR UPDATE SKIP LOCKED` -- lets the outbox relay and any
  DB-backed queue pull work concurrently without contention.
- **Advisory locks** (`pg_advisory_xact_lock`) -- a natural fit for
  "only one day-end per branch per business date", scoped to a transaction.
- **Exclusion constraints** with `btree_gist` -- enforce that effective-dated
  sanction limits on one account cannot overlap in time. This is a real
  business rule (`D009042` PK includes `EffFromDate`) that MySQL cannot express
  declaratively.
- `pg_trgm` for fuzzy name search -- replaces the legacy `CHAR(50) LIKE` scans,
  and later serves AML sanctions screening.
- Partial indexes -- e.g. index only `WHERE status = 'PENDING_AUTH'`, which is
  a tiny slice of a huge table but the hottest query in the branch.
- `jsonb` for the AML rule definitions and audit event payloads.

**Trade-offs.**
- Connection-per-backend model: Postgres forks a process per connection, so
  connection count is a hard resource. Node opens connections eagerly. This
  is why pgBouncer appears in Step 3, and why worker processes get their own
  smaller pool.
- `VACUUM` / bloat: a high-update table like `account_balance` needs autovacuum
  tuning. That is a real operational cost and a fair interview question.

## 4.6 Money representation -- the decision that matters most

**Problem.** The legacy system stores money in `FLOAT`. `0.1 + 0.2 !== 0.3`.
In a ledger this produces unbalanced vouchers and drifting balances.

**Options.**
1. `DOUBLE PRECISION` -- what the legacy does. Rejected.
2. `BIGINT` minor units (paisa). Exact, fast, but every read/write needs
   scaling, and fractional interest (e.g. 7.35% daily accrual) still needs a
   decimal library for the intermediate result.
3. `NUMERIC(19,4)`. Exact, readable, arithmetic works in SQL, four decimals
   gives headroom for interest intermediates before rounding to paisa.

**Chosen.** `NUMERIC(19,4)` in Postgres, `decimal.js` in the application.

**Why 4 decimals, not 2.** Interest and TDS calculations produce fractions of a
paisa. Rounding at each step accumulates error; keeping 4 decimals internally
and rounding only at the posting boundary matches how the legacy
`IntPrvd`/`IntPaid` split behaves.

**The critical implementation rule.** `node-postgres` returns `NUMERIC` as a
**string** by default. That default must never be overridden to a JS number.
Every money value is `string -> Decimal -> string`, and a `Money` branded type
makes an accidental `number` a compile error. This gets its own test.

**Trade-off.** `NUMERIC` is slower than `BIGINT` and not a fixed-width type. At
the scale in question that is irrelevant; correctness is not negotiable.

## 4.7 ORM / query layer

**Problem.** Need schema-as-code, migrations, type safety, and full control on
the posting path.

**Options.** Prisma, TypeORM, Sequelize.

**Chosen.** **Prisma** for schema, migrations, and ~90% of queries, with raw
SQL (`$queryRaw` / `$executeRaw`) for the posting hot path.

**Why.**
- Prisma generates types **from the schema**, so a column rename is a compile
  error across the codebase. TypeORM's decorator entities can drift from the
  actual DB silently.
- `prisma migrate` produces reviewable SQL files -- the direct successor to
  `FinCoreMSSQLScripts/`, which is exactly the migration discipline the legacy
  system already (informally) has.
- `$transaction` with an explicit `isolationLevel` covers the interactive
  transaction case.

**Why this is a split decision, and why that is correct.** Prisma does **not**
support `SELECT ... FOR UPDATE`, advisory locks, partitioned-table DDL, or
`SKIP LOCKED`. But the voucher posting path was always going to be hand-written
SQL: I want exact control over lock ordering and I want one round trip, not an
ORM's N statements. So Prisma's limits fall precisely where I was not going to
use an ORM anyway.

**Trade-offs, stated plainly.**
- Two query styles in one codebase. Mitigation: raw SQL is confined to
  `repositories/`, never in services or controllers.
- Prisma's connection pool is its own; pgBouncer must run in **transaction**
  pooling mode and Prisma needs `pgbouncer=true` plus prepared statements off.
  This is a known sharp edge, not a surprise.
- **When I would switch to TypeORM instead:** if the majority of queries needed
  pessimistic locks, TypeORM's native `setLock('pessimistic_write')` would stop
  the split from being worth it. That is not this workload -- locks are
  concentrated in one code path.
- Sequelize: rejected. Weakest TypeScript story of the three.

## 4.8 Redis

**Problem to solve first, technology second.** Redis is added in Phase 6 only
after Phase 5 measurement shows the specific costs below.

**Where Redis IS used, and what breaks without it:**

| Use | Pattern | Without it |
|---|---|---|
| Product / GL head / code tables | Cache-aside, TTL 5 min, explicit invalidation on write | Every voucher line does 2-3 extra master lookups. These rows change ~monthly and are read on every posting. |
| Permissions per role | Cache-aside, invalidate on role change | A permission join on every single request |
| Business date per branch | Cache-aside, TTL 60s | Read on every posting |
| Refresh-token store + denylist | Hash with TTL = refresh lifetime | No revocable logout -- the legacy system's exact bug |
| Rate limiting | Sliding-window counter per user+endpoint | One client can saturate the API |
| Distributed lock | `SET key val NX PX ttl` + fencing token | Two day-end runs for the same branch/date |
| Idempotency fast path | `SETNX` before the durable Postgres check | Every duplicate retry costs a DB round trip |
| Authorisation-queue badge counts | Counter + pub/sub invalidation | A `COUNT(*)` on a hot table per poll |

**Where Redis is deliberately NOT used:**

- **Account balances.** Never. The balance is the product. Serving it from a
  cache means a stale read can authorise a debit that overdraws the account,
  and there is no reconciliation that makes that acceptable. Balances are read
  from Postgres, under a row lock when they are about to change.
- **Voucher drafts.** Putting them in Redis would recreate the legacy's
  server-side conversational state, just distributed. The client holds the
  draft; the server sees one complete command.
- **As the only home for anything.** Redis is `maxmemory-policy allkeys-lru`
  cache plus ephemeral coordination. Everything durable is in Postgres.

**Trade-offs.**
- Cache invalidation is the hard part. Strategy: short TTL as a backstop,
  explicit `DEL` on write, and accept bounded staleness only on data where
  staleness is harmless (product config, permissions) and never on money.
- Redis is a new failure domain. Every Redis call is wrapped so that a
  timeout **degrades to the database**, not to a 500. Rate limiting fails open;
  the distributed lock fails **closed** (refuse the day-end rather than risk
  running it twice).
- Cluster mode changes multi-key semantics. Single-node ElastiCache with a
  replica is enough here; say so rather than over-engineering.

## 4.9 Message queue

**Problem.** Some work must happen after a posting but must not be inside the
posting transaction, and must survive a crash.

**Options.**
1. **BullMQ** (Redis-backed). Already have Redis. Great DX, delayed jobs,
   repeatable/cron jobs, retries with backoff, per-job progress, a real
   failed-jobs set that works as a DLQ.
2. **RabbitMQ.** Proper broker, routing topologies, durable per-message acks.
   One more stateful service to run.
3. **AWS SQS.** Fully managed, effectively infinite, DLQ is first-class,
   integrates with ECS autoscaling. No native delayed-job UI, no built-in cron.

**Chosen.** **BullMQ in Phases 7 to 10; SQS as the documented Phase-11 option
for AWS**, with the producer behind a `JobQueue` interface so the swap is a
single adapter.

**Why start with BullMQ.** Zero new infrastructure, and it makes retries,
backoff, DLQ, concurrency and progress visible locally -- which is the point of
Phase 7. Introducing RabbitMQ at the same time would confuse "I do not
understand backoff" with "I misconfigured a broker."

**Trade-offs.**
- BullMQ couples durability of the queue to Redis. If Redis is a cache with
  LRU eviction, jobs can be evicted. Mitigation: **a separate Redis
  instance/database for the queue with `maxmemory-policy noeviction` and AOF
  on.** This is a real trap and worth saying out loud.
- At-least-once delivery, always. Every consumer must be idempotent. No queue
  gives exactly-once; "exactly-once" is at-least-once plus consumer-side dedup.
- Ordering is not guaranteed across concurrent workers. Where order matters
  (per-account event sequence), the job carries a sequence number and the
  consumer checks it.

## 4.10 Transactional outbox -- the piece most designs get wrong

**Problem.** After posting a voucher I must publish `voucher.posted`. If I
publish inside the DB transaction and the transaction rolls back, I have
announced something that did not happen. If I publish after commit and the
process dies in between, the event is lost. There is no ordering of two
different systems that is safe.

**Options.**
1. Publish inside the transaction. Wrong -- phantom events.
2. Publish after commit. Wrong -- lost events on crash.
3. Two-phase commit across Postgres and Redis. Not available, and would be a
   bad idea if it were.
4. **Transactional outbox.** Write the event to an `outbox` table *in the same
   transaction*. A relay process polls it (`FOR UPDATE SKIP LOCKED`), publishes
   to the queue, marks it sent.

**Chosen.** Outbox.

**Why.** The event and the state change commit or fail together, atomically,
with no distributed transaction. This is the single highest-value pattern in
the whole build for interviews.

**Trade-offs.** Adds latency (poll interval, ~200ms) and a relay process.
Delivery is at-least-once, so consumers must be idempotent -- which they had to
be anyway. Postgres logical decoding (CDC) would remove the polling but adds
operational weight; note it as the next step, do not build it.

## 4.11 Workers

**Why a separate process, not a `setInterval` in the API.** Three reasons, all
concrete:
1. CPU-bound work (interest application, report generation) would block the
   API's event loop.
2. Workers and the API scale on **different signals** -- API on RPS/latency,
   workers on queue depth.
3. A worker crash must not take down the API, and a deploy of one must not
   force a deploy of the other.

Same repository, same domain modules, different entrypoint. That is the
modular-monolith payoff: extraction later is changing an import, not rewriting
the logic.

Workers planned: notification, audit writer, statement/report generator,
day-end orchestrator, interest application (chunked fan-out), and the AML rule
worker.

## 4.12 Load balancer and statelessness

**Why horizontal scaling at all.** One Node process has one event loop and a
fixed memory ceiling. Vertical scaling ends; it also leaves a single point of
failure, which for a bank's posting engine is unacceptable on its own.

**Why stateless is the precondition.** If any request depends on memory in a
specific process, the balancer must pin the client there (sticky sessions), and
then: a node dying loses work, a deploy loses work, and load distributes
unevenly. That is exactly the legacy failure mode.

**How LedgerCore stays stateless:**
- Session identity -> signed JWT, verified per request. No server session map.
- Refresh tokens -> Redis, shared by all nodes.
- Voucher draft -> client, or a `DRAFT` row in Postgres.
- Permissions -> Postgres, cached in Redis.
- Rate-limit counters -> Redis.
- Idempotency keys -> Redis fast path plus Postgres durable record.
- Business date -> Postgres (never `new Date()` on a node, which would make
  clock skew a correctness bug on value dating).
- Uploaded/generated files -> S3, never local disk.

**Health endpoints (Phase 9).** `/liveness` -- is the process alive (no
dependency checks, or a crash-looping DB takes down every node). `/readiness`
-- can it serve traffic (DB pool reachable, Redis reachable-or-degraded); the
ALB uses this one. `/health` -- detailed, for humans and dashboards.

## 4.13 Docker, AWS, CI/CD

Deferred to Phases 11 to 13 by design. Preview only:
- Three images: `api`, `worker`, `web`. Multi-stage builds, non-root user,
  `NODE_ENV=production`, no dev dependencies in the final layer.
- `docker-compose` for local: postgres, redis (cache), redis (queue), api,
  worker, web. This is how the three-step evolution stays reproducible.
- AWS in Phase 11, service by service, each with "why / what problem / what
  alternative / what trade-off". No service goes in because it is on a diagram.

---

# 5. Modular monolith -- the module map

```
src/
 |- config/          env loading + zod validation, fail fast at boot
 |- app.ts           express composition root
 |- server.ts        http server, graceful shutdown
 |- worker.ts        worker entrypoint (same modules, different wiring)
 |
 |- modules/
 |   |- identity/        users, roles, permissions, sessions, tokens
 |   |- org/             banks, branches, business dates, batches, terminals
 |   |- customer/        customers, KYC, freeze, customer groups
 |   |- product/         products, GL heads, transaction-type rules
 |   |- account/         accounts, balances, liens, holds, available balance
 |   |- ledger/          vouchers, lines, posting engine, reversals   <- the core
 |   |- authorization/   maker-checker policy, approval chain, queue
 |   |- dayend/          day begin/end orchestration, snapshots
 |   |- reporting/       statements, enquiry (read-mostly, replica-routed)
 |   |- aml/             rules, alerts, cases        <- Phase 7 slice
 |   \- audit/           immutable audit trail
 |
 |- shared/
 |   |- money/           Money type, decimal helpers, rounding rules
 |   |- errors/          AppError hierarchy, error codes
 |   |- db/              prisma client, raw SQL helpers, tx helper
 |   |- cache/           redis client, cache-aside helper, lock helper
 |   |- queue/           JobQueue interface + BullMQ adapter (+ SQS later)
 |   |- outbox/          outbox writer + relay
 |   |- logging/         pino logger, request context (AsyncLocalStorage)
 |   \- http/            asyncHandler, validate(), pagination helpers
 |
 \- types/
```

Each module has the same internal shape:

```
  routes.ts        -> HTTP surface, zod schemas
  controller.ts    -> parse, call service, shape response. No logic.
  service.ts       -> business rules, transactions, invariants. No SQL, no HTTP.
  repository.ts    -> all SQL (prisma or raw). No business rules.
  types.ts / events.ts
```

**Module boundary rule:** a module may only be reached through its service's
public interface. No cross-module repository access, no cross-module table
joins. That rule is what makes `aml/` or `reporting/` extractable into a
service later without a rewrite -- and the prompt's requirement to *demonstrate*
extraction becomes a five-line change plus a queue hop, not a project.

---

# 6. Data architecture preview (full design in Phase 5)

```
  branch ----< business_date ----< batch
     |
     |                        product ----< account_product_rule
     |                           |
  customer ---------------------< account ---- account_balance (1:1, versioned)
     |                              |    \
     |                              |     \--< lien / hold
     |                              |
     |                              +--< sanction_limit  (effective-dated,
     |                              |                     exclusion constraint)
     |                              +--< loan_schedule
     |
  user ----< role ----< role_permission >---- permission
     |
     +--< voucher ----< voucher_line >---- account
              |                    (PARTITIONED BY RANGE post_date)
              +--< authorization_step

  outbox        (event, payload jsonb, created_at, sent_at)
  idempotency_key (key, user_id, request_hash, response, created_at)
  audit_event   (actor, action, entity, before/after jsonb, at)  -- append only
  aml_rule / aml_alert / aml_case   -- Phase 7
```

Invariants that will be enforced in the **database**, not only in code:
- `voucher_line.amount > 0` (direction lives in `dr_cr`, never a negative amount)
- per-voucher `sum(Dr) = sum(Cr)` -- deferred constraint or a trigger on commit
- `authorization_step` unique on `(voucher_id, level)`
- `authorization_step.actor_id <> voucher.maker_id`
- `sanction_limit` non-overlapping periods per account (exclusion constraint)
- real foreign keys everywhere (the legacy has zero)

---

# 7. What can fail, and the answer (preview of Phases 10 and 16)

| Failure | Response designed in |
|---|---|
| Client retries POST /vouchers | Idempotency key: Redis fast path + unique index in Postgres |
| Two transfers touch the same two accounts | Lock accounts in a fixed order (`ORDER BY account_id`) -> no deadlock cycle |
| Concurrent balance update | `version` column, optimistic check, retry once, then 409 |
| Redis down | Cache misses fall through to Postgres; rate limit fails open; **lock fails closed** |
| Day-end triggered twice | `pg_advisory_xact_lock(branch, date)` + job-level idempotency |
| Node instance dies mid-request | Stateless: ALB drains, client retries with the same idempotency key |
| Deploy during a voucher entry | Draft is client-side, so nothing is lost; graceful shutdown drains in-flight requests |
| Worker crashes mid-job | At-least-once redelivery + idempotent consumer + DLQ after N attempts |
| Queue backlog grows | Depth metric -> alarm -> scale workers; API keeps serving |
| Postgres slow | Statement timeout, pool timeout, circuit breaker on non-critical reads |
| Postgres unavailable | Writes fail fast with 503; readiness probe removes the node from the ALB |
| Outbox relay stops | Events accumulate durably; nothing is lost; alarm on oldest unsent age |

---

# 8. Phase 2 wrap-up

### What we designed
A stateless Express + TypeScript modular monolith over PostgreSQL, evolving in
three explicit steps to Redis, a queue with workers, and a load-balanced
multi-node deployment -- with money as `NUMERIC(19,4)`, a transactional outbox
between the DB and the queue, and every dependency degrading rather than
failing hard.

### Why we designed it this way
Every choice traces to a defect measured in Phase 0: per-socket state,
claimless JWTs, file-based permissions, float money, and synchronous batch jobs.

### How it works
Identity comes from the token, the whole voucher arrives as one command, a
single DB transaction writes the voucher plus its outbox event, and everything
non-essential to the response happens later in a worker.

### What can fail
Section 7. The short version: duplicates, deadlocks, stale cache, lost events,
queue backlog, and dependency outages -- each with a named mechanism.

### How to debug it
Every request carries an `X-Request-Id` through `AsyncLocalStorage` into every
log line, every SQL statement comment, and every queued job -- so one id traces
a voucher from the browser through the API, the outbox, the queue and the
worker. Detailed in Phase 9.

### Interview questions this phase should let you answer
1. Why did you make the API stateless, and what specifically did that unlock?
2. Why `NUMERIC(19,4)` and not float or bigint paisa? What does
   `node-postgres` return for `NUMERIC`, and why does that matter?
3. You chose Prisma but write raw SQL for posting. Defend that split.
4. Where did you deliberately NOT use Redis, and why?
5. Why do you need an outbox? Walk through what breaks if you publish to the
   queue inside the transaction. What breaks if you publish after commit?
6. Your queue is at-least-once. How do you get exactly-once semantics?
7. Two tellers transfer between the same two accounts simultaneously. What
   happens? How do you guarantee no deadlock?
8. Redis goes down at 11am. Which endpoints still work? Which fail? Why did
   you choose fail-open for rate limiting and fail-closed for the day-end lock?
9. Why are workers a separate process rather than a `setInterval` in the API?
10. What is your first bottleneck at 10x traffic, and how do you know?

---

# 9. Next

**Phase 3 -- Node.js backend foundation.** Environment config, Express app,
routing, controllers, services, repositories, validation, error handling,
logging, DB connection, graceful shutdown. Real code, Step-1 topology only
(no Redis, no queue).

Awaiting go-ahead.
