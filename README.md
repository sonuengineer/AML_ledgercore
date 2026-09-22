# LedgerCore

A double-entry core banking ledger with an AML slice, built as a **modular
monolith** on Node.js / TypeScript / PostgreSQL / Redis.

The business domain is taken from a real core banking system. The
implementation is not: none of the original .NET code is reused, and every
architectural decision here was made from scratch and then tested.

> **Honesty note.** Every performance number in this repository was measured on
> one developer machine and is labelled as such. There are no production traffic
> figures, no user counts and no cost savings, because this system has never
> served a real customer. Where something is simulated it says "simulated".

---

## What is in here

| Path | What it is |
|---|---|
| [`ledgercore/`](ledgercore/) | API + background worker. Express, TypeScript, Prisma, PostgreSQL, Redis, BullMQ. |
| [`ledgercore-web/`](ledgercore-web/) | React SPA, served by nginx in production. |
| [`ledgercore/deploy/`](ledgercore/deploy/) | nginx, pgBouncer, Prometheus, and Terraform for an AWS topology (**never applied**). |
| `PHASE*.md` | The build log. One document per phase: what was built, why, how it fails, how to debug it. |

---

## The parts worth reading

Each of these exists because something broke first. The phase documents contain
the failure, the measurement and the fix.

**Correctness under concurrency**

- Double-entry posting where the balance check and the write happen under
  `SELECT ... FOR UPDATE` with a globally consistent lock order, so concurrent
  postings serialise instead of deadlocking.
- Idempotency as an **atomic claim** -- insert first and let a unique constraint
  decide the winner. The first version was check-then-act and let five
  concurrent requests with one idempotency key create five vouchers. See
  [PHASE10_FAILURE_HANDLING.md](PHASE10_FAILURE_HANDLING.md).
- Money is `NUMERIC(19,4)` in Postgres and a branded string type in TypeScript.
  `number` is never used for an amount.

**Things that looked fine and were not**

- Prisma's `$transaction` resolved successfully while the data had rolled back.
  Fixed by forcing deferred constraints to fire before commit
  ([PHASE5_LEDGER.md](PHASE5_LEDGER.md)).
- A security action -- revoking a token family on reuse detection -- was itself
  rolled back, because the revoke and the `throw` were inside the same
  transaction. The attacker kept a working session
  ([PHASE4_AUTHENTICATION.md](PHASE4_AUTHENTICATION.md)).
- `prisma migrate diff` silently dropped two hand-written trigram indexes and
  nothing noticed for two phases. There is now a test that asserts the schema
  objects exist ([PHASE7_ASYNC.md](PHASE7_ASYNC.md)).
- Deleting 50MB from a Docker image changed its size by zero bytes, because a
  layer can only add ([PHASE12_DOCKER.md](PHASE12_DOCKER.md)).
- Two separate health checks reported a perfectly healthy service as down, and
  both took their dependants with them
  ([PHASE11_AWS.md](PHASE11_AWS.md), [PHASE12_DOCKER.md](PHASE12_DOCKER.md)).

**Operating it**

- Transactional outbox, at-least-once delivery, idempotent consumers, DLQ and
  replay ([PHASE7_ASYNC.md](PHASE7_ASYNC.md)).
- RED-method metrics, histograms rather than summaries so they aggregate across
  instances, and alerts on symptoms rather than causes
  ([PHASE9_OBSERVABILITY.md](PHASE9_OBSERVABILITY.md)).
- Circuit breaker, load shedding, timeout budget, graceful drain that exits 0
  ([PHASE10_FAILURE_HANDLING.md](PHASE10_FAILURE_HANDLING.md)).

---

## Running it

Requires Docker and pnpm.

```bash
cd ledgercore
cp .env.example .env

# Postgres + both Redis roles
docker compose up -d postgres redis redis-queue

pnpm install
pnpm db:deploy && pnpm db:seed
pnpm dev                       # API on :4000
pnpm worker                    # background worker
```

Seeded login: staff code `T001`, password `ChangeMe#2026` (development only).

**The full topology** -- three API nodes behind nginx, pgBouncer, a worker,
Prometheus and the frontend:

```bash
cd ledgercore
docker compose --profile scale up -d
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3002 |
| API via load balancer | http://localhost:8080/api/v1 |
| Prometheus | http://localhost:9090 |

**Tests**

```bash
cd ledgercore
pnpm test        # unit -- no services needed
pnpm test:int    # integration -- needs Postgres and both Redis instances
```

---

## Architecture, briefly

A **modular monolith**: one deployable, hard module boundaries inside it. Not
microservices, because at this size a distributed transaction across an
account service and a ledger service would buy nothing and cost correctness.

The worker is the proof that the boundaries are real -- it is the *same image*
with a different command, importing the same domain modules, scaled on queue
depth while the API scales on request rate.

```
        browser
           |
        nginx (round robin, no sticky sessions)
           |
   api-1  api-2  api-3          worker (N replicas)
           |                        |
       pgBouncer                    |
           |                        |
        PostgreSQL  <--- outbox ---->
           |
     Redis (cache role)     Redis (queue role)
     allkeys-lru            noeviction + AOF
```

The two Redis instances are separate on purpose. Running a job queue on an LRU
cache means jobs get evicted under memory pressure and work vanishes with no
error anywhere.

---

## What this is not

- **Not deployed.** The Terraform in `ledgercore/deploy/terraform` describes an
  AWS topology and has never been applied. It is a design artefact.
- **Not feature-complete as a core banking system.** The ledger, auth and AML
  slices are real; the rest of a CBS is not attempted.
- **Not load-tested at scale.** The load numbers are from `scripts/load.mjs`
  against containers sharing one laptop's cores, and the phase documents say so
  where they report them -- including where scaling to three nodes produced *no*
  throughput gain.
