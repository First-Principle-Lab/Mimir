# syntax=docker/dockerfile:1
# Single-command Mimir: web (nginx) + api + worker + postgres (with pgvector) +
# redis in ONE container. No turbo prune (the full repo is needed for
# scripts/migrate.ts + prisma migrations); the entrypoint uses bash job control
# (no supervisord dep) to start the datastores, apply migrations, then supervise
# api/worker/nginx.
#
# Build: docker build -f docker/all/Dockerfile .
# Run:   docker run --rm -p 80:80 -p 4000:4000 -v mimir-pgdata:/var/lib/postgresql/data \
#            -e JWT_SECRET=... -e OPENROUTER_API_KEY=... mimir:all
#
# Requires NEXT_PUBLIC_API_BASE_URL-bearing web default (http://localhost:4000) —
# nothing to bake; the api is exposed on 4000 and the browser reaches it via CORS
# (WEB_APP_URL defaults to http://localhost).

FROM pgvector/pgvector:pg16 AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# bun via the official installer (no bun image — this base is Debian bookworm
# and already carries postgres + pgvector, which we must build on).
ENV BUN_INSTALL=/root/.bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /app

# Full-repo deps: pruned installs would strip scripts/migrate.ts (turbo prune
# only keeps the app subtrees) — but migrations are mandatory for a self-booting
# container, so install the whole workspace (the documented fallback path the
# per-app Dockerfiles also reference).
FROM base AS installer
COPY . .
RUN bun install --frozen-lockfile

# Next.js static export — same command as apps/web/Dockerfile.
FROM base AS web-build
COPY --from=installer /app/ .
RUN cd apps/web && bun run build

FROM base AS runner
ENV NODE_ENV=production
ENV WEB_APP_URL=http://localhost
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx redis-server \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default
COPY --from=web-build /app/ /app/
COPY --from=web-build /app/apps/web/out /usr/share/nginx/html
COPY docker/all/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/all/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /var/lib/postgresql/data \
 && chown postgres:postgres /var/lib/postgresql/data

EXPOSE 80 4000
CMD ["/entrypoint.sh"]