#!/usr/bin/env bash
# End-to-end tests: builds the web app, starts a throwaway Postgres, PostgREST
# and a small Supabase stand-in (e2e/backend/gateway.mjs), then drives the app
# in Chromium with Playwright.
#
# Needs: Postgres 16+ binaries, a PostgREST 12 binary (set POSTGREST=/path or
# have `postgrest` on PATH), and Playwright's Chromium.
# Extra arguments are passed to `playwright test`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

pgbin="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"
postgrest="${POSTGREST:-$(command -v postgrest || true)}"
if [[ -z "$postgrest" ]]; then
  echo "PostgREST not found. Set POSTGREST=/path/to/postgrest." >&2
  exit 1
fi

export JWT_SECRET="e2e-only-secret-at-least-32-characters-long"
PG_PORT=54320
REST_PORT=54322
export GATEWAY_PORT=54321

tmp="$(mktemp -d)"
chmod 1777 "$tmp"
# Postgres refuses to run as root, so use the postgres user when we are root.
as_pg() { if [[ "$(id -u)" == 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  as_pg "$pgbin/pg_ctl" -D "$tmp/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

wait_for() {
  for _ in $(seq 1 100); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 0.2
  done
  echo "Timed out waiting for $1" >&2
  exit 1
}

anon_key="$(node -e "
  import('./e2e/backend/jwt.mjs').then(({ signJwt }) =>
    console.log(signJwt({ role: 'anon', iss: 'e2e', iat: 0, exp: 4102444800 }, process.env.JWT_SECRET)))")"

echo "› Building the web app"
EXPO_PUBLIC_SUPABASE_URL="http://127.0.0.1:$GATEWAY_PORT" \
EXPO_PUBLIC_SUPABASE_ANON_KEY="$anon_key" \
EXPO_PUBLIC_WEB_URL="http://127.0.0.1:$GATEWAY_PORT" \
EXPO_OFFLINE=1 CI=1 \
  npx expo export --platform web --clear --output-dir "$tmp/web" >"$tmp/build.log" 2>&1 ||
  { cat "$tmp/build.log"; exit 1; }

echo "› Starting Postgres, PostgREST and the gateway"
mkdir "$tmp/data"
[[ "$(id -u)" == 0 ]] && chown postgres "$tmp/data"
as_pg "$pgbin/initdb" -D "$tmp/data" -U postgres --auth=trust >/dev/null
as_pg "$pgbin/pg_ctl" -D "$tmp/data" -l "$tmp/pg.log" -w \
  -o "-p $PG_PORT -k $tmp -c listen_addresses=127.0.0.1" start >/dev/null

psql_run() { psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_run -f supabase/tests/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql_run -f "$f"; done
psql_run -f e2e/backend/setup.sql

PGRST_DB_URI="postgres://authenticator@127.0.0.1:$PG_PORT/postgres" \
PGRST_DB_SCHEMAS=public \
PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET="$JWT_SECRET" \
PGRST_SERVER_HOST=127.0.0.1 \
PGRST_SERVER_PORT=$REST_PORT \
  "$postgrest" >"$tmp/postgrest.log" 2>&1 &
pids+=($!)

PORT=$GATEWAY_PORT \
DATABASE_URL="postgres://postgres@127.0.0.1:$PG_PORT/postgres" \
POSTGREST_URL="http://127.0.0.1:$REST_PORT" \
STATIC_DIR="$tmp/web" \
  node e2e/backend/gateway.mjs >"$tmp/gateway.log" 2>&1 &
pids+=($!)

wait_for "http://127.0.0.1:$REST_PORT/"
wait_for "http://127.0.0.1:$GATEWAY_PORT/"

echo "› Running Playwright"
status=0
npx playwright test -c e2e/playwright.config.ts "$@" || status=$?
if [[ $status != 0 ]]; then
  echo "--- postgrest.log"; tail -20 "$tmp/postgrest.log"
  echo "--- gateway.log"; tail -20 "$tmp/gateway.log"
fi
exit $status
