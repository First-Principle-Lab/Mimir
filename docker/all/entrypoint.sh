#!/usr/bin/env bash
# Single-container Mimir entrypoint: owns postgres + redis lifecycle, applies
# migrations, then supervises api/worker/nginx as children (bash job control —
# no supervisord). Every value is overrideable via env.
set -euo pipefail

export POSTGRES_USER="${POSTGRES_USER:-mimir}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-mimir}"
export POSTGRES_DB="${POSTGRES_DB:-mimir}"
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

PGBIN="$(ls -d /usr/lib/postgresql/*/bin | head -1)"

stop_everything() {
  echo "mimir: shutting down"
  kill 0 2>/dev/null || true
  su postgres -c "${PGBIN}/pg_ctl -D ${PGDATA} -m fast stop" >/dev/null 2>&1 || true
}
trap stop_everything TERM INT EXIT

start_postgres() {
  if [ ! -s "${PGDATA}/PG_VERSION" ]; then
    mkdir -p "${PGDATA}"
    chown postgres:postgres "${PGDATA}"
    # Trust auth on a loopback-only listener; the container only listens on
    # 127.0.0.1 so there is no remote exposure to gate behind a password.
    su postgres -c "${PGBIN}/initdb -D ${PGDATA} -U ${POSTGRES_USER} --auth-local=trust --auth-host=trust"
  fi
  su postgres -c "${PGBIN}/pg_ctl -D ${PGDATA} -o \"-p 5432 -c listen_addresses=127.0.0.1\" -w start"
  su postgres -c "${PGBIN}/createdb -U ${POSTGRES_USER} ${POSTGRES_DB}" >/dev/null 2>&1 || true
  echo "mimir: postgres up (127.0.0.1:5432/${POSTGRES_DB})"
}

start_postgres
redis-server --bind 127.0.0.1 --port 6379 --daemonize no &
nginx -g 'daemon off;' &

cd /app
bun run migrate

bun run apps/api/src/server.ts &
bun run apps/worker/src/index.ts &

echo "mimir: ready — web http://localhost, api http://localhost:4000"
# Exit when the first supervised child exits so the container stops (and the
# orchestrator restarts it) instead of limping along with a dead process.
wait -n