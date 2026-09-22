# Phase 16 -- Production Incident Simulations

Status: complete.

> **Every incident here is a SIMULATED PRODUCTION SCENARIO**, run against the
> local compose stack by stopping, pausing or breaking a dependency on purpose.
> No real users were affected, no real outage occurred, and no traffic figure
> in this document comes from anything but a load generator on one laptop.

The point of the phase was to stop believing the resilience documentation and
test it. Five incidents were run. **Three of them found that a control the
earlier phases described as protecting the system was not connected to
anything.**

---

## 1. Summary of what the incidents found

| # | Incident | What the system did | What it revealed |
|---|---|---|---|
| 1 | Cache Redis stopped | Degraded, 0 errors | Phase 6's claim holds |
| 2 | Postgres stopped | readiness 503, auto-recovery | Container healthcheck is slower than the outage |
| 3 | pgBouncer paused (hung) | No pile-up, 1.1% errors | Timeout budget works; cache absorbed most of it |
| 4 | Cache **hung** (paused) | **58 rps, and invisible** | Hung is 2.4x worse than dead, and no alert fires |
| 5 | Dead-letter queue opened | 2,116 AML jobs dead | AML screening had silently stopped; no replay path existed |

Three controls turned out to be unreachable:

- `CircuitBreaker` -- 13 unit tests, **never instantiated anywhere**
- `replayDeadLetter()` -- integration tests, **no caller outside them**
- load shedding -- mounted, but counting into a process-local variable **no
  metric, no way to know it had ever fired**

All three were correct code. That is the uncomfortable part: a passing test
suite and a code review both pass a control that nothing calls.

---

## 2. Incident 1 -- cache Redis stopped

**Simulated production scenario.** `docker stop ledgercore-redis` under load.

**Detection.** `cache_available` went to 0 on all three nodes. `CacheDegraded`
moved to pending -- and correctly **per node**, not aggregated, because one node
can lose Redis while the others are fine.

**Measured.**

| | rps | p50 | p99 | errors |
|---|---|---|---|---|
| healthy | 571 | 27.7ms | 117.9ms | 0 |
| cache stopped | **142** | 112.5ms | 516.0ms | **0** |

**Diagnosis.** Every read fell through to Postgres. Four times slower, and not
one request failed.

**Mitigation.** None needed. `docker start` and the cache repopulated itself;
`cache_available` returned to 1 with no intervention.

**RCA.** Working as designed. Phase 6 said "degraded, not broken" and it is
true. The alert is deliberately a ticket, not a page.

---

## 3. Incident 2 -- Postgres stopped

**Simulated production scenario.** `docker stop ledgercore-postgres` under load,
for 26 seconds.

**Detection.**

```
/health    -> status=degraded  db=down  cache=up
/readiness -> HTTP 503
```

**The finding.** All three containers continued to report `healthy` to Docker
for the entire outage.

The HEALTHCHECK probes `/readiness`, which was correctly returning 503. But it
runs at `interval=15s` with `retries=3` -- **up to 45 seconds to flip**, and the
outage was 26. The signal was right and the reporting was too slow to say so.

That matters wherever an orchestrator routes on the container's health state: a
node whose database is gone keeps receiving traffic for up to 45 seconds. The
Phase 11 ALB is better (`interval=10`, `unhealthy_threshold=2` = 20s) but the
same class of lag applies.

**Mitigation.** `docker start`; readiness returned to 200 on its own.

**RCA.** Two different questions were being conflated. `/readiness` answers
"should traffic come here" in real time, and did. The container healthcheck
answers "should this container be replaced", and is deliberately slow so a
transient blip does not cause a restart storm. Using the slow one to make the
fast decision is the bug -- which is exactly why the load balancer, not Docker,
should poll `/readiness`.

---

## 4. Incident 3 -- a dependency that hangs instead of dying

**Simulated production scenario.** `docker pause ledgercore-pgbouncer`.
Connections stay open. Nothing is answered. No TCP error is ever returned.

**Measured over the run:** 10,010 requests, **115 errors (1.1%)**, p99 181ms,
max 2,808ms. In-flight requests stayed at 5-8 per node.

**Diagnosis.** Two things absorbed it. The Phase 10 timeout budget meant
requests failed at a bound instead of hanging, so in-flight never piled up and
load shedding was never needed. And the Phase 14 user cache meant most reads
did not touch the database at all.

**RCA.** This is the good case, and worth noticing why: the system was
protected by a timeout, not by detecting the hang. Nothing ever concluded "the
database is unreachable" -- every request simply gave up individually. That
observation is what led to Incident 4.

---

## 5. Incident 4 -- the cache hangs, and nobody notices

**Simulated production scenario.** `docker pause ledgercore-redis`.

**Measured.**

| | rps | p50 | p99 | `cache_available` |
|---|---|---|---|---|
| healthy | 571 | 27.7ms | 117.9ms | 1 |
| cache **stopped** | 142 | 112.5ms | 516.0ms | **0** |
| cache **hung** | **58** | **335.5ms** | 414.6ms | **1** |

Two findings, and the second is worse than the first.

**A hung dependency did 2.4x more damage than a dead one.** A dead Redis is
cheap: ioredis marks the client unavailable and `safely()` returns the fallback
without a syscall. A hung Redis keeps its connections open and answers nothing,
so **every single request pays the full `REDIS_COMMAND_TIMEOUT_MS`** before
falling back to the same answer. The system did four times the work to produce
an identical result.

**And it was invisible.** `cache_available` stayed at 1 the whole time, so
`CacheDegraded` never fired. The system believed the cache was healthy while it
was the single most expensive thing happening to it.

### The control that did not exist

The obvious fix is a circuit breaker: after N consecutive timeouts, stop calling
the dependency at all. Phase 10 built one.

```
$ grep -rn "new CircuitBreaker" src/ | grep -v circuitBreaker.ts
(nothing)
```

**Never instantiated.** 13 unit tests, all passing, on a class nothing used --
while PHASE10_FAILURE_HANDLING.md described it as protecting the system.

It is now wired into `safely()` -- 5 consecutive failures to open, 5s cooldown,
2 successes to close -- and `cache_circuit_state` is exported so it is visible.
An OPEN circuit also forces `cache_available` to 0, so the existing alert covers
the hung case too.

**Measured after, same session:**

| hung cache | rps | p50 | p99 | detection |
|---|---|---|---|---|
| before | 58 | 335.5ms | 414.6ms | `cache_available=1` -- silent |
| **after** | **303** | **59.4ms** | 180.1ms | `circuit_state=2 (OPEN)`, `available=0` |
| reference: dead | 358 | 50.1ms | 144.8ms | |
| reference: healthy | 532 | 35.0ms | 79.3ms | |

**5.2x throughput recovered**, and the hung case now behaves like the dead case
-- which is precisely the design intent: *convert slow failure into fast
failure*. Recovery was automatic; all three nodes closed their circuits on their
own once Redis answered again.

(The dead-cache figure differs between the two tables -- 142 earlier, 358 here
-- because of the host drift documented in Phase 15. The same-session table is
the valid comparison.)

---

## 6. Incident 5 -- opening the dead-letter queue

**Simulated production scenario.** None, in the end. `DeadLettersUnattended`
had been sitting in *pending* through several earlier incidents and was nearly
dismissed as leftover test noise. It was not.

```
queue        unreplayed  replayed  most recent error
aml                2116         0  rule.threshold.toFixed is not a function
events               18        18  SIMULATED failure
```

**2,116 dead AML evaluations.** For a bank, AML screening not running is a
compliance failure, not a bug report. Every one of them had been retried five
times and given up.

### Root cause: the same trap, a third time

AML rules are cached. `AmlRule.threshold` is a Prisma `Decimal`. JSON has no
Decimal, so on a cache HIT it came back as a **string**, while the type still
said `Decimal` -- `cached<T>` parses with `JSON.parse` and casts with `as T`,
and the compiler happily agrees.

What let it survive review:

```ts
if (total.lessThan(rule.threshold)) continue;   // decimal.js accepts a string. Works.
...
threshold: rule.threshold.toFixed(2),           // string has no toFixed. Throws.
```

The comparison tolerated the wrong type. The line that throws is three lines
further on, inside the branch that **raises** an alert. So the bug only appeared
when a rule actually fired, on a cache hit. Every quiet evaluation looked fine.

This is the third occurrence of one root cause:

1. business date, Phase 6 -- caught, revived by hand at the call site
2. user record, Phase 14 -- `passwordChangedAt.getTime()`, caught in review
3. AML rules, Phase 16 -- **not caught**, 2,116 silent failures

### Fixed structurally, not locally

`cached()` now takes a `revive` hook, and it is applied to the **loader result
as well as the cache hit**. That second half is the important one: if it ran
only on hits, a miss would return a `Decimal` and a hit a `string`, so the shape
would depend on cache state -- which is exactly how this stayed invisible until
a rule crossed its threshold.

Two regression tests assert the property directly: *a miss and a hit return the
same shape.* One of them deliberately documents the trap without a reviver,
rather than hiding it.

**Verified:** 139 new vouchers posted -> **0 new dead letters**, and AML alerts
were actually raised for the first time (19 across all three rules). Before the
fix, every rule that fired crashed.

### And there was no way to replay them

`replayDeadLetter()` existed, with integration tests. `dead_letter` had
`replayed_at` and `replayed_by_id`. There was a `dead_letters_unreplayed` metric
and an alert on it. An entire apparatus for something no operator could
actually do -- the second control in this codebase built, tested and connected
to nothing.

`scripts/replay-dlq.ts` now provides it:

```bash
pnpm dlq:list
pnpm dlq:replay -- --queue aml --limit 100 --dry-run
pnpm dlq:replay -- --queue aml --limit 100 --operator S001
```

A CLI rather than an HTTP endpoint, because replaying jobs re-runs
money-adjacent work and should need shell access rather than a bearer token
some integration might hold. `--limit` defaults low: replaying all 2,116 at once
would recreate the very incident that produced them -- Phase 15 measured that
burst taking Postgres to 594% CPU.

**Measured mitigation:** 200 dead letters replayed in two batches, **0 new dead
letters**, 100 "job completed" per batch.

### Two more findings fell out of using it

**The script did not typecheck.** `tsconfig.json` included `src/`, `prisma/`
and `tests/` -- not `scripts/`. `replay-dlq.ts` shipped importing a
`closeQueues()` that does not exist. `pnpm typecheck` passed, CI passed, and it
died on its first run. Operator tooling reached for during an incident is the
worst possible place for an untypechecked import. `scripts/**/*.ts` is now in
the include list.

**Prisma logged handled errors as errors.** Replaying 100 dead letters produced
100 "job completed" -- and **526 ERROR lines**:

```
Unique constraint failed on the fields: (dedupe_key)
```

That constraint is the AML idempotency guard doing its job: a re-evaluated
voucher hits it instead of raising a duplicate alert, and the application
catches P2002 and logs at DEBUG. Nothing was wrong. The error log said
otherwise, five hundred times.

Prisma's `$on('error')` fires for every driver error regardless of whether the
caller handled it. Expected constraint violations are now demoted to debug.

**Measured after:** the same operation produced **0 error lines** -- 112 info
and 9 warn, and the 9 warns are genuine "AML alert raised" events, which is
exactly what should be at warn.

---

## 7. What can fail

- **Believing a control exists because the class does.** Three here. `grep` for
  the constructor, not the file.
- **A dependency that hangs rather than dies.** Worse than an outage, and the
  health signal may not notice at all.
- **A health signal that only models `up`/`down`.** `cache_available` had no way
  to express "responding, but uselessly slow".
- **Conflating "should traffic come here" with "should this be restarted".**
  The first must be fast, the second must be slow, and using the slow one for
  the fast decision costs 45 seconds of traffic to a dead node.
- **A type that lies after a serialisation boundary.** `as T` is a promise the
  compiler cannot keep. Three occurrences, one of them silent.
- **A bug that only manifests on the success path.** The AML failure needed a
  cache hit AND a rule crossing its threshold. Everything else looked fine.
- **An alert in `pending` that gets dismissed as noise.** This one was right.
- **Expected errors logged at error level.** 526 of them for a fully successful
  operation. That is how an error log becomes something people scroll past.
- **Tooling outside the typecheck boundary.** It fails when you need it most.

---

## 8. How to debug it

```bash
# Run an incident
docker stop  ledgercore-redis         # dependency DIES
docker pause ledgercore-redis         # dependency HANGS  <- the nastier one
docker pause ledgercore-pgbouncer
docker unpause ledgercore-redis

# Always measure the incident window ITSELF, not a run that spans it
node scripts/load.mjs http://localhost:8080 during 20 25000

# What does the system think is happening
curl -s localhost:8080/health | python -m json.tool
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/readiness
for n in 1 2 3; do docker exec ledgercore-api-$n wget -qO- -T 5 \
  http://127.0.0.1:4000/metrics | grep -E 'cache_available|cache_circuit_state|shed'; done
curl -s localhost:9090/api/v1/alerts | python -m json.tool | grep -A2 alertname

# Is a control actually wired to anything?
grep -rn "new CircuitBreaker" src/ | grep -v circuitBreaker.ts
grep -rn "replayDeadLetter"   src/ | grep -v consumer.ts

# The dead-letter queue is the first place to look after ANY incident
pnpm dlq:list
pnpm dlq:replay -- --queue aml --limit 25 --dry-run

# Log level distribution -- noise is a finding
docker logs ledgercore-worker-1 --since 5m 2>&1 \
  | python -c "import sys,json,collections;c=collections.Counter(json.loads(l).get('level') for l in sys.stdin if l.startswith('{'));print(c)"
```

---

## 9. Interview questions

**Q1. Tell me about an incident you ran and what it found.**
I paused Redis rather than stopping it -- a hung dependency instead of a dead
one. Throughput fell from 571 to 58 requests a second, which is **2.4 times
worse than killing Redis outright**, because a dead client short-circuits
immediately while a hung one makes every request pay the full command timeout to
reach the same fallback. Worse, `cache_available` stayed at 1, so no alert
fired. The system believed the cache was healthy while it was the most expensive
thing happening to it.

**Q2. How did you fix it?**
A circuit breaker on the cache path -- five consecutive failures to open, a five
second cooldown, two successes to close -- and a `cache_circuit_state` metric so
it is visible, with an open circuit forcing `cache_available` to 0 so the
existing alert covers the hung case. Throughput during the same incident went
from 58 to 303 requests a second, which is essentially the dead-cache number.
That is the whole point of a breaker: it converts slow failure into fast
failure. Recovery was automatic on all three nodes.

**Q3. Was there anything embarrassing about that fix?**
Yes. The circuit breaker already existed. It had been written two phases
earlier with thirteen passing unit tests, and the documentation described it as
protecting the system. `grep -rn "new CircuitBreaker"` returned nothing outside
its own file -- it had never been instantiated. The same was true of the
dead-letter replay function, and load shedding was mounted but exported no
metric. Three controls, all correct code, none reachable. A passing test suite
does not tell you a control is connected, and neither does a code review.

**Q4. Walk me through your worst root cause.**
The dead-letter queue had 2,116 failed AML evaluations, all with
`rule.threshold.toFixed is not a function`. AML rules are cached, `threshold` is
a Prisma Decimal, JSON has no Decimal -- so on a cache hit it came back a string
while the type said Decimal, because the cache helper casts with `as T`. What
made it survive review is that the threshold COMPARISON accepts a string, so it
worked; the line that throws is in the branch that raises an alert. So it only
failed when a rule actually fired, on a cache hit. AML screening had effectively
stopped, and for a bank that is a compliance failure rather than a bug.

**Q5. How did you stop it recurring?**
Not by patching that call site, because it was the third time the same trap had
bitten -- business date, user record, then this. The cache helper now takes a
`revive` hook, applied to the loader result as well as the cache hit. That
second part is the real fix: if it only ran on hits, a miss would return a
Decimal and a hit a string, so behaviour would depend on cache state, which is
exactly how it stayed invisible. Two regression tests assert that a miss and a
hit return the same shape, and one of them documents the trap explicitly.

**Q6. Your containers stayed "healthy" through a database outage. Explain.**
The HEALTHCHECK probes `/readiness`, which was correctly returning 503 within
seconds. But it runs every 15 seconds with 3 retries, so it needs up to 45
seconds to flip, and the outage was 26. The signal was right and the reporting
was too slow. That is deliberate in one sense -- a container healthcheck decides
"should this be replaced", and making that twitchy causes restart storms. The
mistake is using it to decide "should traffic come here". Those are different
questions with opposite latency requirements, which is why the load balancer
should poll `/readiness` directly rather than reading container health.

**Q7. You found 526 error log lines for a completely successful operation. So?**
They were `Unique constraint failed on (dedupe_key)` -- the AML idempotency
guard doing exactly its job, caught by the application and logged at debug.
Prisma's own error hook fires for every driver error regardless of whether the
caller handled it. Nothing was wrong, and the error log said otherwise five
hundred times. That is how operators learn to scroll past an error log, and how
any errors-per-minute alert becomes noise. I demoted expected constraint
violations to debug; the same operation now produces zero error lines.

**Q8. What would you do differently before the next incident?**
Two things. First, add a check that every resilience control has a caller --
"is it wired" is a different question from "does it work", and only the second
has tests. Second, treat a pending alert as a finding rather than as noise. The
2,116 dead AML jobs were visible in an alert the whole time and I nearly
dismissed them as leftovers from my own testing.

---

## 10. Honest gaps

- **Not every planned incident was run.** Disk-full, clock skew, a partial
  network partition between two specific containers, and a slow disk were all
  considered and not executed -- the first two are hard to contain safely on a
  developer machine and the others need traffic control that Docker Desktop on
  Windows does not expose cleanly.
- **1,916 dead letters remain unreplayed.** Two batches of 100 were replayed to
  prove the path works. Draining the rest is deliberate operator work, paced so
  it does not recreate the Phase 15 AML burst.
- **The circuit breaker thresholds are unmeasured choices.** 5 failures, 5s
  cooldown, 2 successes are reasonable defaults, not tuned values.
- **No incident was run against the write path under a dependency failure.**
  What a posting does when Postgres dies mid-transaction was not tested here;
  Phase 10's chaos tests cover part of it.
- **`events` queue dead letters are deliberately synthetic** -- they say
  "SIMULATED failure" and came from Phase 7's own tests.
- **No automated incident harness.** Every incident was run by hand. A real
  practice would script them and run them on a schedule.

---

## 11. Measured summary

| Incident | Metric | Before | After |
|---|---|---|---|
| Cache stopped | rps / errors | 142 / **0** | -- (working as designed) |
| Cache hung | rps | **58** | **303** (breaker) |
| Cache hung | p50 | 335.5ms | **59.4ms** |
| Cache hung | detectable? | **no** (`available=1`) | **yes** (`circuit_state=OPEN`) |
| Postgres stopped | readiness | 503 in seconds | unchanged |
| Postgres stopped | container health | **healthy for 26s of outage** | finding, not fixed |
| pgBouncer hung | error rate | 1.1%, no pile-up | unchanged |
| AML dead letters | count | **2,116** | 0 new after the fix |
| AML alerts raised | count | **0** (every firing rule crashed) | 19 |
| DLQ replay | available? | **no caller existed** | `pnpm dlq:replay` |
| Replay log noise | error lines / 100 jobs | **526** | **0** |
| Controls wired to nothing | count | **3** | 0 |
| Tests | | 30 / 100 | **30 / 102** |
