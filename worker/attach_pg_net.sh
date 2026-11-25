#!/bin/bash
# Add PG_NET (Workers VPC binding to the Cloudflare Tunnel odoo-ts-pg) to the deployed odoo-ts Worker; every other
# binding is inherited from the current version. Run after deploy.sh (wrangler.jsonc explains why it is not declared
# there). Needs CLOUDFLARE_API_TOKEN (Workers Scripts Write, Connectivity Directory Bind) and CLOUDFLARE_ACCOUNT_ID in
# the environment: wrangler's OAuth login has no connectivity scope. Without them it exits 2 and the binding has to be
# added another way (on 2026-11-06 the same PATCH went through the Cloudflare API connector).
set -euo pipefail
SCRIPT="${1:-odoo-ts}"
TUNNEL=${CF_TUNNEL_ID:?set CF_TUNNEL_ID}
# Fall back to wrangler's OAuth token when CLOUDFLARE_API_TOKEN is unset (wrangler OAuth now carries connectivity:admin)
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/.config/.wrangler/config/default.toml" ]; then
  CLOUDFLARE_API_TOKEN=$(python3 -c 'import tomllib, pathlib; print(tomllib.loads(pathlib.Path.home().joinpath(".config/.wrangler/config/default.toml").read_text()).get("oauth_token",""), end="")')
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "attach_pg_net.sh: no CLOUDFLARE_API_TOKEN; add PG_NET by hand" >&2; exit 2; }
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts" \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "", end="")')
fi
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "attach_pg_net.sh: no CLOUDFLARE_ACCOUNT_ID" >&2; exit 2; }
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT/settings"
H=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
settings=$(curl -fsS "${H[@]}" "$API" | python3 -c '
import json, sys
names = [b["name"] for b in json.load(sys.stdin)["result"]["bindings"] if b["name"] != "PG_NET"]
print(json.dumps({"bindings": [{"type": "inherit", "name": n} for n in names]
                  + [{"type": "vpc_network", "name": "PG_NET", "tunnel_id": sys.argv[1]}]}))' "$TUNNEL")
curl -fsS -X PATCH "${H[@]}" -F "settings=$settings;type=application/json" "$API" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("PG_NET attached" if r["success"] else r["errors"])'
