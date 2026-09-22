# Phase 3 -- Node.js Backend Foundation

> Built and verified on 2026-09-21. Project root: `H:\fin\ledgercore`.
> Step-1 topology only: React -> Node API -> PostgreSQL. No Redis, no queue,
> no load balancer. Those arrive in Phases 6, 7 and 8 when there is a measured
> reason for them.

---

## 1. What we built

The 13 items the brief lists for Phase 3, all working against a real database:

| Item | Where | Note |
|---|---|---|
| Environment configuration | `src/config/index.ts` | zod-validated, process refuses to boot on bad config |
| Express application | `src/app.ts` | composition root, does not listen |
| Routing | `src/routes/v1.ts` + per-module routers | versioned from day one |
| Controllers | `src/modules/*/[m].controller.ts` | parse, call one service, shape response |
| Services | `src/modules/*/[m].service.ts` | business rules only, no SQL, no Express |
| Repository layer | `src/modules/*/[m].repository.ts` | all SQL, Prisma errors translated here |
| Validation | `src/shared/http/validate.ts` | zod at the edge, parsed value replaces the raw one |
| Error handling | `src/shared/errors/AppError.ts`, `src/middleware/errorHandler.ts` | one exit point, one envelope |
| Authentication | `src/middleware/authenticate.ts`, `modules/identity/token.service.ts` | JWT with real claims |
| Authorization | `src/middleware/authorize.ts` | permission + branch scoping, server-side |
| Logging | `src/shared/logging/` | pino, redaction, requestId via AsyncLocalStorage |
| Database connection | `src/shared/db/prisma.ts` | pool, query timing, error translation |
| Graceful shutdown | `src/server.ts` | drain -> close -> disconnect -> exit 0 |

Plus the pieces the ledger will need in Phase 5, written now because they are
foundational: `shared/money` (exact decimal money), `shared/http/pagination`
(keyset), and `modules/org` (branch + business date, with `assertPostingAllowed`).

### File count

38 source files. Deliberately not more. The brief says "do NOT give me 500
files"; every file here is one of the 13 items above or directly supports them.

### Schema (Phase 3 subset)

7 tables: `bank`, `branch`, `business_date`, `role`, `permission`,
`role_permission`, `user`. The ledger tables come in Phase 5.

---

## 2. Why we built it this way

Every non-obvious decision traces to a specific defect found in Phase 0.

| Phase 0 defect | What Phase 3 does instead |
|---|---|
| JWT carried zero claims; identity travelled in the request body | Token carries `sub`, `sc` (staff code), `br` (branch), `rl` (role), `typ`. `req.actor` is the only identity source. |
| Login returned 200 OK with a token even on failure | Failure throws; the error middleware renders 401. There is no success path for a failed login. |
| `D002002 (UserCode CHAR(16), Password CHAR(16))` -- 16 chars cannot hold a hash | scrypt N=2^15, r=8, p=1, per-user salt, self-describing encoding, `needsRehash` for future migration to argon2id |
| `FinLogger.PrintToFile("...Pwd: {password}")` | pino `redact` list configured before the first line is ever written |
| Permissions in `Setup/Fin_{GroupId}.mnu` files on each server's disk, enforced only by hiding UI buttons | `role` / `permission` / `role_permission` in Postgres, enforced by `authorize()` on the route |
| Branch code arrived in the request body, so cross-branch access was unpreventable | `assertBranchAccess` compares the URL's branch against the token's branch |
| `FLOAT` for money | `shared/money`: `NUMERIC(19,4)` storage, `decimal.js` arithmetic, branded `Money` string type |
| Voucher state in per-socket `Context.Items` | Nothing is kept in process memory. Any node can serve any request. |
| Long batch jobs inside a WebSocket call | Not yet applicable, but `business_date` status `CLOSING` already models "day end running, no postings" |
| `MaxBadLiPerDay` / `NoOfBadLogins` in the schema but never enforced | Atomic `UPDATE ... SET failed_login_count = failed_login_count + 1` with lockout at 5 |

### Two decisions worth defending in an interview

**Permissions are NOT in the JWT.** A JWT cannot be un-issued. Bake permissions
in and revoking a teller's authorise right takes effect only at token expiry --
up to 15 minutes of someone holding a privilege an officer already removed. So
`authenticate` loads the user's current status and permissions on every request.
The cost is one small indexed lookup per request; Phase 6 moves it to Redis.
That is a measurable cost with a known fix, which beats an unmeasurable hole.

**scrypt, not argon2id.** argon2id is the current OWASP first recommendation.
It is also a native module, and a native module that fails to build on a
developer's machine or in CI is a real delivery risk. scrypt is memory-hard and
in the Node standard library. The gap between well-parameterised scrypt and
argon2id is small next to the gap between either and what the legacy system
does. The `password_algo` column plus the `PasswordHasher` interface make the
switch a per-user rehash on next login rather than a flag day.

---

## 3. How it works

### Middleware order (it is load-bearing)

```
  requestContext   -- request id + AsyncLocalStorage scope. FIRST, so even a
       |              body-parser failure is traceable.
  helmet           -- security headers before anything can respond
       |
  cors             -- explicit allowlist, never a reflected origin
       |
  express.json     -- hard size cap; uncapped JSON is memory exhaustion on a
       |              single-threaded runtime
  requestLogger    -- after parsing (so it can log content-length), before routes
       |
  healthRouter     -- unauthenticated: the LB and orchestrator have no credentials
       |
  /api/v1          -- the API
       |
  notFoundHandler  -- unmatched route -> 404 in the same envelope
       |
  errorHandler     -- single exit, must be last and must be 4-arity
```

### One authenticated request

```
  GET /api/v1/branches/:id/business-date/current
       |
  requestContext    -> X-Request-Id echoed on the response immediately
  authenticate      -> verify JWT (HS256 pinned, iss/aud/exp/typ checked)
                    -> load current user + permissions from Postgres
                    -> req.actor set, log context enriched
  authorize         -> actor.permissions must contain 'branch:read'
  validate          -> params parsed by zod, replaces req.params
  controller        -> assertBranchAccess(req, id)  <- branch scoping
                    -> service.getCurrentBusinessDate(id)
  service           -> repository -> Prisma -> Postgres
                    -> throws BusinessRuleError('DAY_NOT_OPEN') if no open day
  respond.ok        -> { ok: true, data, requestId }
```

### The response envelope

```jsonc
// success
{ "ok": true, "data": { ... }, "meta": { ... }, "requestId": "..." }

// failure -- same shape every time, discriminated by `ok`
{ "ok": false, "error": { "code": "DAY_NOT_OPEN", "message": "...", "details": {...} }, "requestId": "..." }
```

Clients switch on `error.code`, never on `message`, so wording can change
without breaking anyone.

### Graceful shutdown

```
  SIGTERM
    |
  1. readiness returns 503        <- LB stops sending NEW requests
    |
  2. wait DRAIN_DELAY_MS          <- must exceed the LB health check interval,
    |                                or in-flight requests get connection resets
  3. server.close()               <- finish in-flight work, refuse new
    |
  4. prisma.$disconnect()         <- after the last query, not before
    |
  5. exit 0                       (hard timer forces exit 1 if anything hangs)
```

Liveness deliberately does NOT check the database. If it did, a database blip
would make the orchestrator kill and restart every healthy node at once --
turning a recoverable dependency failure into a full outage.

---

## 4. What can fail

| Failure | What happens now | Where it gets better |
|---|---|---|
| Brute force on `/auth/login` | Per-account lockout at 5 attempts. **No IP or global rate limit yet** -- a known gap. | Phase 6, Redis sliding window |
| Postgres unreachable at boot | `connectDatabase()` throws before `listen()`. Process exits 1. Nothing serves 503s to a confused LB. | -- |
| Postgres dies while running | Readiness flips to 503, LB drains the node. Requests in flight fail with 500. | Phase 10, circuit breaker on non-critical reads |
| Slow query | Logged at warn above 200ms with model, operation and duration -- and the requestId | Phase 9, percentile metrics |
| Token stolen | Valid until expiry (15 min). **No revocation** -- a known gap. | Phase 4, refresh rotation + denylist |
| User disabled mid-session | Takes effect on the next request, because permissions are read fresh | -- |
| User moved to another branch | Token's `br` no longer matches; `authenticate` rejects unless `multiBranchAccess` | -- |
| Unhandled promise rejection | `asyncHandler` should prevent it; if one escapes, the process logs fatal and shuts down gracefully rather than serving from an unknown state | -- |
| Deploy mid-request | Drain sequence finishes in-flight work. Nothing is lost, because nothing lives in process memory. | -- |
| Huge request body | Capped at 256kb by `express.json` | -- |
| Deep pagination | Keyset, so page 500 costs the same as page 1 | -- |

### Honest gaps at the end of Phase 3

1. **No rate limiting.** Needs Redis. Phase 6.
2. **No refresh token, no logout, no revocation.** Phase 4.
3. **No idempotency.** Nothing writes yet. Phase 5.
4. **Permission lookup hits Postgres on every request.** Deliberate -- Phase 6
   then has a measured before/after rather than a claim.
5. **No eslint.** Phase 13.
6. **Graceful shutdown could not be verified on Windows**, because Windows does
   not deliver POSIX signals -- `kill -TERM` force-terminates instead of running
   the handler. The drain ordering IS verified by
   `tests/lifecycle.int.test.ts` (readiness flips to 503 while liveness stays
   200 and the node keeps serving). Signal delivery itself is verified under
   Linux in the Docker work.

---

## 5. How to debug it

**One id, end to end.** `requestContext` puts a `requestId` into
AsyncLocalStorage; the pino `mixin` pulls it into every line, including lines
emitted inside services and repositories. It is echoed in the
`X-Request-Id` response header and in the error envelope.

A worked example -- one request, filtered by its id:

```
{"level":"debug","module":"db","msg":"query","model":"User","operation":"findUnique","requestId":"trace-db-logging"}
{"level":"debug","module":"db","msg":"query","model":"RolePermission","operation":"findMany","requestId":"trace-db-logging"}
{"level":"debug","module":"db","msg":"query","model":"Branch","operation":"findMany","requestId":"trace-db-logging","userId":"85fd17c3-..."}
{"level":"info","msg":"request completed","method":"GET","route":"/","status":200,"durationMs":6.14,"requestId":"trace-db-logging","userId":"85fd17c3-..."}
```

Read it: authenticate did two queries (user, then permissions), the controller
did one, total 6.14ms. The first two lines have no `userId` because they run
*during* authentication, before the actor exists. That is correct.

**Why a client extension and not `$on('query')`.** Prisma's `$on('query')` is an
event emitter -- its callback runs on a later tick, outside the AsyncLocalStorage
scope, so the line has no requestId and correlates with nothing. A Prisma client
extension wraps the call inline in the caller's context, so the id attaches
automatically. This was found and fixed during Phase 3 verification.

**Checklist when something is wrong:**

```
  /liveness   503 or no answer  -> process is dead or wedged. Check exit logs.
  /readiness  503               -> dependency down, or draining. Body says which.
  /health                       -> per-dependency status + latency + memory
  grep requestId in logs        -> the whole request, all layers
  grep '"msg":"slow query"'     -> model + operation + duration
  grep '"level":"warn"'         -> every 4xx with its error code
  grep '"level":"error"'        -> unexpected failures only (4xx are warn)
```

---

## 6. Verified behaviour

All of the following was executed against the running API and a real Postgres.

| # | Check | Result |
|---|---|---|
| 1 | Wrong password | 401 `UNAUTHORIZED` |
| 2 | Unknown staff code | 401 `UNAUTHORIZED`, **byte-identical** to #1 (no user enumeration), with a matched-cost dummy hash so timing does not leak either |
| 3 | Empty/short credentials | 400 `VALIDATION_FAILED` with per-field issues |
| 4 | Correct login (T001) | 200, access token + user |
| 5 | Decoded token claims | `sub`, `sc:"T001"`, `br`, `rl:"TELLER"`, `typ:"access"`, `iat`, `exp`, `aud`, `iss` |
| 6 | `GET /auth/me` | permissions resolved server-side: `account:read, branch:read, customer:read, voucher:create, voucher:read` |
| 7 | TELLER calls `GET /users` | 403 `FORBIDDEN`, `details.required: ["user:read"]` |
| 8 | No Authorization header | 401 |
| 9 | AUDITOR (multi-branch) lists branches | 200, 3 branches |
| 10 | TELLER at 101 reads own business date | 200, `{"workingDate":"2026-09-21","status":"OPEN"}` |
| 11 | Same TELLER reads branch 102 | 403 "You may only access your own branch" |
| 12 | Branch 103 (no day opened) | 422 `DAY_NOT_OPEN` |
| 13-14 | Keyset pagination, limit 3 | page 1 `T001, T002, O001`; page 2 via opaque cursor `M001, T101, O101` |
| 15 | Malformed cursor | 400 `VALIDATION_FAILED` |
| 16 | `limit=5000` | 400, capped at 100 |
| 17 | Unknown route | 404 `NOT_FOUND` |
| 18 | Tampered token signature | 401 `UNAUTHORIZED`, `reason: "invalid"` |
| 19 | Inbound `X-Request-Id` | echoed; hostile values (separators, whitespace, 500 chars) replaced with a fresh UUID |
| 20 | 5 bad logins then the CORRECT password | still 401; DB shows `T002 | LOCKED | 5 | locked_until 2026-09-21 06:30:55+00` |

Tests: **17 unit** (`pnpm test`) + **10 integration** (`pnpm test:int`), all
passing. `pnpm typecheck` clean under `strict` plus
`noUncheckedIndexedAccess`.

### A real bug the tests caught

`v1Router.use('/', branchRouter)` combined with `branchRouter.use(authenticate)`
meant every unmatched path under `/api/v1` hit the branch router's authenticate
middleware first -- so `GET /api/v1/does-not-exist` returned **401 instead of
404**. Mounting the router at an explicit `/branches` prefix fixed it. This is
exactly the kind of thing that only shows up when you test the unhappy path.

---

## 7. Interview questions this phase should let you answer

1. Walk me through your middleware order. Why is the request-id middleware
   first, and why is the error handler last?
2. Your JWT has claims. Why not put the user's permissions in it too?
3. Login with a wrong password and login with a non-existent user return the
   same response. Why does that matter, and what else did you have to do
   besides matching the message?
4. Why scrypt and not bcrypt or argon2id? How would you migrate later?
5. What is the difference between `/liveness` and `/readiness`? What breaks if
   liveness checks the database?
6. Describe your graceful shutdown sequence. Why does readiness flip to 503
   *before* `server.close()` and not after?
7. Why keyset pagination instead of `LIMIT`/`OFFSET`? What correctness problem
   does it fix, not just what performance problem?
8. Money is a string in your code. Why? What does `node-postgres` return for a
   `NUMERIC` column, and what happens if someone "fixes" that?
9. How do you trace one request across the controller, service and database
   layers? Why did `$on('query')` not work for that?
10. A teller reports "it failed at 11:04". What do you ask them for, and what
    do you do with it?
11. Your `authorize` middleware runs a database query per request. Is that not
    a performance problem? (Expected answer: yes, it is a known, measured cost;
    Phase 6 caches it in Redis with explicit invalidation on role change --
    and the reason it is not cached *now* is so the improvement is measurable.)
12. What stops a teller at branch 101 from reading branch 102's data?

---

## 8. How to run it

```
cd H:\fin\ledgercore
pnpm install
docker compose up -d postgres
pnpm db:migrate        # or db:deploy for an existing database
pnpm db:seed
pnpm dev               # http://localhost:4000

pnpm typecheck
pnpm test              # unit,        no database needed
pnpm test:int          # integration, needs the compose postgres
pnpm build && pnpm start
```

Seeded dev users, all with password `ChangeMe#2026`:
`T001`/`T002` TELLER, `O001`/`O101` OFFICER, `M001` BRANCH_MANAGER,
`A001` AUDITOR (multi-branch), `S001` SYS_ADMIN.
Branch 103 intentionally has no open business date. `T002` is intentionally
LOCKED after the lockout test.

---

## 9. Next

**Phase 4 -- Authentication in full**: refresh token rotation with a token
family and reuse detection, logout and revocation, password change with policy,
token expiry strategy, and the security trade-offs behind each choice.

In parallel (independent file sets): a React frontend against this API, and
Docker plus CI -- which is also where the SIGTERM path gets verified on Linux.
