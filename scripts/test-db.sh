#!/usr/bin/env bash
# Runs the database migrations and behaviour tests against a throwaway local
# Postgres (16+). Needs initdb/pg_ctl/psql on PATH or in /usr/lib/postgresql/*/bin.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pgbin="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | sort -V | tail -1)")"
tmp="$(mktemp -d)"
chmod 1777 "$tmp"
# Postgres refuses to run as root, so use the postgres user when we are root.
as_pg() { if [[ "$(id -u)" == 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }
trap 'as_pg "$pgbin/pg_ctl" -D "$tmp/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

mkdir "$tmp/data"
[[ "$(id -u)" == 0 ]] && chown postgres "$tmp/data"
as_pg "$pgbin/initdb" -D "$tmp/data" -U postgres --auth=trust >/dev/null
as_pg "$pgbin/pg_ctl" -D "$tmp/data" -o "-k $tmp -c listen_addresses=''" -l "$tmp/log" -w start >/dev/null

run() { psql -h "$tmp" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -f "$root/supabase/tests/supabase_stub.sql"
for f in "$root"/supabase/migrations/*.sql; do run -f "$f"; done
run -f "$root/supabase/tests/booking_test.sql"
