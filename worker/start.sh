#!/usr/bin/env bash
# Local track (harness/runner.py): workerd through `wrangler dev`, connecting directly to the harness's Postgres
# (ODOO_PG_DSN_TEMPLATE has `{db}` for the database named by the request, as Odoo's `?db=`/session).
# Production uses Hyperdrive slots instead (wrangler.jsonc SLOTS); nothing here is deployed.
#
# By default use the same immutable Static Assets filestore as the deployed S1 experiment.
# ODOO_FILESTORE_MODE=http opts into the local mutable file server for other scenarios.
set -euo pipefail
cd "$(dirname "$0")"
export NODE_ENV=development
# The file root is the repository's run/filestore, resolved before a snapshot's `cd "$SNAP"` below (round 10 fix 19:
# resolved after it, `$(cd .. && pwd)` was the temporary directory's parent and http mode served /tmp/run/filestore).
ROOT="${ODOO_FILESTORE_ROOT:-$(cd .. && pwd)/run/filestore/filestore}"
# A harness run (runner.start_track sets ODOO_RUN_DB) serves a snapshot of the tree: wrangler dev rebuilds on every
# file change, and with several streams editing src/ a rebuild mid-scenario stalled requests for 20-66 s and closed
# websockets (2026-10-29). Plain `./start.sh` (development) keeps live reloading. ODOO_TRACK_SNAPSHOT=0 opts out.
if [ -n "${ODOO_RUN_DB:-}" ] && [ "${ODOO_TRACK_SNAPSHOT:-1}" = 1 ]; then
  # The snapshot lives in RAM (/dev/shm) when there is one: the worker's own state under it (.wrangler/state-<port>:
  # the session store, the bus and miniflare's stores, all SQLite with synchronous writes) was most of what four gates
  # wrote to the disk, and the disk was what they waited for. F1,F3 four gates at once, twice each (2026-11-10,
  # docs/infra-2026-11-10.md): 4 of 8 green on disk, 8 of 8 in RAM. ODOO_TRACK_TMP=<dir> chooses another place.
  TRACK_TMP="${ODOO_TRACK_TMP:-$([ -d /dev/shm ] && [ -w /dev/shm ] && echo /dev/shm || echo "${TMPDIR:-/tmp}")}"
  mkdir -p "$TRACK_TMP"
  SNAP="$(mktemp -d "$TRACK_TMP/odoo-ts-track-XXXXXX")"
  # removed however this script ends (the trap at the end replaces this one once wrangler runs)
  trap 'rm -rf "$SNAP"' EXIT
  mkdir -p "$SNAP/gen"
  # a prebuilt bundle (below) runs without src: workerd reads only the bundle, the 179 MB of a compiled src stays out of RAM
  [ -n "${ODOO_PREBUILT_BUNDLE:-}" ] || cp -r src "$SNAP/src"
  cp -r gen/out "$SNAP/gen/out"
  cp wrangler.jsonc package.json tsconfig.json "$SNAP/"
  [ -f filestore_server.py ] && cp filestore_server.py "$SNAP/"
  ln -s "$PWD/node_modules" "$SNAP/node_modules"
  # the snapshot's own assets: the checkout's (the filestore) linked, `__gen` written below from the snapshot's gen/out
  # (a shared `__gen` let a worker of another tree overwrite this one's generated data: co_new on 15c6921 read an
  # install_reflection.json without its `tail`, written there by a checkout from before dc4e633)
  mkdir -p "$SNAP/assets"
  for e in "$PWD"/assets/* "$PWD"/assets/.[!.]*; do
    [ -e "$e" ] || continue
    [ "$(basename "$e")" = "__gen" ] || ln -s "$e" "$SNAP/assets/$(basename "$e")"
  done
  echo "serving a snapshot of the worker tree: $SNAP"
  cd "$SNAP"
fi
# generated data too big for the bundle (src/gen_assets.ts): gen/out/<template>/{lang,chart}/*.json and the overlays
# of gen/out/templates.json (src/orm/overlay.ts, as gen/filestore.py) under assets/__gen/
# `assets/__gen` belongs to this tree: a link to another checkout's (run/mkworktree.sh before this) is replaced by a
# directory of its own
if [ -L assets/__gen ]; then rm assets/__gen; fi
OVERLAYS=$(node -e 'const t=require("./gen/out/templates.json");console.log(Object.values(t).filter(x=>x.overlay).map(x=>`gen/out/${x.overlay}/*.json`).join(" "))')
for f in gen/out/*/lang/*.json gen/out/*/chart/*.json gen/out/*/upgrade/*.json gen/out/*/uninstall/*.json $OVERLAYS; do
  [ -e "$f" ] || continue
  # one process per file (cmp), not three (dirname, mkdir, cmp): this loop was most of a start with nothing to copy
  t="assets/__gen/${f#gen/out/}"; [ -d "${t%/*}" ] || mkdir -p "${t%/*}"; cmp -s "$f" "$t" || cp "$f" "$t"
done
PORT="${PORT:-8073}"
# Keep the placeholder outside ${...}: its closing brace would end the shell expansion early.
# ODOO_TS_PG_PORT: the local Postgres of the scratch copies (5433 odoo-port-pg, 5434 the server in RAM, run/pgram.sh)
DEFAULT_DSN="postgresql://track_rw:track_rw@127.0.0.1:${ODOO_TS_PG_PORT:-5433}/{db}"
DSN="${ODOO_PG_DSN_TEMPLATE:-$DEFAULT_DSN}"
FILESTORE_ARGS=()
FS_PID=""
SNAP="${SNAP:-}"
case "${ODOO_FILESTORE_MODE:-assets}" in
  assets) ;;
  http)
    FPORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
    python3 filestore_server.py "$ROOT" "$FPORT" &
    FS_PID=$!
    FILESTORE_ARGS=(--var "FILESTORE_ROOT:$ROOT" --var "FILESTORE_URL:http://127.0.0.1:$FPORT")
    trap 'kill "$FS_PID" 2>/dev/null || true' EXIT INT TERM
    ;;
  *) echo "ODOO_FILESTORE_MODE must be assets or http" >&2; exit 1 ;;
esac
# Each port keeps its own Durable Object state: concurrent instances sharing .wrangler/state crash on SQLITE_BUSY.
EXPERIMENT_ARGS=()  # D18: cheap password hashes on experiment databases only (worker/gen/experiment_passwords.py)
[ -n "${EXPERIMENT_PASSWORD_ROUNDS:-}" ] && EXPERIMENT_ARGS=(--var "EXPERIMENT_PASSWORD_ROUNDS:$EXPERIMENT_PASSWORD_ROUNDS")
# SQL_LOG=1 [SQL_LOG_STATEMENTS=1|<width>] ./start.sh: statements per request on the console, as `deploy.sh` (src/http/dispatch.ts)
# OVERRIDE_GUARD=log: unported create/write/unlink overrides are logged instead of refused (src/orm/override_guard.ts)
[ -n "${OVERRIDE_GUARD:-}" ] && EXPERIMENT_ARGS+=(--var "OVERRIDE_GUARD:$OVERRIDE_GUARD")
# CRON_DBS=<db,...> [TEST_SCHEDULED=1]: the scheduled() handler's databases (Odoo's cron jobs and the files' mirroring
# into odoo_ts_files, src/filestore_mirror.ts), run by GET /__scheduled with TEST_SCHEDULED=1 (worker/vps/files_local_test.py);
# FILES_MIRROR_MAX_FILES / FILES_MIRROR_MAX_BYTES: the mirroring's budget per run. Unset = nothing scheduled, as before.
[ -n "${CRON_DBS:-}" ] && EXPERIMENT_ARGS+=(--var "CRON_DBS:$CRON_DBS")
[ -n "${FILES_MIRROR_MAX_FILES:-}" ] && EXPERIMENT_ARGS+=(--var "FILES_MIRROR_MAX_FILES:$FILES_MIRROR_MAX_FILES")
[ -n "${FILES_MIRROR_MAX_BYTES:-}" ] && EXPERIMENT_ARGS+=(--var "FILES_MIRROR_MAX_BYTES:$FILES_MIRROR_MAX_BYTES")
# FILES_DB_NAME=<db>: a local test's own files database in place of odoo_ts_files (src/filestore_mirror.ts filesDb)
[ -n "${FILES_DB_NAME:-}" ] && EXPERIMENT_ARGS+=(--var "FILES_DB_NAME:$FILES_DB_NAME")
[ "${TEST_SCHEDULED:-}" = 1 ] && EXPERIMENT_ARGS+=(--test-scheduled)
# APPS_INSTALLABLE_DBS=<regex>: Apps lists only the modules this Worker can serve in these databases, as deploy.sh
# sets it (D25, src/modules/apps_visible.ts); unset = every module, as Odoo and every proof
[ -n "${APPS_INSTALLABLE_DBS:-}" ] && EXPERIMENT_ARGS+=(--var "APPS_INSTALLABLE_DBS:$APPS_INSTALLABLE_DBS")
# DB_FILTER=<regex>: Odoo's dbfilter as deploy.sh sets it (src/http/dispatch.ts dbFilter, dbList); unset = every name
[ -n "${DB_FILTER:-}" ] && EXPERIMENT_ARGS+=(--var "DB_FILTER:$DB_FILTER")
# ISOLATE_CACHE=0: measurement only, the isolate's caches across requests unused (src/db.ts isolateCache)
[ -n "${ISOLATE_CACHE:-}" ] && EXPERIMENT_ARGS+=(--var "ISOLATE_CACHE:$ISOLATE_CACHE")
# REGISTRY_SHARE=0: measurement only, the registry's rows always from the database, never the shared cache (src/orm/registry_share.ts)
[ -n "${REGISTRY_SHARE:-}" ] && EXPERIMENT_ARGS+=(--var "REGISTRY_SHARE:$REGISTRY_SHARE")
# PG_PIPELINE=0: no pipelining on the Postgres connection (src/db.ts), as before C2
[ -n "${PG_PIPELINE:-}" ] && EXPERIMENT_ARGS+=(--var "PG_PIPELINE:$PG_PIPELINE")
[ -n "${SQL_LOG:-}" ] && EXPERIMENT_ARGS+=(--var "SQL_LOG:$SQL_LOG" --var "SQL_LOG_STATEMENTS:${SQL_LOG_STATEMENTS:-0}")
# SQL_LOG_STACK=1: with each statement the callers under src/ that sent it (src/db.ts callersOf), for local diagnosis
[ -n "${SQL_LOG_STACK:-}" ] && EXPERIMENT_ARGS+=(--var "SQL_LOG_STACK:$SQL_LOG_STACK")
# LOCAL_DEV: no PDF engine (as the oracle, which has no wkhtmltopdf) and the proof route of the PDF parts
# (src/controllers/report.ts); the deployed Worker has neither.
# the custom domain in wrangler.jsonc is for deploys: locally the Worker keeps the real origin (127.0.0.1:$PORT), as
# the references were recorded behind front.py (otherwise wrangler rewrites the Host and X-Forwarded-Host headers)
# The worker's own state (the session store, the bus and miniflare's stores: SQLite files, one per Durable Object, every
# write synchronous) lives in RAM when there is one, a fresh directory per start that is removed at exit. On the disk
# it was what a proof waited for while other jobs wrote: one proof alone took 5.2 s of port steps on a quiet machine
# and 55.7 and 76.1 s beside a proof suite (Odoo's side 1.9-2.2 s in all three), and the proof worker's directory had
# grown to 777 MB of files nobody reads again (2026-11-10, docs/infra-2026-11-10.md). ODOO_STATE_DIR=<dir> keeps the
# state there instead, across restarts (ODOO_STATE_DIR=.wrangler is the old place).
STATE_TMP=""
if [ -n "${ODOO_STATE_DIR:-}" ]; then
  STATE="$ODOO_STATE_DIR/state-$PORT"
elif [ -d /dev/shm ] && [ -w /dev/shm ]; then
  STATE_TMP="$(mktemp -d "/dev/shm/odoo-ts-state-$PORT-XXXXXX")"
  STATE="$STATE_TMP"
else
  STATE=".wrangler/state-$PORT"
fi
# The inspector port is this Worker's own (PORT + 20000, below the kernel's range of free ports). Left to wrangler it
# is the first free port from 9229, found by trying: two Workers started in the same moment find the same one, and
# one of them dies with `Address already in use (socket "direct:1:default")`. Four started at once, four times: 10 of
# 16 died; with the port given, none (2026-11-12, docs/infra-2026-11-12.md).
# ODOO_PREBUILT_BUNDLE=<dir>: serve the bundle another start of this tree built (proofs/prebuild.py: wrangler dev's own
# bundle, its dev middleware included, copied from its .wrangler/tmp/dev-*), with --no-bundle: no esbuild here. Why: a
# compiled Worker's esbuild stayed resident at 4.9 GB for the Worker's whole life (wrangler dev keeps it for its
# rebuilds), wrangler 1.0 GB, workerd 0.7 GB; three gate groups starting at once took the odoo-ts slice to 19 GB
# (MemoryHigh 17G) and 348-374 s to answer /health, past runner.py's 120 s (2026-11-18, docs/infra-2026-11-18.md).
# The config is wrangler.jsonc as wrangler reads it, with `main` at the bundle's entry.js (its exports re-exported from
# index.js: wrangler's esbuild parse of an 83 MB entry took 3 GB a start) and the files beside it as modules.
BUNDLE_ARGS=()
if [ -n "${ODOO_PREBUILT_BUNDLE:-}" ]; then
  [ -f "$ODOO_PREBUILT_BUNDLE/entry.js" ] || { echo "ODOO_PREBUILT_BUNDLE=$ODOO_PREBUILT_BUNDLE has no entry.js" >&2; exit 1; }
  [ "${TEST_SCHEDULED:-}" = 1 ] && { echo "ODOO_PREBUILT_BUNDLE with TEST_SCHEDULED=1: the scheduled middleware is built into a bundle; start without the prebuilt one" >&2; exit 1; }
  B="$(cd "$ODOO_PREBUILT_BUNDLE" && pwd)"
  node --no-deprecation -e '
    const fs = require("fs");
    const c = require("wrangler").experimental_readRawConfig({ config: "wrangler.jsonc" }).rawConfig;
    c.main = process.argv[1] + "/entry.js";
    c.rules = [{ type: "ESModule", globs: ["**/*.js"] }, { type: "Data", globs: ["**/*.pack"], fallthrough: true }];
    fs.writeFileSync("wrangler.prebuilt.json", JSON.stringify(c, null, 1));
  ' "$B"
  BUNDLE_ARGS=(--no-bundle -c wrangler.prebuilt.json)
  echo "serving the prebuilt bundle $B"
fi
npx wrangler dev "${BUNDLE_ARGS[@]}" --port "$PORT" --ip 127.0.0.1 --show-interactive-dev-session=false --infer-origin-from-routes=false \
  --inspector-port "$(( PORT + 20000 ))" --persist-to "$STATE" \
  --var "PG_DSN_TEMPLATE:$DSN" --var "PROXY_MODE:1" --var "LOCAL_DEV:1" "${FILESTORE_ARGS[@]}" "${EXPERIMENT_ARGS[@]}" \
  --log-level "${WRANGLER_LOG_LEVEL:-warn}" &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" "$FS_PID" 2>/dev/null || true; [ -n "${SNAP:-}" ] && rm -rf "$SNAP"; [ -n "$STATE_TMP" ] && rm -rf "$STATE_TMP"' EXIT INT TERM
wait "$WRANGLER_PID"
