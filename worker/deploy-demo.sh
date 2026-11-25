#!/bin/bash
# Deploy the public Odoo-TS demo & Runbot Worker (`odoo-ts-demo`):
#   - https://odoo-ts-demo.example.com    (launcher, load balancer & FIFO queue)
#   - https://odoo-ts-runbot.example.com  (shared Runbot, resets every 10 min)
#   - https://odoo-ts-1..N.example.com    (private slots, reset after 1 min inactivity)
#
# Inputs:
#   ~/.config/odoo-ts/vps-pg-demo-worker.url  (postgresql://odoo_demo:<pass>@127.0.0.1:5432/postgres?sslmode=disable)
#   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (for wrangler deploy + PG_NET VPC binding)
#
# Optional overrides:
#   DEMO_SLOTS=20 DEMO_IDLE_MS=60000 DEMO_RUNBOT_RESET_MS=600000 ./deploy-demo.sh
set -euo pipefail
cd "$(dirname "$0")"

PG_URL="${DEMO_PG_URL_FILE:-$HOME/.config/odoo-ts/vps-pg-demo-worker.url}"
[ -f "$PG_URL" ] || { echo "missing $PG_URL (run vps/setup_demo_pg.sh first)" >&2; exit 1; }

DEMO_SLOTS="${DEMO_SLOTS:-50}"
DEMO_IDLE_MS="${DEMO_IDLE_MS:-60000}"
DEMO_RUNBOT_RESET_MS="${DEMO_RUNBOT_RESET_MS:-600000}"
BASE_DOMAIN="${DEMO_BASE_DOMAIN:-example.com}"
LAUNCHER_HOST="${DEMO_LAUNCHER_HOST:-odoo-ts-demo.${BASE_DOMAIN}}"
RUNBOT_HOST="${DEMO_RUNBOT_HOST:-odoo-ts-runbot.${BASE_DOMAIN}}"
SLOT_PREFIX="${DEMO_SLOT_PREFIX:-odoo-ts-}"
# /proof's database facts (src/proof_logic.ts): the Runbot's two databases, fresh copies of the template, the first that
# answers. Never demo_template itself: it refuses connections, and one would block every CREATE DATABASE ... TEMPLATE.
PROOF_DB="${DEMO_PROOF_DB:-demo_runbot_a,demo_runbot_b}"

# Always package the filestore and generated assets (assets/__gen, assets/__filestore) as deploy.sh does
python3 gen/filestore.py

# Generate temporary deploy config with routes for launcher, runbot, and odoo-ts-1..N + inherited PG_NET
python3 - "$DEMO_SLOTS" "$BASE_DOMAIN" "$LAUNCHER_HOST" "$RUNBOT_HOST" "$SLOT_PREFIX" "$DEMO_IDLE_MS" "$DEMO_RUNBOT_RESET_MS" "$PROOF_DB" <<'PYEOF'
import json, pathlib, re, sys

slots = int(sys.argv[1])
base_domain, launcher, runbot, prefix = sys.argv[2:6]
idle_ms, runbot_ms, proof_db = sys.argv[6:9]

raw = pathlib.Path("wrangler.demo.jsonc").read_text()
# Strip single-line // comments outside strings
cleaned = re.sub(r'(?m)^\s*//.*$', '', raw)
cfg = json.loads(cleaned)

cfg["vars"]["DEMO_SLOTS"] = str(slots)
cfg["vars"]["DEMO_IDLE_MS"] = str(idle_ms)
cfg["vars"]["DEMO_RUNBOT_RESET_MS"] = str(runbot_ms)
cfg["vars"]["DEMO_BASE_DOMAIN"] = base_domain
cfg["vars"]["DEMO_LAUNCHER_HOST"] = launcher
cfg["vars"]["DEMO_RUNBOT_HOST"] = runbot
cfg["vars"]["DEMO_SLOT_PREFIX"] = prefix
cfg["vars"]["PROOF_DB"] = proof_db

routes = [
    {"pattern": launcher, "custom_domain": True},
    {"pattern": runbot, "custom_domain": True},
]
for i in range(1, slots + 1):
    routes.append({"pattern": f"{prefix}{i}.{base_domain}", "custom_domain": True})
cfg["routes"] = routes

# Plain config (for first deploy / fallback) and inherit-PG_NET config (for subsequent deploys)
pathlib.Path("wrangler.demo.plain.json").write_text(json.dumps(cfg, indent=2) + "\n")
cfg_inherit = dict(cfg)
cfg_inherit["unsafe"] = {"bindings": [{"name": "PG_NET", "type": "inherit"}]}
pathlib.Path("wrangler.demo.deploy.json").write_text(json.dumps(cfg_inherit, indent=2) + "\n")
PYEOF

cleanup() {
  rm -f wrangler.demo.plain.json wrangler.demo.deploy.json
}
trap cleanup EXIT

# 1. Push PG_DSN_TEMPLATE secret pointing to the isolated odoo_demo role (before deploy, matching deploy.sh)
python3 -c 'import sys, urllib.parse as u; p = u.urlsplit(open(sys.argv[1]).read().strip()); print(u.urlunsplit(p._replace(path="/{db}")), end="")' "$PG_URL" \
  | npx wrangler secret put PG_DSN_TEMPLATE -c wrangler.demo.plain.json

# 2. Deploy worker (try inheriting PG_NET first for zero-downtime re-deploys; fall back to plain deploy + attach_pg_net.sh)
if CI=true npx wrangler deploy -c wrangler.demo.deploy.json; then
  echo "deploy-demo.sh: deployed odoo-ts-demo (PG_NET inherited)"
else
  echo "deploy-demo.sh: deploying odoo-ts-demo (initial deploy)..."
  CI=true npx wrangler deploy -c wrangler.demo.plain.json
  if ! ./attach_pg_net.sh odoo-ts-demo; then
    echo "deploy-demo.sh: deployed, but PG_NET could not be attached (check Cloudflare token)" >&2
    exit 3
  fi
fi

# Verify live endpoints
echo "deploy-demo.sh: checking https://${LAUNCHER_HOST}/__demo/status ..."
curl -fsS "https://${LAUNCHER_HOST}/__demo/status"
echo ""
echo "deploy-demo.sh: checking https://${RUNBOT_HOST}/web/login ..."
curl -fsS -I "https://${RUNBOT_HOST}/web/login" | head -n 5
echo "deploy-demo.sh: checking https://${LAUNCHER_HOST}/proof ..."
curl -fsS "https://${LAUNCHER_HOST}/proof" | grep -o 'Installed Odoo modules</th><td>[0-9]*' || echo "deploy-demo.sh: WARNING /proof shows no database facts" >&2
echo "deploy-demo.sh: live and verified!"
