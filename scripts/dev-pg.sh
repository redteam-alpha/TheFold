#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Ephemeral local PostgreSQL 16 for database tests (no Docker needed).
#
#   scripts/dev-pg.sh start    create (if needed) and start the cluster, then print env vars
#   scripts/dev-pg.sh stop     stop it
#   scripts/dev-pg.sh reset    stop and delete the data directory
#   scripts/dev-pg.sh env      print the env vars only:  eval "$(scripts/dev-pg.sh env)"
#
# Uses trust authentication on 127.0.0.1 and a non-default port: for tests only, never for real data.
set -euo pipefail

PORT="${FOLD_PG_PORT:-54329}"
DATA="${FOLD_PG_DATA:-/tmp/thefold-pg/data}"
LOG="${FOLD_PG_LOG:-/tmp/thefold-pg/postgres.log}"
BIN="${FOLD_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"

if [[ -z "${BIN}" || ! -x "${BIN}/initdb" ]]; then
  echo "PostgreSQL server binaries not found (set FOLD_PG_BIN)." >&2
  exit 1
fi

# Postgres refuses to run as root; hand over to the postgres OS user when we are root.
as_pg() {
  if [[ "$(id -u)" == "0" ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

print_env() {
  echo "export FOLD_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:${PORT}/postgres"
}

running() { as_pg "${BIN}/pg_ctl" -D "${DATA}" status >/dev/null 2>&1; }

cmd="${1:-start}"
case "${cmd}" in
  start)
    if [[ ! -d "${DATA}" ]]; then
      mkdir -p "$(dirname "${DATA}")"
      [[ "$(id -u)" == "0" ]] && chown postgres:postgres "$(dirname "${DATA}")"
      as_pg "${BIN}/initdb" -D "${DATA}" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
    fi
    if ! running; then
      as_pg "${BIN}/pg_ctl" -D "${DATA}" -l "${LOG}" -w \
        -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
        start >/dev/null
    fi
    echo "PostgreSQL listening on 127.0.0.1:${PORT} (data: ${DATA})" >&2
    print_env
    ;;
  stop)
    running && as_pg "${BIN}/pg_ctl" -D "${DATA}" -m fast -w stop >/dev/null
    echo "stopped" >&2
    ;;
  reset)
    running && as_pg "${BIN}/pg_ctl" -D "${DATA}" -m immediate -w stop >/dev/null || true
    rm -rf "${DATA}"
    echo "data directory removed" >&2
    ;;
  env)
    print_env
    ;;
  *)
    echo "usage: $0 {start|stop|reset|env}" >&2
    exit 2
    ;;
esac
