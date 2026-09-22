# Phase 9 -- Production Engineering

> Built and verified 2026-09-22. Structured logging landed in Phase 3; this
> phase is metrics, and the alert rules that make each number actionable.

---

## 1. What we built

```
  src/shared/metrics/registry.ts    all metric definitions, in one place
  src/shared/metrics/collector.ts   samples gauges that must be queried
  src/middleware/metrics.ts         HTTP histogram + /metrics endpoint
  src/worker.ts                     its own metrics server on :9101
  deploy/prometheus/prometheus.yml  scrape config
  deploy/prometheus/alerts.yml      14 alert rules, each with a runbook
  scripts/load.mjs                  the load generator used since Phase 6
```

`docker compose --profile scale up -d --scale worker=3` now brings up
Prometheus alongside the three API nodes and three workers.

```
=== Prometheus scrape targets ===
  ledgercore-api      api-1:4000                up
  ledgercore-api      api-2:4000                up
  ledgercore-api      api-3:4000                up
  ledgercore-worker   ledgercore-worker-1:9101  up
  ledgercore-worker   ledgercore-worker-2:9101  up
  ledgercore-worker   ledgercore-worker-3:9101  up
  prometheus          localhost:9090            up
```

---

## 2. Every number the brief asked for, measured live

Sampled from Prometheus during a sustained 90-second load across three nodes:

```
=== RATE ===
  requests/sec (fleet)                      145.0
  requests/sec per node
      api-2:4000                             52.8
      api-1:4000                             46.3
      api-3:4000                             46.2

=== DURATION (fleet-wide, from additive buckets) ===
  p50 latency                                37.1 ms
  p95 latency                                91.1 ms
  p99 latency                               136.9 ms

=== SATURATION ===
  in-flight requests                          9
  worst event loop lag                       19 ms
  RSS per node                              123 MB

=== DEPENDENCIES ===
  db query p99                              62.5 ms
  cache hit ratio                            1.000
  cache available                            1

=== BUSINESS ===
  vouchers_posted_total{TRANSFER}             3
  vouchers_rejected_total{VOUCHER_NOT_BALANCED}  1
  auth_failures_total{unknown_user}           2
  vouchers_pending_authorisation             22
  dead_letters_unreplayed                    32

=== ASYNC ===
  outbox_oldest_pending_seconds               0
  queue_depth{state="waiting"} per queue      0
```

Cross-check against the load generator's own client-side measurement:

```
  client-measured: rps=342  p50=50.1  p95=115.6  p99=150.9
  prometheus:      rps=145  p50=37.1  p95= 91.1  p99=136.9
```

The RPS gap is explained, not hand-waved: Prometheus was sampled 50 seconds
into a 90-second run using a `[2m]` rate window, so 70 of those 120 seconds
had no traffic. `50/120 x 342 = 143`, against a measured 145. The latency gap
is server-side vs client-side -- the client's numbers include its own network
hop and event-loop scheduling.

---

## 3. The decisions that matter

### 3.1 Histogram, not Summary

prom-client offers both. A **Summary** computes quantiles inside the process,
so a p99 from api-1 and a p99 from api-2 cannot be combined -- averaging
percentiles is meaningless. With three nodes that makes summaries useless for
exactly the question being asked.

A **histogram** ships bucket counts, which are additive. Prometheus sums them
across instances and computes the quantile over the whole fleet. That is what
the `sum by (le) (rate(..._bucket[2m]))` in every latency query above is doing,
and it is why the p99 in section 2 is a real fleet-wide figure rather than an
average of three lies.

The cost is bucket resolution, which is why the buckets are chosen from the
measurements in Phases 6 and 8 rather than left at prom-client's defaults --
the defaults put almost everything in this system into one or two buckets.

### 3.2 Cardinality: the route label must be the TEMPLATE

```
  wrong:  /api/v1/branches/553bc38e-3968-43aa-b6c5-f7e660e1417c
  right:  /api/v1/branches/:id
```

Every distinct label combination is a permanent time series, held in memory on
every node. A raw URL label creates one per account id; a `userId` label
creates one per user. That is the classic one-line change that takes down a
Prometheus server.

Two details this needed:

- Express populates `req.route` only AFTER routing, and `req.route.path` is
  relative to its router -- so `/branches/:id` comes back as `/:id`. The label
  is built by joining `req.baseUrl` with it.
- A request that matched nothing (a scanner probing `/wp-admin`) has no
  `req.route` at all. Those collapse to a single `unmatched` label rather than
  leaking attacker-controlled cardinality.

Status is labelled as a **class** (`2xx`, `4xx`, `5xx`), five values instead of
sixty. The exact status and the error code go on the separate `http_errors_total`
counter, where the code is a bounded set from Phase 3's error hierarchy.

Everything unbounded -- user, account, request id, error message -- stays in
logs, where one line costs bytes rather than a permanent series.

### 3.3 Why `/metrics` is unauthenticated, and why that is safe

Prometheus has no credentials. The standard answer is network restriction, and
Phase 11 puts a security group in front of it.

What makes that acceptable is the cardinality discipline above: there are no
account numbers, amounts, user ids or messages in any label. The endpoint
exposes **shape and volume, not content**. If it exposed content, "restrict it
at the network layer" would not be good enough.

### 3.4 Gauges are sampled on a timer, not inside the scrape handler

`outbox_oldest_pending_seconds`, queue depth, pending authorisations and
unreplayed dead letters are properties of current state -- nothing "happens" to
make them change, so they have to be queried.

Doing that inside the `/metrics` handler would mean a slow database makes the
scrape time out, Prometheus records the target as DOWN, and monitoring fails at
exactly the moment it is most needed. A 15-second collector means a scrape only
reads memory. The gauges are up to one interval stale, which for values moving
on the scale of minutes is irrelevant.

Each gauge is collected in its own try/catch: a failure on one must not stop
the others, because partial metrics beat none.

### 3.5 Each node is scraped individually, not through the load balancer

Scraping through nginx would hit a different node each time, so every series
would jump between instances and per-node problems would average away --
"one node has a blocked event loop" would read as "everything is slightly
slow". Histograms are additive, so aggregation happens at query time, which is
the right place for it.

### 3.6 The worker has its own scrape endpoint

It has no HTTP surface otherwise, but its metrics -- queue depth, job
durations, dead letters -- are the ones that matter most for the async
pipeline, and Prometheus can only pull.

Health endpoints are deliberately NOT added to it: the worker has no readiness
concept (nothing routes to it), and adding one would invite an orchestrator to
restart a perfectly healthy worker mid-job.

### 3.7 Event loop lag is THE Node-specific metric

A blocked event loop does not raise CPU to 100% and does not show up as a slow
query. Every request simply waits.

It is the metric that distinguishes **"the database is slow"** from **"we are
doing something CPU-bound on the request path"** -- two very different
incidents with an identical symptom. Measured at 19 ms under load here, which
is healthy; the alert fires at 500 ms.

### 3.8 Business metrics, because a healthy system can still be broken

`vouchers_posted_total` dropping to zero is a better alert than any
infrastructure metric, because it fires for causes nobody predicted: a wrong
permission grant, a batch left closed, a broken frontend deploy. Every
infrastructure dashboard can be green while the bank has stopped working.

`vouchers_rejected_total` is labelled by the business rule that refused the
posting. A spike in `INSUFFICIENT_FUNDS` is a business event; a spike in
`DAY_NOT_OPEN` means somebody forgot to run day-begin. Neither is visible in an
HTTP status alone -- they are all 422.

`auth_failures_total` is labelled by reason even though the client is told
nothing: a spike in `unknown_user` is credential stuffing, a spike in
`bad_password` against valid accounts is spraying. The response stays
byte-identical either way (Phase 4), so the attacker learns nothing while the
operator learns everything.

---

## 4. Alerting

14 rules, all loaded and evaluating:

```
  [ledgercore-symptoms]     HighErrorRate, HighLatencyP99, EventLoopBlocked,
                            NoPostingsDuringBusinessHours
  [ledgercore-async]        OutboxRelayStopped, QueueBacklogGrowing,
                            JobsDeadLettering, DeadLettersUnattended
  [ledgercore-dependencies] CacheDegraded, DatabaseSlow, ConnectionPoolExhausted
  [ledgercore-security]     CredentialStuffingSuspected, PasswordSprayingSuspected,
                            AmlAlertSpike
```

### Principles

**Alert on symptoms, not causes.** "Database CPU is 80%" may be entirely fine.
"p99 is 3 seconds" never is. Paging on causes trains people to ignore the
channel, which is how a real incident gets missed.

**Every rule carries a runbook.** An alert that does not say what to do is just
an interruption.

**Page vs ticket is a deliberate distinction.** `CacheDegraded` is a ticket,
not a page, because Phase 6 proved the API keeps working with Redis down --
slower, not broken. Paging for a degradation the system is designed to absorb
is how alert fatigue starts.

**Thresholds come from measurements, not round numbers.** `HighLatencyP99`
fires at 2s because Phase 8 measured p99 at 390-810 ms under load with three
nodes -- comfortably above normal-but-busy, well below "users have given up".

### The most important rule, and why

```yaml
- alert: OutboxRelayStopped
  expr: max(outbox_oldest_pending_seconds) > 300
```

If the relay stops, **the queue is EMPTY and every queue-depth dashboard goes
green** while events pile up in Postgres. Queue depth cannot detect a stopped
producer. This is the only thing that can.

Proven by stopping all three workers and inserting a 20-minute-old event:

```
  outbox oldest pending (s)               1238
  total queue depth waiting               (no data)     <- green, and wrong

  ...after `for: 2m`:

  OutboxRelayStopped   page   FIRING   value=1388
      Oldest unpublished outbox event is over 5 minutes old
      runbook: The relay has stopped or is failing. Check the worker process is
               alive and outbox_events_published_total{result='failed'}. Events
               are durable -- nothing is lost, but nothing downstream is
               happening either.
```

Restarting the workers drained the outbox (341 SENT, 0 pending) and the alert
cleared on its own.

---

## 5. The bug the alert itself had

Firing `OutboxRelayStopped` produced **three identical pages** -- one per API
node:

```
  OutboxRelayStopped  page  FIRING  value=1388
  OutboxRelayStopped  page  FIRING  value=1388
  OutboxRelayStopped  page  FIRING  value=1388
  DeadLettersUnattended  ticket  PENDING  value=32
  DeadLettersUnattended  ticket  PENDING  value=32
  DeadLettersUnattended  ticket  PENDING  value=32
```

Every node reports the gauge, so `expr: outbox_oldest_pending_seconds > 300`
produced one alert per series -- for a condition that is **global**, because
the outbox is a single shared table.

Fixed with `max(...)`, and confirmed:

```
  NoPostingsDuringBusinessHours  1 alert(s)
  OutboxRelayStopped             1 alert(s)
  DeadLettersUnattended          1 alert(s)
```

**The rule, and the part that takes judgement:** aggregate away the instance
label for a GLOBAL condition, and keep it for a PER-NODE one. `CacheDegraded`
and `EventLoopBlocked` are deliberately left un-aggregated, because one node
losing Redis or blocking its event loop while the others are fine is exactly
what you want to see -- a `min()` there would hide a degraded node behind two
healthy ones.

Getting this backwards in either direction is a real production problem:
duplicate paging in one direction, invisible single-node failures in the other.

### A smaller finding worth knowing

`vouchers_posted_total` and `auth_failures_total` reported **"(no data)"** until
the first posting and the first failed login after a restart. A labelled
prom-client counter does not exist until it is incremented once.

That matters for dashboards and for `absent()`-style alerting: a missing series
and a healthy zero look identical. It is also why `outboxOldestPendingSeconds`
is explicitly `.set(0)` when nothing is pending rather than left unreported.

---

## 6. What can fail

| Failure | What shows it | Alert |
|---|---|---|
| A node's event loop blocks | `nodejs_eventloop_lag_seconds`, per node | EventLoopBlocked (page) |
| The database gets slow | `db_query_duration_seconds` p99 | DatabaseSlow (page) |
| Redis dies | `cache_available` 0, hit ratio drops, p99 rises ~3x | CacheDegraded (ticket -- degraded, not broken) |
| The relay stops | `outbox_oldest_pending_seconds` climbs; queue depth stays ZERO | OutboxRelayStopped (page) |
| Consumers fall behind | `queue_depth{state="waiting"}` | QueueBacklogGrowing (ticket) |
| Work is being lost | `jobs_processed_total{result="dead_lettered"}` | JobsDeadLettering (ticket) |
| Nobody drains the DLQ | `dead_letters_unreplayed` | DeadLettersUnattended (ticket) |
| The bank stops working for an unpredicted reason | `vouchers_posted_total` flat | NoPostingsDuringBusinessHours (page) |
| Credential stuffing | `auth_failures_total{reason="unknown_user"}` | CredentialStuffingSuspected |
| Password spraying | `auth_failures_total{reason="bad_password"}` | PasswordSprayingSuspected |
| A mis-tuned AML rule after a version bump | `aml_alerts_raised_total` | AmlAlertSpike |
| Prometheus itself down | Its own target goes down | (needs an external check -- gap) |

### Honest gaps at the end of Phase 9

1. **No Alertmanager.** Rules evaluate and fire in Prometheus, but nothing
   routes them to a human. Alertmanager plus a Slack/PagerDuty receiver is the
   missing piece; the rules are written for it (severity labels, runbooks).
2. **No dashboards.** Every number is queryable; none is charted. Grafana is
   half an hour of work and adds no engineering insight, so it was skipped in
   favour of making the rules correct.
3. **No distributed tracing.** The requestId gives log correlation across the
   API and workers (Phase 7), which covers most of what tracing would -- but
   there are no spans and no flame graph. OpenTelemetry is the next step.
4. **Nothing watches Prometheus.** A monitoring system that can fail silently
   is a gap; it needs an external dead-man's-switch.
5. **Retention is 6 hours** in this compose setup. Fine for a demo, useless for
   capacity planning.
6. **`ConnectionPoolExhausted` is a proxy expression**, not a direct
   measurement -- Prisma does not expose pool saturation. pgBouncer in Phase 11
   does expose it, which is the real fix.
7. **Carried over and still open:** `invalidateBusinessDate` has no caller
   (Phase 6); the AML alert workflow is data only (Phase 7).

---

## 7. Interview questions this phase should let you answer

1. You run three nodes. Why is a Summary useless for p99 and a Histogram not?
2. What is wrong with putting the URL in a metric label? What about the user id?
3. How do you get `/api/v1/branches/:id` rather than the actual id, given that
   Express stores the path relative to its router?
4. Your `/metrics` endpoint has no auth. Defend that.
5. Why is queue depth collected on a timer rather than inside the scrape
   handler?
6. Why scrape each node directly instead of through the load balancer?
7. Your relay stops. Queue depth is zero and every dashboard is green. Which
   metric catches it, and why can queue depth not?
8. p99 latency has doubled. What do you look at first, and why?
9. What is event loop lag and why does it matter more in Node than elsewhere?
10. Why is `CacheDegraded` a ticket and `DatabaseSlow` a page?
11. You alert on `vouchers_posted_total == 0`. Is that not a business metric
    rather than an engineering one? (Expected: yes, and that is the point -- it
    catches incidents no infrastructure metric predicts.)
12. Your alert fired three times for one problem. Why, and how do you decide
    which alerts to aggregate and which to leave per-instance?
13. A dashboard panel shows "no data". Is the system healthy or is the metric
    missing? How would you tell them apart?
14. Where did your alert thresholds come from?

---

## 8. Next

**Phase 10 -- failure handling**, which the brief lists as its own phase:
what happens when a node crashes, Redis goes down, the database gets slow or
disappears, the queue dies, a worker crashes, the network degrades, traffic
goes up 10x, and a duplicate request or event arrives.

Much of that has already been built and proven in place -- degradation in
Phase 6, at-least-once and the DLQ in Phase 7, node death in Phase 8. Phase 10
is where the remaining pieces go in: timeouts on every outbound call, a circuit
breaker, and a written failure-mode table tying each mechanism to the incident
it is for.
