# Phase 8 -- Load Balancing and Horizontal Scale

> Built and verified 2026-09-22. Step 3 of the topology:
> nginx -> api-1 / api-2 / api-3 -> Redis + PostgreSQL -> Queue -> N workers.

---

## 1. What we built

```
  deploy/nginx/nginx.conf         round robin, passive health, retry policy
  docker-compose.yml              profile "scale": 3 API nodes, nginx, N workers
  INSTANCE_ID                     diagnostic identity, echoed as X-Instance-Id
```

```
  docker compose --profile scale up -d --scale worker=3
```

```
        client
          |
        nginx :8080
       /    |    \
   api-1  api-2  api-3          (identical, stateless, round robin)
       \    |    /
    +-------+-------+
    |               |
  redis (cache)   postgres      worker-1  worker-2  worker-3
  redis-queue                      (relay + consumers, scaled separately)
```

`INSTANCE_ID` is **observability only**. Nothing behaves differently because of
it. The moment a request's correctness depends on which node served it, the API
has stopped being stateless -- which is the property this phase exists to prove.

---

## 2. Why stateless, and what the legacy system could not do

Phase 0 found the constraint that shaped everything:

```csharp
public async Task<VoucherResponce> FCBS184057_BuildVoucherArray()   // no parameters
{
    CFCBS184057 obj = Context.Items.ContainsKey("obj") ? ... : new CFCBS184057();
    return obj.UIBuildVoucherArray();
}
```

`Context.Items` is per-SignalR-connection, in-process memory. The voucher being
built lived in RAM on one specific server, keyed by a socket. That forced
**sticky sessions**, and sticky sessions cost:

- a dead node lost every in-flight voucher it was holding;
- so did a deploy;
- load distributed by client IP, not by capacity -- one busy branch behind one
  NAT address hammered one node while the others idled.

LedgerCore holds nothing in process memory. Everything shared lives in Postgres
or Redis:

| State | Where it lives | Why not in the process |
|---|---|---|
| Session identity | signed JWT | no server-side session map to replicate |
| Refresh tokens | Postgres | must be revocable across all nodes |
| Permissions | Postgres, cached in Redis | a role change must take effect everywhere |
| Rate-limit counters | Redis | per-process counters give each node its own budget |
| Idempotency records | Postgres + Redis | a retry may land on a different node |
| Business date | Postgres, cached in Redis | value dating must not depend on which node answered |
| Voucher drafts | the client | the legacy mistake, not repeated |
| Generated files | S3 (Phase 11) | local disk is not shared |

So `nginx.conf` uses plain **round robin**, not `ip_hash`. `ip_hash` IS sticky
sessions, and needing it would mean the design had failed.

---

## 3. The proofs

### 3.1 Round robin

```
run A:  api-2 api-3 api-1 api-2 api-2 api-3 api-1 api-2 api-3 api-1 api-2 api-3
run B:  api-1 api-2 api-3 api-1 api-2 api-3 api-1 api-2 api-2 api-3 api-1 api-2
run C:  api-3 api-1 api-2 api-3 api-1 api-2 api-3 api-1 api-2 api-3 api-1 api-2

60 requests:  api-1 = 19,  api-2 = 22,  api-3 = 19
```

(The very first burst after `up -d` all landed on api-1 -- nginx warm-up before
the upstream keepalive pool was established. Not a routing property, and it did
not reproduce.)

### 3.2 A token issued by one node works on every node

```
  logged in on: api-3
    served by api-1 -> 200 M001 perms=11
    served by api-2 -> 200 M001 perms=11
    served by api-3 -> 200 M001 perms=11
    served by api-1 -> 200 M001 perms=11
```

No session was stored anywhere. The legacy system could not do this.

### 3.3 Idempotency survives a retry landing on a different node

```
  attempt 1 on api-2 -> V101-20260921-00303   replayed=no
  attempt 2 on api-3 -> V101-20260921-00303   replayed=true
  attempt 3 on api-1 -> V101-20260921-00303   replayed=true
  attempt 4 on api-2 -> V101-20260921-00303   replayed=true

  vouchers actually created: 1
```

This is the one that matters most on the money path. A client retrying a
timed-out POST has no idea which node it reaches, and it must not post twice.

### 3.4 Killing a node mid-session

```
  before:  api-1 200,  api-2 200,  api-3 200
  docker kill ledgercore-api-2        (hard kill, no graceful drain -- worst case)

  after:   succeeded 20 / 20     failed 0 / 20
  served by: api-3 api-1 api-3 api-1 api-3 api-1 api-3 api-3 api-3
```

Zero client-visible failures. `proxy_next_upstream error timeout` retried the
refused connection on a live node, and the session kept working because the
token is stateless.

On `docker start`, api-2 rejoined on its own once `fail_timeout` expired:

```
  api-1 api-2 api-3 api-1 api-2 api-2 api-3 api-1 api-2
```

### 3.5 Rate-limit budget is shared, not per node

```
  attempt 1 on api-3 -> HTTP 401  remaining=19
  attempt 2 on api-1 -> HTTP 401  remaining=18
  attempt 3 on api-2 -> HTTP 401  remaining=17
  attempt 4 on api-3 -> HTTP 401  remaining=16
```

The counter decrements across nodes because it lives in Redis. Per-process
counters would give each node its own budget, and the effective limit would be
3x what was configured -- a limiter that silently stops limiting the moment you
scale out.

### 3.6 Three relays share the outbox with no contention

300 events, three worker replicas:

```
  drained 300 events with THREE relays in 3207ms

  worker-1: 2 relay batches, 100 events published
  worker-2: 2 relay batches, 100 events published
  worker-3: 2 relay batches, 100 events published

  deadlocks / lock waits:  worker-1: 0   worker-2: 0   worker-3: 0
  SENT: 300        max attempts on any row: 1
```

Exactly 100 each, no deadlocks, and no row processed twice. That is
`FOR UPDATE SKIP LOCKED` doing precisely what Phase 7 claimed: three relays
means three times the throughput, not three times the contention -- with no
leader election and no coordination service.

---

## 4. The throughput result, reported honestly

| | RPS | p50 | p95 | p99 | errors | API CPU |
|---|---|---|---|---|---|---|
| 1 node | 207 / 203 | 162 / 170 ms | 275 / 245 ms | **2119 / 2139 ms** | **8 / 5** | 175% |
| 3 nodes | 250 / 195 | 146 / 149 ms | 299 / 557 ms | **390 / 809 ms** | **0 / 0** | 165% each |

40 concurrent clients, 12 seconds, two measured runs each after warm-up.

**Throughput did not scale. It should not have, and pretending otherwise would
be the dishonest version of this phase.**

The reason is visible in the CPU column. One API node already burns ~175% CPU;
three burn ~165% each, or roughly 500% total, on a host with 12 cores shared by
Postgres, two Redis instances, three API containers, three workers, nginx and
the load generator. **The three "nodes" are not independent machines -- they
compete for the same cores.** Adding containers to one box adds no capacity.

Postgres was never the bottleneck: 21% CPU with one node, 58% with three, and
one active backend at steady state.

### What three nodes DID buy

- **p99 fell from ~2130 ms to 390-810 ms** -- a 2.6x to 5.5x improvement in the
  tail.
- **Errors went from 5-8 per run to zero.**

That is the honest shape of the benefit at this scale: not throughput, but
**headroom and resilience**. With one node every request queues behind a single
event loop, and the tail is where that shows. With three, the queue is shorter
and the occasional slow request does not block everything behind it.

Capacity scaling needs separate machines. That is what Phase 11's ECS tasks
across availability zones provide, and this measurement is the reason to say so
rather than assume it.

---

## 5. nginx configuration decisions

### Round robin, not `ip_hash`

Section 2. `ip_hash` is session affinity and would mean the design had failed.

### Upstream `keepalive 64`

Without it nginx opens a new TCP connection per request, and at any real rate
the nodes run out of ephemeral ports long before they run out of CPU. Requires
`proxy_http_version 1.1` and `proxy_set_header Connection ""` -- the default
`Connection: close` tears the pooled connection down after every request.

### `X-Forwarded-For`, and why it is load-bearing

Express has `trust proxy` set, so `req.ip` reads this header. Without it every
request appears to come from the load balancer, and the Phase 6 per-IP login
rate limit would throttle **nginx** rather than the attacker -- which means one
attacker would lock out every legitimate user.

### Retry policy: NOT `non_idempotent`

```nginx
proxy_next_upstream error timeout;
```

nginx will not retry a POST by default, and that default is correct here. A
`POST /vouchers` that timed out may well have **committed**; retrying it at the
balancer would be a second posting attempt the client never asked for. Retries
on the money path belong to the client, which holds the `Idempotency-Key` that
makes them safe.

`error timeout` still covers the case that matters -- a node that is down or
refusing connections, where nothing was executed. That is what made proof 3.4
show zero failures.

### Passive health checks, and the gap they leave

nginx OSS has no active health checking (that is nginx Plus). `max_fails=2
fail_timeout=10s` is passive: a node is removed after two real requests fail.

The consequence, stated rather than hidden: **a node whose `/readiness` has
gone 503 keeps receiving traffic until two real requests fail.** The graceful
drain built in Phase 3 assumes a balancer that actively polls readiness. An ALB
does; nginx OSS does not.

That is a concrete, measured reason Phase 11 uses an ALB rather than running
nginx as the balancer -- not a preference.

---

## 6. The compose bug worth naming

`--scale worker=3` failed:

```
WARNING: The "worker" service is using the custom container name
"ledgercore-worker". Docker requires each container to have a unique name.
```

It warned and then **silently ran one worker**. The first version of proof 3.6
therefore measured a single relay while claiming three. Caught by noticing the
container list had one entry.

Fix: the worker has no `container_name`. The API nodes keep theirs because they
are three **distinct services** that nginx addresses by hostname; the worker is
**one service with N replicas**, which is the shape anything autoscaled must
take -- and is exactly what an ECS desired-count and a k8s Deployment look
like.

The general lesson: a fixed container name is a scaling ceiling of one, and it
fails as a warning rather than an error.

---

## 7. What can fail

| Failure | Response |
|---|---|
| A node dies hard | nginx retries on `error`/`timeout`; 20/20 requests succeeded. Session survives because the token is stateless. |
| A node is deployed | Graceful drain (Phase 3); but see the passive-health gap in section 5 |
| A node goes unready but stays up | Keeps receiving traffic until 2 requests fail -- nginx OSS limitation, fixed by an ALB in Phase 11 |
| A retry lands on a different node | Idempotency record is shared; proven in 3.3 |
| nginx itself dies | Single point of failure here. In AWS the ALB is managed and multi-AZ; that is one of the reasons to use it. |
| Traffic outgrows three nodes | Add a fourth: one compose entry plus one upstream line. Nothing in the app changes -- which IS the deliverable. |
| Queue backlog grows | Scale workers independently; `queueDepths()` is the signal |
| Three relays contend | They do not -- `SKIP LOCKED`, proven in 3.6 |
| Rate limit bypassed by scaling out | It is not -- the counter is in Redis, proven in 3.5 |

### Honest gaps at the end of Phase 8

1. **nginx is a single point of failure** in this topology, and there is no
   active health checking. Both are resolved by the ALB in Phase 11.
2. **No autoscaling.** Node count is fixed in compose. The signals exist
   (queue depth, CPU, latency) but nothing acts on them.
3. **No TLS.** Plain HTTP end to end; termination is an ALB concern in Phase 11.
4. **The throughput test is bounded by the host**, not by the architecture.
   Real capacity numbers need separate machines, and Phase 15's sizing will be
   labelled as calculation rather than measurement for exactly this reason.
5. **No connection pooling in front of Postgres.** Three nodes at
   `connection_limit=10` is 30 connections plus workers. pgBouncer is Phase 11,
   and this is the phase that makes it necessary.
6. **Carried over and still open:** `invalidateBusinessDate` has no caller
   (Phase 6), the AML workflow is data only (Phase 7).

---

## 8. Interview questions this phase should let you answer

1. Why can you run three instances of this API when the legacy system could
   not?
2. What exactly would break if you turned on `ip_hash`? Would anything?
3. Name everything that had to move out of process memory to make this work.
4. A client retries a POST and it lands on a different node. What happens?
5. You killed a node mid-session and no request failed. Which two mechanisms
   made that true?
6. Why does `proxy_next_upstream` deliberately exclude `non_idempotent`?
7. Your rate limit is 20 per 15 minutes. What is it with three nodes, and why?
8. Three relay processes poll the same outbox table. Why do they not contend,
   duplicate, or need a leader?
9. You added two nodes and throughput did not improve. Why not, and what DID
   improve? (Expected: CPU-bound on a shared host; p99 fell 2.6-5.5x and errors
   went to zero.)
10. Why is `X-Forwarded-For` load-bearing rather than cosmetic here?
11. nginx removes a node after two failed requests. What is wrong with that,
    and what fixes it?
12. How do you add a fourth node? What has to change in the application?
13. Why is the worker one service with three replicas rather than three
    services?

---

## 9. Next

**Phase 9 -- production engineering.** Structured request logging is already
there from Phase 3; what is missing is metrics. RPS, p50/p95/p99, error rate,
CPU, memory, DB and Redis latency, queue depth, and the outbox
oldest-pending-age that Phase 7 identified as the only signal that catches a
stopped relay. Plus a `/metrics` endpoint and the alert thresholds that make
each number actionable.
