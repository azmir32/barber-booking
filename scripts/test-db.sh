#!/usr/bin/env bash
# Runs the database migrations and behaviour tests against a throwaway local
# Postgres (16+). Needs initdb/pg_ctl/psql on PATH or in /usr/lib/postgresql/*/bin.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
pgbin="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")"
tmp="$(mktemp -d)"
trap '"$pgbin/pg_ctl" -D "$tmp/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

"$pgbin/initdb" -D "$tmp/data" -U postgres --auth=trust >/dev/null
"$pgbin/pg_ctl" -D "$tmp/data" -o "-k $tmp -c listen_addresses=''" -l "$tmp/log" -w start >/dev/null

run() { psql -h "$tmp" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
run -f "$root/supabase/tests/supabase_stub.sql"
for f in "$root"/supabase/migrations/*.sql; do run -f "$f"; done
run -f "$root/supabase/tests/booking_test.sql"
