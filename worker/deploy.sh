#!/bin/bash
# Deploy the Worker for measured runs (D4, D7): https://odoo-ts.example.com behind Cloudflare Access.
#   ./deploy.sh            package the filestore, set the database secret, deploy
# Inputs (0600 files, never printed):
#   ~/.config/odoo-ts/vps-pg-worker.url   postgresql://user:password@127.0.0.1:5432/postgres?sslmode=disable
#     Postgres 16 on your database host, reachable via the Cloudflare Tunnel binding PG_NET.
# The Worker reaches Postgres over TCP with PG_DSN_TEMPLATE (`{db}` in place of the database) through the Cloudflare
# Tunnel binding PG_NET (PG_TUNNEL=1, src/db.ts tunnelStream), so the harness's per-scenario copies keep their names;
# Hyperdrive slots (SLOTS) stay unused for now. PG_URL_FILE=... picks another server (a public one: drop PG_TUNNEL).
# PROXY_MODE: defaults to 0 so client-supplied X-Forwarded-Host is never trusted in production;
# set PROXY_MODE=1 ./deploy.sh when running behind a trusted front proxy (e.g. harness runs).
# DB_FILTER: Odoo's dbfilter. The templates (poc_*), Neon's default database (neondb, while Neon served) a finished experiment and the test sites' databases (dev_site*, served by their own Workers) are hidden, so
# the one remaining database (odoo_db) is chosen without ?db= (monodb), and harness scratch copies still pass. A scratch
# copy left behind breaks monodb (visitors get 404 at /): drop it (harness/dbs.py drop) rather than hide it here.
# odoo_ts_files (C3) is also excluded in the code (src/http/dispatch.ts dbList).
# CRON_DBS: the databases whose ir_cron jobs the scheduled() handler runs (src/models/ir_cron.ts: ported jobs only;
# the others stay due, untouched). Only odoo_db: the harness copies stay inert, as the oracle (max_cron_threads = 0).
# Passwords: Odoo's verify_and_update (src/session/auth.ts verifyAndUpdate): a 1000-round hash of D18's experiment
# (gen/experiment_passwords.py, the remote templates) is valid and replaced by a 600,000-round hash at the first login,
# derived in the session Durable Object (D17). EXPERIMENT_PASSWORD_ROUNDS is no longer deployed (council round 5).
set -euo pipefail
cd "$(dirname "$0")"
PG_URL="${PG_URL_FILE:-$HOME/.config/odoo-ts/vps-pg-worker.url}"
[ -f "$PG_URL" ] || { echo "missing $PG_URL" >&2; exit 1; }
python3 gen/filestore.py
# the database name in the URL's path becomes the per-request `{db}`
python3 -c 'import sys, urllib.parse as u; p = u.urlsplit(open(sys.argv[1]).read().strip()); print(u.urlunsplit(p._replace(path="/{db}")), end="")' "$PG_URL" \
  | npx wrangler secret put PG_DSN_TEMPLATE
# PDF_ENGINE_DBS: only the production database renders PDFs with Browser Run; the map's copies on the site are measured
# without an engine, as the oracle (D8b)
# APPS_INSTALLABLE_DBS (D25, src/modules/apps_visible.ts): in these databases Apps lists only the installed modules and
# those whose install ends on a build this bundle carries; the rest of Odoo and OCA is hidden. Only the production
# database: the harness's copies on the site list every module, as the oracle. APPS_INSTALLABLE_DBS= ./deploy.sh turns
# it off.
# SQL_LOG=1 (the default since 2026-11-12; SQL_LOG=0 ./deploy.sh turns it off): statements, connect and wait time per
# request in `wrangler tail` (src/http/dispatch.ts), which the latency run reads (run/latency_site.sh). Always on, the
# site runs what was measured and the run needs no deploy before and after. Measured locally, 1800 calls each way in
# alternating blocks: wall 34.87 ms without and 34.91 ms with, workerd CPU 19.1 and 19.9 ms per call (the local figure
# includes sending every console line to wrangler dev; docs/infra-2026-11-12.md).
VARS=(--var "PROXY_MODE:${PROXY_MODE:-0}" --var "PG_TUNNEL:${PG_TUNNEL:-1}" --var "SQL_LOG:${SQL_LOG:-1}" --var PROOF_DB:odoo_db --var CRON_DBS:odoo_db --var 'PDF_ENGINE_DBS:^odoo_db$' --var "APPS_INSTALLABLE_DBS:${APPS_INSTALLABLE_DBS-^odoo_db\$}" --var 'DB_FILTER:^(?!poc_|neondb$|dev_latency$|odoo_ts_files$|dev_site)')
# PG_NET is not in wrangler.jsonc (see there), and the new version needs it before PG_TUNNEL=1 can reach Postgres.
# First try: a deploy-only copy of the configuration that takes PG_NET over from the live version
# ({"type": "inherit"}, the binding type attach_pg_net.sh uses for the others), so nothing has to be attached
# afterwards. `wrangler deploy --dry-run` accepts it (env.PG_NET (inherit), 2026-11-11); a real deploy with it has not
# been made yet. When it is refused (or the live version has no PG_NET), the plain deploy and attach_pg_net.sh as before.
# The source map of the bundle about to be deployed, kept on this machine and not uploaded (wrangler.jsonc
# upload_source_maps): the site runs the minified bundle, and a stack trace of `wrangler tail` names index.js:line:column.
# `node stackmap.mjs <the map> <line:column> ...` gives the source file and line. The same build as the deploy's: with
# and without the map the script is the same but for its last line (sha256 compared 2026-11-13). Before the deploy, so
# that no version is live without its map.
MAPDIR="../results/deploy/$(date +%Y%m%d-%H%M%S)"
npx wrangler deploy --dry-run --upload-source-maps --outdir "$MAPDIR" > /dev/null \
  && [ -s "$MAPDIR/index.js.map" ] || { echo "deploy.sh: the source map could not be built ($MAPDIR); nothing deployed" >&2; exit 5; }
echo "deploy.sh: source map $MAPDIR/index.js.map ($(du -h "$MAPDIR/index.js.map" | cut -f1), not uploaded)"
python3 - <<'PYEOF'
import pathlib
s = pathlib.Path("wrangler.jsonc").read_text().rstrip()
assert s.endswith("}")
body = s[:-1].rstrip().rstrip(",")
pathlib.Path("wrangler.deploy.jsonc").write_text(
    body + ',\n  "unsafe": { "bindings": [{ "name": "PG_NET", "type": "inherit" }] }\n}\n')
PYEOF
if npx wrangler deploy -c wrangler.deploy.jsonc "${VARS[@]}"; then
  rm -f wrangler.deploy.jsonc
  echo "deploy.sh: deployed, PG_NET inherited from the live version"
else
  rm -f wrangler.deploy.jsonc
  echo "deploy.sh: the deploy that inherits PG_NET failed (above); deploying without it and attaching it" >&2
  npx wrangler deploy "${VARS[@]}"
  if ! ./attach_pg_net.sh; then
    echo "deploy.sh: deployed, but PG_NET is NOT attached: the site cannot reach Postgres until it is (attach_pg_net.sh)" >&2
    exit 3
  fi
fi
# the deployed version answers /proof from the database (PROOF_DB): a missing binding or a down tunnel fails here
curl -fsS https://odoo-ts.example.com/proof | grep -q "Live Odoo database" \
  || { echo "deploy.sh: /proof shows no database section" >&2; exit 4; }
echo "deploy.sh: /proof reads the database"
