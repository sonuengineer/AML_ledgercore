# LedgerCore API image.
#
# One Dockerfile, several stages. The runtime stage carries only what the
# process needs at 03:00 on a Tuesday: node, production dependencies, the
# compiled dist/ and a Prisma query engine that matches this libc.
#
# The worker (Phase 7, src/worker.ts -- not written yet) ships from THIS SAME
# image with a different CMD. See docs/docker.md. Rationale: the worker imports
# the same domain modules as the API, so a second image would be the same bytes
# with a different entrypoint plus a second thing to keep in sync.

# ---------------------------------------------------------------------------
# Stage 1 -- deps: full dependency tree (dev included), cached on the lockfile
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

# See the prod-deps stage for why the openssl CLI is installed before anything
# runs `prisma generate`.
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# schema.prisma comes along because @prisma/client's postinstall runs
# `prisma generate`; without the schema it emits a stub client and the build
# stage would have to fight it.
COPY package.json pnpm-lock.yaml ./
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2 -- build: generate the Prisma client, compile TypeScript
# ---------------------------------------------------------------------------
# This stage is also the image used by the compose `migrate` service: it is the
# only stage that has the Prisma CLI and the migrations directory together.
FROM node:20-alpine AS build

RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# tsconfig.build.json excludes tests/ and prisma/, so no test tree and no
# seed script reach dist/.
RUN pnpm exec prisma generate \
 && pnpm exec tsc -p tsconfig.build.json

# ---------------------------------------------------------------------------
# Stage 3 -- prod-deps: production-only tree with a musl Prisma engine
# ---------------------------------------------------------------------------
# The Alpine/OpenSSL trap: prisma/schema.prisma declares no `binaryTargets`
# (and this task may not edit it), so Prisma picks the engine by sniffing the
# machine it generates on. Generate on Debian/glibc and copy the result into
# Alpine and the client dies at first query with "Unable to require
# libquery_engine-debian-openssl-3.0.x.so.node".
#
# The fix used here: install production dependencies on the SAME Alpine base as
# the runtime stage and run `prisma generate` there. Detection then yields
# linux-musl-openssl-3.0.x, which is what /usr/lib/libssl.so.3 on this image
# actually provides. Nothing is copied across libc boundaries.
#
# The CLI comes via `dlx` because `prisma` is a devDependency and this tree must
# stay production-only.
FROM node:20-alpine AS prod-deps

# `apk add openssl` is load-bearing, not hygiene. Prisma 5.22 decides which
# engine to emit by asking `openssl version`; node:20-alpine ships the
# libraries (/usr/lib/libssl.so.3) but not the CLI, so detection fails, prints
# "Prisma failed to detect the libssl/openssl version to use ... Defaulting to
# openssl-1.1.x" -- a warning, not an error, so the build goes green -- and
# writes libquery_engine-linux-musl.so.node, which wants libssl.so.1.1. Alpine
# 3.23 does not have libssl.so.1.1. The container then starts, passes its own
# build, and dies on the first query. Measured on this exact image before the
# fix: "Error loading shared library libssl.so.1.1: No such file or directory".
# With the CLI present, detection yields linux-musl-openssl-3.0.x, which links.
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN pnpm install --prod --frozen-lockfile \
 && pnpm dlx prisma@5.22.0 generate \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.local/share/pnpm

# Prune Prisma artefacts the runtime cannot use -- HERE, in prod-deps, and NOT
# in the runtime stage.
#
# That placement is the whole point, and the first attempt got it wrong.
# Deleting these files in the runtime stage removed them from the final
# FILESYSTEM but left the image exactly the same size: 373 MB before, 373 MB
# after. A layer can only ADD. A delete writes a whiteout entry while the bytes
# stay in the earlier COPY layer and are still pulled on every deploy.
#
# `docker history` put node_modules at 124 MB of a 373 MB image, and roughly
# half of that was Prisma shipping things this container never loads:
#
#   3 x 15.4 MB  libquery_engine-linux-musl-openssl-3.0.x.so.node
#                one each in prisma/, @prisma/engines/ and @prisma/client's
#                generated .prisma/client/. Only the LAST is loaded; the other
#                two exist because the `prisma` CLI is a peer dependency of
#                @prisma/client, so pnpm installs it even for a --prod install.
#
#   1 x 17.9 MB  schema-engine -- used ONLY by `prisma migrate`. Migrations run
#                from the separate `migrate` image, never from this one. A
#                schema engine in a production runtime is a tool for altering
#                the database, sitting inside the container that serves it:
#                dead weight and unnecessary capability.
#
#   ~6 MB        query_engine_bg.{mysql,sqlite}.wasm -- Postgres-only app.
#
# Scoped by NAME so it cannot touch the one engine that IS loaded, and the
# build fails loudly if it ever does.
RUN find node_modules -name 'schema-engine-*' -delete  && find node_modules -name 'query_engine_bg.mysql.*' -delete  && find node_modules -name 'query_engine_bg.sqlite.*' -delete  && find node_modules/.pnpm -path '*/prisma@*' -name 'libquery_engine-*' -delete  && find node_modules/.pnpm -path '*@prisma+engines@*' -name 'libquery_engine-*' -delete  && ( test -n "$(find node_modules -path '*.prisma/client/libquery_engine-*' -print -quit)"       || ( echo 'FATAL: pruned the query engine the client loads' && exit 1 ) )


# ---------------------------------------------------------------------------
# Stage 4 -- runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# Why tini rather than `node` as PID 1:
#
#   1. PID 1 has no default signal dispositions. For every other pid the kernel
#      supplies a default action (SIGTERM -> terminate); for PID 1 a signal with
#      no registered handler is discarded. server.ts registers SIGTERM late --
#      after `await connectDatabase()` resolves -- so a `docker stop` issued
#      during that window is silently dropped and the container can only be
#      SIGKILLed. As PID 2 under tini, the same signal kills it immediately and
#      correctly.
#   2. PID 1 is also the orphan reaper. Node does not reap. Prisma runs its
#      query engine as a child process; if it is ever replaced or respawned,
#      the dead one stays a zombie in the container's pid table forever.
#
# `docker run --init` injects the same binary. Baking tini in means the
# guarantee does not depend on whoever writes the run command or the k8s
# manifest remembering a flag.
#
# openssl here is the OTHER half of the trap, and the half that is easy to
# miss: Prisma sniffs the platform TWICE -- once when generating, and again in
# the client at startup to choose which engine file to load. Fixing only the
# build stage produces an image that fails with:
#
#   Prisma Client could not locate the Query Engine for runtime "linux-musl".
#   This happened because Prisma Client was generated for
#   "linux-musl-openssl-3.0.x", but the actual deployment required "linux-musl".
#
# That is the message from this image before openssl was added here: both ends
# were wrong in opposite directions. The apk package also pulls libssl3 and
# libcrypto3, which the engine links against.
RUN apk add --no-cache tini openssl

# Remove npm and corepack from the RUNTIME image.
#
# `docker scout` on this image reported 1 CRITICAL and 19 HIGH fixable
# vulnerabilities. Every single one was in a package this application does not
# depend on: tar, minimatch, brace-expansion, cross-spawn, ip-address, glob,
# sigstore, pacote. `pnpm why` found none of them.
#
# They are npm's OWN bundled dependencies, shipped inside the node base image
# at /usr/local/lib/node_modules/npm. The runtime runs `node dist/server.js`
# and never invokes a package manager, so npm is pure attack surface --
# 20 CVEs and ~10 MB in exchange for nothing.
#
# A scanner reporting vulnerabilities against a production image is not
# automatically a reason to patch dependencies. It is first a reason to ask
# WHICH dependencies, because the answer is often "ones you never installed
# and do not need".
#
# The build stages still have npm; only the runtime does not.
RUN rm -rf /usr/local/lib/node_modules/npm            /usr/local/lib/node_modules/corepack            /usr/local/bin/npm            /usr/local/bin/npx            /usr/local/bin/corepack     && rm -rf /root/.npm /tmp/*

ENV NODE_ENV=production \
    PORT=4000 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

COPY --from=build     --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

# node:20-alpine ships an unprivileged `node` (uid 1000). A container escape is
# a smaller event when the process inside it cannot write to /usr or apk add.
USER node

EXPOSE 4000

# /readiness, not /liveness and not /health:
#   /liveness answers "is the event loop turning", which is true for a process
#   that has lost its database -- Docker would keep such a container marked
#   healthy.
#   /health is the human-readable one and returns a body nobody here parses.
#   /readiness is the one that returns 503 both when Postgres is unreachable
#   and while the process is draining, which is exactly "should traffic go
#   here".
# busybox wget is already in the base image; curl is not, and pulling it in
# would add a package purely for a health probe.
# start-period covers connectDatabase() on a cold Postgres.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:4000/readiness || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

# The single knob that turns this into the worker image. Phase 7 will run the
# identical image with `command: ["node", "dist/worker.js"]`; no rebuild, no
# second Dockerfile, no chance of the two drifting apart.
CMD ["node", "dist/server.js"]
