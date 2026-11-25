#!/bin/bash
# Provision the isolated PostgreSQL role, template database, filestore mirror DB, and initial
# demo/runbot slot databases on the Hetzner VPS (`odoo-ts-pg` container).
#
# Run on the VPS (or via `ssh vps 'bash -s' < worker/vps/setup_demo_pg.sh`), idempotent:
#   DEMO_SLOTS=20 bash setup_demo_pg.sh
#
# Security:
#   - Dedicated role `odoo_demo` (LOGIN, NOSUPERUSER, CREATEDB) with password in ~/odoo-ts-pg/demo.pass (0600).
#   - `REVOKE CONNECT ... FROM PUBLIC` on odoo_db, odoo_ts_files, dev_site1_test, poc_corpus, poc_erp
#     (explicitly preserving CONNECT for odoo_app) so `odoo_demo` cannot connect to or read production DBs.
#   - `demo_template` is cloned from `odoo_db` via pg_dump/pg_restore (owned by `odoo_demo`), scrubbed
#     of device logs, with admin's password set to `admin` (600,000-round pbkdf2_sha512).
set -euo pipefail

CONTAINER="${PG_CONTAINER:-odoo-ts-pg}"
SUPERUSER="${PG_SUPERUSER:-odoo_ts}"
DEMO_ROLE="${DEMO_ROLE:-odoo_demo}"
SOURCE_DB="${SOURCE_DB:-odoo_db}"
TEMPLATE_DB="${DEMO_TEMPLATE_DB:-demo_template}"
FILES_DB="${DEMO_FILES_DB:-odoo_demo_files}"
DEMO_SLOTS="${DEMO_SLOTS:-50}"
BASE_DOMAIN="${DEMO_BASE_DOMAIN:-example.com}"
SLOT_PREFIX="${DEMO_SLOT_PREFIX:-odoo-ts-}"
RUNBOT_HOST="${DEMO_RUNBOT_HOST:-odoo-ts-runbot.${BASE_DOMAIN}}"
PASS_DIR="${ODOO_TS_PG_DIR:-$HOME/odoo-ts-pg}"
PASS_FILE="$PASS_DIR/demo.pass"

psql_su() {
  docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -v ON_ERROR_STOP=1 "$@"
}

mkdir -p "$PASS_DIR"
chmod 700 "$PASS_DIR"
if [ ! -s "$PASS_FILE" ]; then
  umask 077
  python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")' > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  echo "setup_demo_pg: generated new password at $PASS_FILE"
fi
DEMO_PASS=$(cat "$PASS_FILE")

# 1. Create or update the isolated odoo_demo role (NOSUPERUSER, CREATEDB, LOGIN)
psql_su -d postgres -v role="$DEMO_ROLE" -v pass="$DEMO_PASS" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'role', :'pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'role', :'pass')
\gexec
SQL

# 2. Allow odoo_demo over TCP with scram-sha-256 in pg_hba.conf (before the final reject)
docker exec -i "$CONTAINER" sh -s "$DEMO_ROLE" <<'SH'
set -eu
ROLE="$1"
HBA="/var/lib/postgresql/data/pg_hba.conf"
if ! grep -q "^host all $ROLE all scram-sha-256" "$HBA"; then
  cp "$HBA" "$HBA.bak-demo-$(date -u +%Y%m%dT%H%M%SZ)"
  awk -v line="host all $ROLE all scram-sha-256" '
    /^host all all all reject/ && !inserted { print line; inserted=1 }
    { print }
    END { if (!inserted) print line }
  ' "$HBA" > "$HBA.tmp"
  mv "$HBA.tmp" "$HBA"
  echo "setup_demo_pg: added $ROLE to pg_hba.conf"
fi
SH
psql_su -d postgres -c "SELECT pg_reload_conf();" >/dev/null

# 3. Isolate existing non-demo databases so odoo_demo cannot connect to them
for prod_db in odoo_db odoo_ts_files dev_site1_test poc_corpus poc_erp; do
  psql_su -d postgres -v db="$prod_db" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO odoo_app; REVOKE CONNECT ON DATABASE %I FROM PUBLIC;', :'db', :'db')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db')
\gexec
SQL
done

# 4. Build (or rebuild) demo_template from odoo_db owned by odoo_demo
echo "setup_demo_pg: cloning $SOURCE_DB -> $TEMPLATE_DB (owned by $DEMO_ROLE)..."
psql_su -d postgres -c "ALTER DATABASE $TEMPLATE_DB WITH is_template = false ALLOW_CONNECTIONS = true;" 2>/dev/null || true
psql_su -d postgres -c "DROP DATABASE IF EXISTS $TEMPLATE_DB WITH (FORCE);"
psql_su -d postgres -c "CREATE DATABASE $TEMPLATE_DB WITH OWNER $DEMO_ROLE TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"

docker exec "$CONTAINER" pg_dump -U "$SUPERUSER" -Fc "$SOURCE_DB" \
  | docker exec -i "$CONTAINER" pg_restore -U "$SUPERUSER" --no-owner --no-privileges --role="$DEMO_ROLE" -d "$TEMPLATE_DB"

# Ensure public schema in demo_template is owned by odoo_demo
psql_su -d "$TEMPLATE_DB" -c "ALTER SCHEMA public OWNER TO $DEMO_ROLE;" >/dev/null

# Generate standard Odoo 600,000-round pbkdf2_sha512 hash of "admin" (passlib adapted base64)
ADMIN_HASH=$(python3 - <<'PY'
import base64, hashlib, secrets
salt = secrets.token_bytes(16)
dk = hashlib.pbkdf2_hmac("sha512", b"admin", salt, 600_000, dklen=64)
ab64 = lambda b: base64.b64encode(b).decode("ascii").rstrip("=").replace("+", ".")
print(f"$pbkdf2-sha512$600000${ab64(salt)}${ab64(dk)}", end="")
PY
)

psql_su -d "$TEMPLATE_DB" -v admin_hash="$ADMIN_HASH" -v base_url="https://odoo-ts-demo.${BASE_DOMAIN}" <<'SQL'
UPDATE res_users SET password = :'admin_hash' WHERE login = 'admin';
DELETE FROM res_device_log;
DELETE FROM res_users_log;
DELETE FROM bus_bus;
UPDATE ir_config_parameter SET value = :'base_url' WHERE key = 'web.base.url';
ANALYZE;
SQL

# Lock template against accidental connections while allowing odoo_demo to clone from it
psql_su -d postgres -c "REVOKE CONNECT ON DATABASE $TEMPLATE_DB FROM PUBLIC;"
psql_su -d postgres -c "GRANT CONNECT ON DATABASE $TEMPLATE_DB TO $DEMO_ROLE;"
psql_su -d postgres -c "ALTER DATABASE $TEMPLATE_DB WITH is_template = true ALLOW_CONNECTIONS = false;"

# 5. Create odoo_demo_files owned by odoo_demo and copy odoo_db runtime attachments under db='demo_template'
echo "setup_demo_pg: syncing $FILES_DB from odoo_ts_files ($SOURCE_DB -> demo_template)..."
psql_su -d postgres -c "DROP DATABASE IF EXISTS $FILES_DB WITH (FORCE);"
psql_su -d postgres -c "CREATE DATABASE $FILES_DB WITH OWNER $DEMO_ROLE TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';"
psql_su -d postgres -c "REVOKE CONNECT ON DATABASE $FILES_DB FROM PUBLIC; GRANT CONNECT ON DATABASE $FILES_DB TO $DEMO_ROLE;"

psql_su -d "$FILES_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS filestore (
  db text NOT NULL,
  fname text NOT NULL,
  size integer NOT NULL,
  mtime bigint NOT NULL,
  data bytea STORAGE EXTERNAL NOT NULL,
  PRIMARY KEY (db, fname)
);
ALTER TABLE filestore OWNER TO odoo_demo;
SQL

docker exec "$CONTAINER" psql -U "$SUPERUSER" -d odoo_ts_files -c \
  "COPY (SELECT 'demo_template'::text AS db, fname, size, mtime, data FROM filestore WHERE db = '$SOURCE_DB') TO STDOUT WITH (FORMAT binary)" \
  | docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -d "$FILES_DB" -c \
  "COPY filestore (db, fname, size, mtime, data) FROM STDIN WITH (FORMAT binary)"

# 6. Pre-create Runbot A/B databases and private slot databases as odoo_demo
clone_db() {
  local db="$1"
  local url="$2"
  local secret
  secret=$(python3 -c 'import uuid; print(uuid.uuid4(), end="")')
  local t0 t1
  t0=$(date +%s%3N)
  docker exec -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" -c "CREATE DATABASE $db WITH TEMPLATE $TEMPLATE_DB OWNER $DEMO_ROLE;" >/dev/null
  docker exec -i -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d "$db" -v ON_ERROR_STOP=1 \
    -v sec="$secret" -v url="$url" >/dev/null <<'SQL'
UPDATE ir_config_parameter SET value = :'sec' WHERE key = 'database.secret';
UPDATE ir_config_parameter SET value = :'url' WHERE key = 'web.base.url';
SQL
  t1=$(date +%s%3N)
  echo "  cloned $db -> $url ($((t1 - t0)) ms)"
}

echo "setup_demo_pg: provisioning Runbot A/B and $DEMO_SLOTS private slots..."
clone_db "demo_runbot_a" "https://${RUNBOT_HOST}"
clone_db "demo_runbot_b" "https://${RUNBOT_HOST}"
for i in $(seq 1 "$DEMO_SLOTS"); do
  clone_db "demo_slot_${i}" "https://${SLOT_PREFIX}${i}.${BASE_DOMAIN}"
done

# 7. Verify scram-sha-256 login over docker network IP (127.0.0.1) and isolation from odoo_db
docker exec -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d demo_slot_1 -c "SELECT current_user, current_database();" >/dev/null
if docker exec -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d odoo_db -c "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: $DEMO_ROLE was able to connect to odoo_db!" >&2
  exit 1
fi
echo "setup_demo_pg: verified $DEMO_ROLE scram-sha-256 auth and isolation from odoo_db"
echo "setup_demo_pg: done ($DEMO_SLOTS slots + runbot A/B ready)"
