#!/usr/bin/env bash
# Load test: starts a throwaway Postgres and PostgREST, fills them with a
# Malaysia-sized set of shops, customers and bookings (seed.sql), then runs
# the app's busiest requests many at once and a pre-Raya booking rush
# (run.mjs). Takes a few minutes, most of it loading the bookings.
#
# Needs: Postgres 16+ binaries and a PostgREST 12 binary (POSTGREST=/path or
# `postgrest` on PATH).
# Env: SHOPS (default 1000), CUSTOMERS (100000), and run.mjs's CONCURRENCY,
# SECONDS, RUSH and ONLY.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

pgbin="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"
postgrest="${POSTGREST:-$(command -v postgrest || true)}"
if [[ -z "$postgrest" ]]; then
  echo "PostgREST not found. Set POSTGREST=/path/to/postgrest." >&2
  exit 1
fi

export JWT_SECRET="load-only-secret-at-least-32-characters-long"
export SHOPS="${SHOPS:-1000}" CUSTOMERS="${CUSTOMERS:-100000}"
PG_PORT="${PG_PORT:-54350}"
REST_PORT="${REST_PORT:-54352}"
export REST_URL="http://127.0.0.1:$REST_PORT"

tmp="$(mktemp -d)"
chmod 1777 "$tmp"
as_pg() { if [[ "$(id -u)" == 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  as_pg "$pgbin/pg_ctl" -D "$tmp/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

echo "› Starting Postgres"
mkdir "$tmp/data"
[[ "$(id -u)" == 0 ]] && chown postgres "$tmp/data"
as_pg "$pgbin/initdb" -D "$tmp/data" -U postgres --auth=trust >/dev/null
as_pg "$pgbin/pg_ctl" -D "$tmp/data" -l "$tmp/pg.log" -w \
  -o "-p $PG_PORT -k $tmp -c listen_addresses=127.0.0.1 -c shared_buffers=256MB" start >/dev/null

psql_run() { psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_run -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql_run -f "$f"; done
psql_run -f e2e/backend/setup.sql
echo "› Loading $SHOPS shops and $CUSTOMERS customers"
psql_run -v shops="$SHOPS" -v customers="$CUSTOMERS" -f e2e/load/seed.sql
psql_run -At -c "select '  ' || count(*) || ' bookings, ' || pg_size_pretty(pg_database_size(current_database())) || ' in all' from bookings"

PGRST_DB_URI="postgres://authenticator@127.0.0.1:$PG_PORT/postgres" \
PGRST_DB_SCHEMAS=public \
PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$JWT_SECRET" \
PGRST_SERVER_HOST=127.0.0.1 \
PGRST_SERVER_PORT=$REST_PORT \
  "$postgrest" >"$tmp/postgrest.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 100); do curl -s -o /dev/null "$REST_URL/" && break; sleep 0.2; done

node e2e/load/run.mjs
