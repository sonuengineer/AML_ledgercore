# Docker and CI

Covers the image, the compose profiles, how the Phase 7 worker image will be
produced, and the graceful-shutdown behaviour that only shows up on Linux.

## Images

One Dockerfile, four stages.

| Stage       | Purpose                                                      | Shipped? |
| ----------- | ------------------------------------------------------------ | -------- |
| `deps`      | Full dependency tree, cached on `pnpm-lock.yaml`              | no       |
| `build`     | `prisma generate` + `tsc -p tsconfig.build.json`              | used by the compose `migrate` service |
| `prod-deps` | Production-only `node_modules`, Prisma engine for musl        | no       |
| `runtime`   | node:20-alpine, non-root, `dist/` + production deps           | yes      |

Build:

    pnpm docker:build
    # or: docker build --target runtime -t ledgercore-api:local .

Measured image size: **348 MB** (`ledgercore-api:local`). The `build` stage image used by the `migrate` service is 485 MB and is never shipped.

## The Alpine / OpenSSL trap

Worth reading before changing anything in the Dockerfile, because both failure
modes are silent at build time and fatal at run time.

`prisma/schema.prisma` declares no `binaryTargets`, so Prisma chooses its query
engine by detecting the platform. It does this **twice**: once when generating,
and again inside the client at startup when it picks which `.so.node` to load.
Detection shells out to `openssl version`. `node:20-alpine` ships
`libssl.so.3` but not the openssl CLI, so detection fails and falls back to
`openssl-1.1.x`.

Two ways this bites, both observed on this image:

1. **Neither stage has the CLI.** Prisma emits
   `libquery_engine-linux-musl.so.node`, which wants `libssl.so.1.1`. Alpine
   3.23 does not have it:

       Error loading shared library libssl.so.1.1: No such file or directory

2. **Only the generating stage has the CLI.** Generation produces
   `linux-musl-openssl-3.0.x`, but the runtime client still detects
   `linux-musl` and looks for a file that was never generated:

       Prisma Client could not locate the Query Engine for runtime "linux-musl".
       This happened because Prisma Client was generated for
       "linux-musl-openssl-3.0.x", but the actual deployment required "linux-musl".

The fix is `apk add --no-cache openssl` in **every stage that runs
`prisma generate` and in the runtime stage**, plus generating on the same
Alpine base the runtime uses so nothing crosses a libc boundary.

Verify after any change to the base image or the Prisma version:

    docker run --rm --entrypoint sh ledgercore-api:local -c \
      "ldd /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/libquery_engine-*.so.node"

Every line must resolve. `napi_*: symbol not found` is expected and harmless --
those symbols come from the Node host process, not a shared library.

## The worker image (Phase 7)

`src/worker.ts` does not exist yet. Nothing here creates it.

There is no second Dockerfile and there will not be one. The worker imports the
same domain modules as the API, so the two images would be byte-identical apart
from their command. Instead, the worker is **the same image with a different
`CMD`**:

    # compose
    worker:
      image: ledgercore-api:local
      command: ["node", "dist/worker.js"]
      healthcheck:
        disable: true          # no HTTP listener, so /readiness does not exist

    # plain docker
    docker run --rm ledgercore-api:local node dist/worker.js

`ENTRYPOINT` stays `["/sbin/tini", "--"]`, so the worker inherits the same
signal forwarding and orphan reaping the API gets.

What Phase 7 has to add when `src/worker.ts` lands:

1. A `worker` service in `docker-compose.yml` under the `full` profile, with
   `command` and `healthcheck: disable: true` as above.
2. In CI, retag rather than rebuild: `docker tag ledgercore-api:$SHA
   ledgercore-worker:$SHA`. Two build jobs for one set of bytes is wasted time
   and an opportunity for the two to drift.
3. A drain path in `worker.ts` equivalent to `server.ts`: stop accepting new
   jobs, finish the in-flight one, disconnect Prisma, exit 0. Its
   `stop_grace_period` must exceed the longest job, not the drain delay.

## Compose profiles

The default behaviour is unchanged -- `postgres` has no `profiles` key, so it
starts whenever it is named and is never skipped.

| Command | What runs |
| ------- | --------- |
| `docker compose up -d postgres` (`pnpm db:up`) | postgres only |
| `docker compose --profile full up -d` (`pnpm docker:up`) | postgres + api on host `4010` |
| `docker compose --profile migrate run --rm migrate` (`pnpm docker:migrate`) | `prisma migrate deploy`, then exits |

Host port **4010**, not 4000, so `pnpm dev` can keep 4000 and both can run at
once. Override with `API_HOST_PORT`.

The `migrate` service builds the `build` stage, not `runtime`: `migrate deploy`
needs the Prisma CLI (a devDependency) and `prisma/migrations/`, neither of
which belongs in a production image.

**Do not run `docker compose down`** unless you mean it. `postgres` has no
profile, so it is included in every `down`. Use `docker compose stop api` or
`docker compose rm -f api`. The named volume `ledgercore_ledgercore-pgdata`
survives a `down` regardless, but the container is recreated.

## Graceful shutdown

`server.ts` drains in this order: readiness flips to 503 -> wait
`DRAIN_DELAY_MS` -> `server.close()` -> disconnect Prisma -> `exit 0`.
`DRAIN_DELAY_MS` is **10 s when `NODE_ENV=production`** and 250 ms otherwise.

This cannot be tested on Windows -- Windows has no POSIX signals, so
`process.on('SIGTERM')` never fires. Inside a Linux container it can be, and
these are real measurements from this image.

### `docker stop` with the default timeout: FAILS

    $ docker stop lc-drain-def2
    EXIT CODE: 137

    "msg":"shutdown initiated"
    "msg":"readiness now reporting not-ready (draining)"
    <killed here>

SIGTERM was delivered at `06:35:21.826`; the container was SIGKILLed at
`06:35:24.858` -- **3.0 s**, on Docker 29.7.2 / Docker Desktop. (The commonly
cited default is 10 s; this host measured 3 s. Either way it is less than the
10 s drain delay, so the outcome is the same.) Exit 137 is 128+9: the process
never reached `server.close()`, never disconnected Prisma, and any in-flight
transaction was abandoned for Postgres to reap. This is the exact failure the
drain sequence exists to prevent.

### `docker stop -t 30`: PASSES

    $ docker stop -t 30 lc-drain-30
    docker stop took 11s
    EXIT CODE: 0

    "signal":"SIGTERM" "drainDelayMs":10000 "msg":"shutdown initiated"
    "msg":"readiness now reporting not-ready (draining)"
    "msg":"http server closed, no in-flight requests remain"
    "msg":"database disconnected"
    "msg":"shutdown complete"

Polled 3 s into the drain, all three probes measured on the same container:

    /readiness  HTTP 503  {"status":"draining"}
    /liveness   HTTP 200  {"status":"alive","uptimeSeconds":4}
    /health     HTTP 503

That split is the whole point: the load balancer (readiness) removes the node,
while the orchestrator's liveness probe keeps its hands off a process that is
deliberately shutting down. Conflate them and the orchestrator restarts every
node you are trying to drain.

### What that means for deployment

Any orchestrator must be told to wait longer than the drain:

- **compose**: `stop_grace_period: 30s` on the `api` service (already set).
- **plain docker**: `docker stop -t 30`, or bake it in with
  `docker run --stop-timeout 30`.
- **ECS**: `StopTimeout: 30` in the container definition (default 30, but set
  it explicitly -- the default has changed before).
- **Kubernetes**: `terminationGracePeriodSeconds: 30` (default 30).

The alternative -- shortening `DRAIN_DELAY_MS` -- is the wrong lever. The delay
is sized against the load balancer's health-check interval times its unhealthy
threshold; cutting it to fit a 10 s stop timeout means the LB is still routing
traffic when the process stops listening, and clients get connection resets
instead of a clean drain. Lengthen the grace period, not the drain.

The budget: `stop_grace_period` (30 s) > `SHUTDOWN_TIMEOUT_MS` (15 s, the app's
own hard-exit guard) > `DRAIN_DELAY_MS` (10 s). Keep that ordering. If the
hard-exit guard fires first the process exits **1**, which is at least a
deliberate, logged failure rather than a SIGKILL.

## tini

`ENTRYPOINT ["/sbin/tini", "--"]`; `node` runs as PID 2 (observed as PID 7 in a
container with a healthcheck). Two reasons:

1. PID 1 has no default signal dispositions. Everywhere else the kernel
   supplies one (SIGTERM terminates); for PID 1 a signal with no registered
   handler is discarded. `server.ts` registers SIGTERM only after
   `await connectDatabase()` resolves, so a `docker stop` in that window would
   be silently dropped and the container could only be SIGKILLed.
2. PID 1 reaps orphans. Node does not. Prisma runs its query engine as a child
   process.

`docker run --init` injects the same binary, but baking it in means the
guarantee does not depend on whoever writes the run command or the k8s
manifest.

## CI

`.github/workflows/ci.yml`, chained with `needs` so the cheapest failure
reports first:

    typecheck -> unit tests -> build -> integration tests -> docker build

The integration job runs a `postgres:16-alpine` service container with a
`pg_isready` health check, then `prisma migrate deploy`, `prisma db seed`,
`pnpm test:int`. The docker job builds and loads the image and smoke-tests it;
nothing is pushed.

### Known gaps

- **No lint step.** ESLint is not configured in this repository -- no
  `.eslintrc*`, no `eslint.config.*`, no eslint dependency. Adding a config was
  out of scope for this change, so CI does not lint. Add
  `typescript-eslint` + a `lint` script and wire it in parallel with
  `typecheck`.
- **No ECR push.** No registry and no OIDC role exist yet. The `docker` job has
  a marked `TODO(Phase 13)` block with the intended
  `configure-aws-credentials` + `amazon-ecr-login` + `build-push-action` steps.
- **`packageManager` is not pinned in `package.json`.** CI pins pnpm via
  `pnpm/action-setup` (`version: 9`) and the Dockerfile via `corepack prepare
  pnpm@9.15.4`. Two places to update instead of one. Adding
  `"packageManager": "pnpm@9.15.4"` to `package.json` would let both infer it,
  but that field was outside the scope of this change.
- **No image vulnerability scan** (trivy/grype) and no SBOM.
- **Coverage is not collected or gated.**
