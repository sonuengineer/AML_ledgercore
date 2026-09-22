# =============================================================================
# LedgerCore frontend.
#
# A React SPA is a pile of static files. The container's job is to build them
# once and serve them fast, which makes this a very different shape from the
# API image: there is no Node at runtime at all.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 -- build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Lockfile first, so a source-only change does not invalidate the install
# layer. Docker caches by layer, and `pnpm install` is by far the slowest step.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# NOT `pnpm build`, which would also run `tsc -b`. Type checking belongs in CI
# (Phase 13) where a failure is a fast, readable signal; running it here makes
# every image build pay for it and buries the error in a build log.
#
# The deliberate consequence: this image can be built from code that does not
# typecheck. CI is what stops that reaching a registry.
RUN pnpm exec vite build

# ---------------------------------------------------------------------------
# Stage 2 -- runtime
#
# nginx, not `vite preview` and not `serve`.
#
# Vite's preview server is explicitly documented as not for production; it is
# single-threaded Node serving static files, which is the worst combination of
# both. nginx does sendfile, gzip and caching in C, and the resulting image has
# no JavaScript runtime in it at all -- so the entire npm CVE surface that cost
# the API image 20 findings simply does not exist here.
#
# WHY `1.31.6-alpine-slim` AND NOT `1.27-alpine`:
#
# The first build of this image used nginx:1.27-alpine and scanned at
# 7C 32H fixable, health score C (56%). Not one of those findings was in
# anything this image does -- they were all OS packages in a base tag that had
# simply aged. A pinned tag does not stay safe; it stays the same while the
# world finds bugs in it. Rebuilding on the current patch release took it to
# 0C 0H.
#
# `-slim` on top of that drops the modules a static-file server never loads
# (njs, geoip, perl, the image-filter/xslt modules): 57 fewer packages, ~14MB
# less, and every one of those packages was a thing that could have a CVE.
# The exact-patch pin (1.31.6, not 1.31 or 1) keeps builds reproducible -- and
# makes the renewal an explicit, reviewable commit rather than a silent drift.
# ---------------------------------------------------------------------------
FROM nginx:1.31.6-alpine-slim AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh

RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

# nginx:alpine already defines an unprivileged `nginx` user, but the stock
# image runs the master as root so it can bind port 80. Running as non-root
# means binding 8080 instead, and letting the ALB or Service map 80 -> 8080.
# For a container that serves static files to the public internet, dropping
# root is worth the extra port mapping.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html \
 && chown -R nginx:nginx /docker-entrypoint.d

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1:8080/healthz || exit 1
