# Phase 11 -- AWS Deployment

> 2026-09-22. **This phase is mostly design, and that has to be said plainly:
> there is no Terraform binary, no AWS CLI and no AWS credentials on this
> machine. The Terraform has never been run through `validate`, `plan` or
> `apply`.**
>
> Two Phase 11 concerns were built and measured rather than designed --
> pgBouncer, and the role-level database timeouts. Those are real. The rest is
> reviewable design.

---

## 1. What is real vs what is design

| | Status |
|---|---|
| **pgBouncer** in `docker compose --profile scale`, multiplexing measured under load | **Built and proven** |
| **Role-level `statement_timeout` / `lock_timeout`** migration | **Built and proven** |
| The bug that made it necessary | **Found by running it** |
| VPC, ECS, RDS, ElastiCache, ALB, CloudFront, Route 53, WAF | Terraform written, **never applied** |

1,359 lines of Terraform across six files, in `deploy/terraform/`, with a
README that says the same thing at the top.

---

## 2. The bug this phase found

Phase 10 set `statement_timeout` and `lock_timeout` through the connection
string's `options` parameter, and verified them:

```
  statement_timeout=10s  lock_timeout=5s
```

Putting pgBouncer in front **silently disabled both**:

```
  THROUGH pgBouncer: statement_timeout=0  lock_timeout=0
```

`ignore_startup_parameters` does exactly what it says -- pgBouncer **ignores**
the listed parameters rather than forwarding them. `options` has to be listed
there or the connection is rejected outright in transaction mode, so the
setting is dropped either way.

Nothing failed. No warning. The only symptom would have been a query running
forever in production, and a lock wait freezing an account -- the precise
failures Phase 10 added those timeouts to prevent.

**And the Phase 10 chaos test kept passing**, because it connects directly to
Postgres while the containers go through the pooler. A test that exercises a
different path from production proves nothing about production. That is the
part worth keeping.

### The fix

`ALTER ROLE ledgercore SET statement_timeout = '10s'` and friends, as a
migration. Postgres applies role defaults to every session by that role,
however it was opened and whatever pools it. The connection-string `options`
stay as belt and braces for direct connections.

```
  THROUGH pgBouncer: statement_timeout=10s  lock_timeout=5s
  role defaults: statement_timeout=10s, lock_timeout=5s, idle_in_transaction_session_timeout=60s
```

An operational detail that cost a confusing few minutes: after `ALTER ROLE`,
restarting the API changed nothing. pgBouncer keeps its own pool of **server**
connections and reuses them -- the pooler has to be recycled, not the client.

And a third guard in `tests/schema.int.test.ts`, asserting the settings exist
as role defaults and are non-zero. Three tests, and they would have caught this.

---

## 3. pgBouncer, measured

Under 40-concurrent load across three API nodes and three workers:

```
  SHOW POOLS:
  database   | cl_active | cl_waiting | sv_active | sv_idle | sv_used | pool_mode
  ledgercore |        36 |          0 |         0 |       2 |      18 | transaction

  postgres backends: 21    max_connections: 100
```

**36 client connections multiplexed onto 20 Postgres backends, zero waiting.**

Without it: 3 API x 10 + 3 workers x 10 = **60 connections** for a workload
whose steady state was one active backend. The number that matters is not
60 -> 20, it is that the server side is now **bounded by `default_pool_size`
regardless of how many tasks autoscaling adds**. Without a pooler, scaling the
API exhausts the database before it exhausts itself -- and a connection
refusal takes down every node at once rather than degrading one.

### Transaction pooling, and what it costs

`pool_mode = transaction` is where the multiplexing comes from: a server
connection is held for one transaction, not one client session.

The cost is that anything relying on SESSION state breaks, because the next
statement may land on a different backend. Every instance in this codebase is
accounted for:

| Session-scoped thing | Status |
|---|---|
| `statement_timeout` / `lock_timeout` via connection options | **Broke.** Moved to role defaults. |
| Session advisory locks | Not used -- day-end uses `pg_advisory_xact_lock`, which is transaction-scoped |
| `LISTEN` / `NOTIFY` | Not used |
| Server-side prepared statements | Disabled via `?pgbouncer=true`. Without it you get `prepared statement s0 already exists` **intermittently** under load, because it only happens when two clients land on the same backend |

### Also found: a healthcheck that lied

The first pgBouncer healthcheck was `nc -z localhost 6432`. pgBouncer was
serving 143 queries/s perfectly happily, but busybox's `nc` does not support
`-z`, so the check returned 1, the container was marked unhealthy, and **every
API node refused to start** because they wait on `condition: service_healthy`.

A healthcheck that uses a binary the image does not have -- or a flag it does
not support -- reports a healthy service as broken and takes down everything
downstream. Worse than having no healthcheck at all.

---

## 4. Every service: why, what problem, what alternative, what trade-off

The brief is explicit that services do not go on the diagram because they
exist. Three from its suggested stack are deliberately **not** used.

### Route 53

- **Why:** DNS, with alias records at the zone apex.
- **Problem:** a CNAME cannot coexist with the SOA at an apex, so `bank.com`
  cannot point at a CloudFront hostname by CNAME.
- **Alternative:** any DNS provider plus a redirect from apex to `www`.
- **Trade-off:** vendor lock-in for a service that is genuinely commoditised.
  Accepted because alias records are free to query and track target IP changes
  automatically.

### CloudFront

- **Why:** the static React frontend, TLS termination at the edge, and a WAF
  attachment point.
- **Problem it does NOT solve:** caching the API. Almost nothing this API
  returns is cacheable, and a cached balance would be a correctness bug -- the
  same argument as Phase 6's refusal to cache balances in Redis. `/api/*` is
  explicitly `CachingDisabled`.
- **Alternative:** serve the frontend from the ALB, or from S3 with no CDN.
- **Trade-off:** another layer to debug, and a real trap -- the default origin
  request policy strips `Authorization`, so every API call arrives anonymous.
  Fixed with `AllViewerExceptHostHeader`, and worth knowing before it happens.

### ALB

- **Why:** **active health checking**, which is the gap Phase 8 named and could
  not close.
- **Problem:** nginx OSS only does passive checks -- a node is removed after
  two real requests fail. A task whose `/readiness` has gone 503, because it is
  draining or lost its database, keeps receiving traffic until live requests
  break on it. The ALB polls `/readiness` directly, so the Phase 3 drain
  sequence actually works: readiness flips, the ALB stops routing within one
  10-second interval, and only then does the process stop listening.
- **Alternative:** nginx or HAProxy on EC2; NLB.
- **Trade-off:** more expensive than an NLB and terminates at L7 -- which is
  the point, since the health check needs HTTP.
- **This is a measured reason, not a preference.**

### ECS Fargate

- **Why:** the entire scaling story from Phase 8 is "add a task".
- **Alternative (EC2 launch type):** cheaper per vCPU at steady load, and you
  manage AMIs, capacity providers, draining and bin-packing.
- **Alternative (EKS):** the right answer with many teams and many services
  needing namespaces, RBAC and a mesh. This is one team and two services; EKS
  would add a control-plane cost and a great deal of Kubernetes in exchange for
  capabilities nothing here uses.
- **Trade-off:** Fargate's per-vCPU premium is real. Paid deliberately, and
  reduced with ARM64/Graviton (~20% cheaper for the same Node throughput).

### RDS PostgreSQL, Multi-AZ

- **Why:** a synchronous standby with automatic failover.
- **Problem:** the alternative is restoring from a snapshot -- minutes to hours
  of downtime and losing everything since the last backup. Not acceptable for a
  ledger.
- **Alternative (Aurora):** faster failover, storage-level replication, better
  read scaling. Costs more and its connection model differs.
- **Alternative (self-managed on EC2):** cheaper, and you own backups, patching
  and failover.
- **Trade-off:** Multi-AZ roughly doubles the database cost and does **not**
  serve reads. Read scaling is a separate decision -- see section 5.

### ElastiCache Redis, TWO clusters

- **Why:** Phases 6 and 7 established that the cache and the queue need
  opposite configurations, so they cannot share an instance.

  ```
  cache  allkeys-lru, no persistence   evicting is CORRECT; everything is
                                       reconstructible from Postgres
  queue  noeviction, AOF               evicting a job means work silently
                                       vanishes with no error anywhere
  ```

- **Alternative:** one cluster, two logical databases. **Rejected** --
  `maxmemory-policy` is instance-wide, so one setting has to be wrong.
- **Trade-off:** two clusters, two bills. The local compose file already models
  this, and running BullMQ on an LRU cache is the specific trap being avoided.

### pgBouncer, as a task SIDECAR

- **Why:** section 3.
- **Alternative (RDS Proxy):** managed, IAM-native, survives failover more
  gracefully. Costs per vCPU-hour of the proxied database and adds a network
  hop.
- **Alternative (shared pgBouncer service):** better multiplexing across the
  whole fleet, at the cost of a single point of failure in front of the
  database.
- **Chosen:** sidecar. It multiplexes the task's own connections over
  loopback, dies with the task it serves, and needs no password file. **At more
  than roughly 20 tasks, switch to RDS Proxy** -- the per-task pools stop
  multiplexing usefully once there are many of them.

### WAF

- **Why:** managed rule sets and a coarse per-IP rate limit at the edge.
- **Does NOT replace** the Phase 6 application rate limiting. The WAF rule is
  per-IP and blunt; the application's posting limit is **per user**, because a
  branch sits behind one NAT address and an IP limit would throttle the whole
  branch because one teller is fast. Two layers doing different jobs.

### Secrets Manager

- **Why:** the RDS password is generated and rotated by AWS and injected by
  ECS. It never appears in the task definition, in Terraform state, or in a log.
- **Alternative (SSM Parameter Store):** cheaper, no automatic rotation.
- **Trade-off:** Secrets Manager costs per secret per month. Worth it for a
  credential that should rotate.

---

## 5. What the brief listed that this deliberately does NOT use

### SQS -- not adopted

The brief's diagram has SQS. Phase 2 committed to "BullMQ locally, SQS as the
documented AWS option", and Phase 7 noted the `JobQueue` interface exists so the
swap is one adapter.

Having built the async pipeline, **the honest answer is to keep BullMQ on
ElastiCache**, and it is worth stating why rather than following the diagram:

| Feature used | BullMQ | SQS |
|---|---|---|
| Delayed jobs | any delay | **15 minutes maximum** |
| Repeatable / cron jobs | `upsertJobScheduler` | none -- needs EventBridge |
| Retries with exponential backoff | built in | visibility timeout, manual backoff |
| Dead-letter queue | built in, plus a Postgres record | built in (better) |
| Job progress / inspection | yes | no |
| Ordering | per-queue | FIFO queues, with a throughput ceiling |

Phase 7's maintenance jobs are **cron** (hourly purges, a daily partition
check). SQS has no scheduling, so adopting it means adding EventBridge rules
and splitting the scheduling story across two systems.

And the decisive point: **ElastiCache is already there for the cache**, so
BullMQ costs one extra small cluster, not a new dependency.

**Where SQS would win:** if the fan-out consumers grew far beyond the queue
Redis's capacity, or if a consumer were a Lambda, or if a queue had to be
consumed by another team's service. None of those is true.

The adapter is deliberately **not written**. Writing an adapter for something
that should not be adopted is worse than not writing it -- it implies a
recommendation the analysis does not support. The interface remains, so the
decision stays reversible.

### EC2 -- not used

The brief's diagram says "EC2 / ECS". Fargate, for the reasons above.

### Read replica -- not yet

Phase 2 planned replica routing for statements and reports. Phase 8 measured
Postgres at **21-58% CPU while the API saturated at 175%**, with one active
backend at steady state. The database is not the bottleneck, so a replica would
add replication lag -- and the risk of a teller reading a stale balance -- to
solve a problem that does not exist yet.

The trigger to add one is a measurement, not a milestone: read latency rising
while write latency is flat, or `pg_stat_statements` showing report queries
dominating. Stated so nobody adds it "because the architecture diagram had one".

---

## 6. What the Terraform closes from earlier phases

| Gap | Phase | Closed by |
|---|---|---|
| No active health checking | 8 | ALB `health_check` on `/readiness`, 10s interval |
| nginx is a single point of failure | 8, 10 | ALB is managed and multi-AZ |
| No connection pooling | 8, 10 | pgBouncer sidecar (**built and measured**) |
| `/metrics` unauthenticated | 9 | Security group allowing only the scraper |
| No autoscaling | 8 | Target tracking: API on requests-per-target, worker on queue depth |
| No TLS | 8 | ACM at CloudFront and the ALB, TLS 1.2 minimum |
| No automated rollback | 10 | `deployment_circuit_breaker { rollback = true }` |
| `ConnectionPoolExhausted` was a proxy metric | 9 | pgBouncer `SHOW POOLS` exposes `cl_waiting` directly |

The autoscaling signals are the Phase 2 argument made concrete: the API scales
on **requests per target**, the worker on **queue depth**. Scaling the worker
on CPU would be wrong -- a worker waiting on a slow SMS gateway has low CPU and
a growing backlog, which is exactly when more are needed.

---

## 7. Still open

1. **None of the Terraform has been validated or applied.** The single largest
   caveat in this project.
2. **No cost model.** A real proposal needs a monthly figure. Multi-AZ RDS and
   two ElastiCache clusters are the expensive items.
3. **No disaster-recovery runbook.** Backups exist; a tested restore does not.
   An untested backup is a hope.
4. **No blue/green.** Rolling with a health gate and automatic rollback, which
   covers most of it. Phase 13 discusses the rest.
5. **The Prometheus stack is local only.** Production would use AMP plus
   Grafana, or ship to CloudWatch. The alert rules from Phase 9 are portable;
   the deployment is not written.
6. **Carried over:** `invalidateBusinessDate` has no caller (Phase 6); the AML
   workflow is data only (Phase 7); no bulkheads (Phase 10).

---

## 8. Interview questions this phase should let you answer

1. Why an ALB rather than running nginx as your load balancer? (Expected:
   active health checks on `/readiness`, which is what makes a graceful drain
   work.)
2. Your architecture diagram had SQS. You did not use it. Why?
3. Why two ElastiCache clusters instead of two databases on one?
4. What does transaction pooling break, and how did you find out?
5. You added pgBouncer and two safety settings silently turned off. What
   happened, why did the tests not catch it, and what did you change?
6. Why are the database timeouts role defaults rather than connection
   parameters?
7. Fargate or EC2? ECS or EKS? Defend both.
8. Why is there no read replica?
9. Your data subnets have no NAT route. What does that buy you?
10. Why does the API autoscale on request count and the worker on queue depth?
11. What is the ALB `deregistration_delay` doing, and how does it relate to
    your application's drain sequence?
12. CloudFront sits in front of a banking API. What must never be cached, and
    what did you have to configure so authentication still worked?
13. When would you move from a pgBouncer sidecar to RDS Proxy?

---

## 9. Next

**Phase 12 -- Docker**, which is largely already done: multi-stage build,
non-root, tini as PID 1, the Alpine/OpenSSL Prisma trap, and the graceful
shutdown proven at exit 0. What remains is the worker image variant, image
scanning and a documented build/run story.

**Phase 13 -- CI/CD** then covers the pipeline, deployment strategies
(rolling, blue/green, canary) and rollback.
