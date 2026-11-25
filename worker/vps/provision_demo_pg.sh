#!/usr/bin/env bash
# Provision a dedicated PostgreSQL 16 container (`odoo-ts-demo-pg`) for the public demo,
# isolated from private `odoo-ts-pg` (odoo_db) by container memory/CPU cgroups, volume, and credentials.
#
# Pinned to the exact local `odoo-port-pg` Debian glibc digest (`LC_COLLATE 'C' LC_CTYPE 'en_US.utf8'`)
# so Swedish å/ä/ö collation & lower()/ILIKE match local proofs identically.
#
# Usage (on VPS):
#   DUMP_FILE=/tmp/dev_demo_tmpl.dump DEMO_SLOTS=25 bash worker/vps/provision_demo_pg.sh
set -euo pipefail

IMAGE="${PG_IMAGE:-postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97}"
CONTAINER="${PG_CONTAINER:-odoo-ts-demo-pg}"
NETWORK="${PG_NETWORK:-odoo-ts}"
IP_ADDR="${PG_IP:-127.0.0.1}"
VOLUME="${PG_VOLUME:-odoo-ts-demo-pgdata}"
CPUS="${PG_CPUS:-1.5}"
MEMORY="${PG_MEMORY:-2048m}"
MAX_CONN="${PG_MAX_CONNECTIONS:-60}"
SHARED_BUFFERS="${PG_SHARED_BUFFERS:-512MB}"
SUPERUSER="${PG_SUPERUSER:-odoo_demo_su}"
DEMO_ROLE="${DEMO_ROLE:-odoo_demo}"
TEMPLATE_DB="${DEMO_TEMPLATE_DB:-demo_template}"
FILES_DB="${DEMO_FILES_DB:-odoo_demo_files}"
DEMO_SLOTS="${DEMO_SLOTS:-25}"
BASE_DOMAIN="${DEMO_BASE_DOMAIN:-example.com}"
SLOT_PREFIX="${DEMO_SLOT_PREFIX:-odoo-ts-}"
RUNBOT_HOST="${DEMO_RUNBOT_HOST:-odoo-ts-runbot.${BASE_DOMAIN}}"
PASS_DIR="${ODOO_TS_PG_DIR:-$HOME/odoo-ts-demo-pg}"
SU_PASS_FILE="$PASS_DIR/su.pass"
DEMO_PASS_FILE="$PASS_DIR/demo.pass"
DUMP_FILE="${DUMP_FILE:-}"
KEEP_PREV="${KEEP_PREV:-1}"

mkdir -p "$PASS_DIR"
chmod 700 "$PASS_DIR"

ensure_secret() {
  local f="$1"
  if [ ! -s "$f" ]; then
    umask 077
    python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")' > "$f"
    chmod 600 "$f"
    echo "provision_demo_pg: generated secret at $f"
  fi
}

ensure_secret "$SU_PASS_FILE"
ensure_secret "$DEMO_PASS_FILE"
DEMO_PASS="$(cat "$DEMO_PASS_FILE")"

# 1. Start dedicated Postgres container if not already running
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "provision_demo_pg: creating container $CONTAINER ($IP_ADDR, --cpus $CPUS --memory $MEMORY)..."
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --network "$NETWORK" \
    --ip "$IP_ADDR" \
    --cpus "$CPUS" \
    --memory "$MEMORY" \
    --shm-size 256m \
    -e POSTGRES_USER="$SUPERUSER" \
    -e POSTGRES_PASSWORD_FILE=/run/su.pass \
    -e POSTGRES_DB=postgres \
    -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --lc-collate=C --lc-ctype=en_US.utf8" \
    -v "$SU_PASS_FILE:/run/su.pass:ro" \
    -v "$VOLUME:/var/lib/postgresql/data" \
    "$IMAGE" \
    -c "shared_buffers=$SHARED_BUFFERS" \
    -c "max_connections=$MAX_CONN" \
    -c "max_wal_size=512MB" \
    -c "min_wal_size=80MB" \
    -c "synchronous_commit=off" \
    -c "timezone=UTC"
elif [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]; then
  docker start "$CONTAINER"
fi

echo "provision_demo_pg: waiting for $CONTAINER to accept local connections..."
for _ in $(seq 60); do
  if docker exec "$CONTAINER" pg_isready -U "$SUPERUSER" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U "$SUPERUSER" -d postgres >/dev/null

psql_su() {
  docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -v ON_ERROR_STOP=1 "$@"
}

# 2. Configure strict pg_hba.conf: local socket for superuser, scram-sha-256 over TCP for DEMO_ROLE only, reject all else
docker exec -i "$CONTAINER" sh -s "$DEMO_ROLE" <<'SH'
set -eu
ROLE="$1"
HBA="/var/lib/postgresql/data/pg_hba.conf"
cat > "$HBA.new" <<EOF
# Managed by provision_demo_pg.sh
local   all             all                                     trust
host    all             $ROLE           127.0.0.1/32            scram-sha-256
host    all             $ROLE           127.0.0.1/24          scram-sha-256
host    all             all             all                     reject
EOF
mv "$HBA.new" "$HBA"
chmod 600 "$HBA"
SH
psql_su -d postgres -c "SELECT pg_reload_conf();" >/dev/null

# 3. Create/update DEMO_ROLE with safe demo timeouts and temp_file_limit
psql_su -d postgres -v role="$DEMO_ROLE" -v pass="$DEMO_PASS" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'role', :'pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'role', :'pass')
\gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'role', '120s')
\gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'role', '60s')
\gexec
SELECT format('ALTER ROLE %I SET temp_file_limit = %L', :'role', '128MB')
\gexec
SQL

# 4. Ensure odoo_demo_files exists (owned by DEMO_ROLE)
psql_su -d postgres -v db="$FILES_DB" -v role="$DEMO_ROLE" <<'SQL'
SELECT format('CREATE DATABASE %I WITH OWNER %I TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''en_US.utf8''', :'db', :'role')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db')
\gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC; GRANT CONNECT ON DATABASE %I TO %I;', :'db', :'db', :'role')
\gexec
SQL

psql_su -d "$FILES_DB" -v role="$DEMO_ROLE" <<'SQL'
CREATE TABLE IF NOT EXISTS filestore (
  db text NOT NULL,
  fname text NOT NULL,
  size integer NOT NULL,
  mtime bigint NOT NULL,
  data bytea STORAGE EXTERNAL NOT NULL,
  PRIMARY KEY (db, fname)
);
SELECT format('ALTER TABLE filestore OWNER TO %I', :'role')
\gexec
SQL

# 5. Load clean template dump if provided
if [ -n "$DUMP_FILE" ]; then
  [ -f "$DUMP_FILE" ] || { echo "DUMP_FILE not found: $DUMP_FILE" >&2; exit 1; }
  echo "provision_demo_pg: loading $DUMP_FILE -> $TEMPLATE_DB..."
  if [ "$KEEP_PREV" = "1" ]; then
    HAS_TMPL="$(psql_su -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$TEMPLATE_DB'")"
    if [ "$HAS_TMPL" = "1" ]; then
      psql_su -d postgres -c "ALTER DATABASE ${TEMPLATE_DB}_prev WITH is_template = false ALLOW_CONNECTIONS = true;" 2>/dev/null || true
      psql_su -d postgres -c "DROP DATABASE IF EXISTS ${TEMPLATE_DB}_prev WITH (FORCE);"
      psql_su -d postgres -c "ALTER DATABASE $TEMPLATE_DB WITH is_template = false ALLOW_CONNECTIONS = true;"
      psql_su -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TEMPLATE_DB' AND pid <> pg_backend_pid();" >/dev/null
      psql_su -d postgres -c "ALTER DATABASE $TEMPLATE_DB RENAME TO ${TEMPLATE_DB}_prev;"
      psql_su -d postgres -c "ALTER DATABASE ${TEMPLATE_DB}_prev WITH is_template = true ALLOW_CONNECTIONS = false;"
    fi
  else
    psql_su -d postgres -c "ALTER DATABASE $TEMPLATE_DB WITH is_template = false ALLOW_CONNECTIONS = true;" 2>/dev/null || true
    psql_su -d postgres -c "DROP DATABASE IF EXISTS $TEMPLATE_DB WITH (FORCE);"
  fi

  psql_su -d postgres -c "CREATE DATABASE $TEMPLATE_DB WITH OWNER $DEMO_ROLE TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'en_US.utf8';"
  docker exec -i "$CONTAINER" pg_restore -U "$SUPERUSER" --no-owner --no-privileges --role="$DEMO_ROLE" -d "$TEMPLATE_DB" < "$DUMP_FILE"
  psql_su -d "$TEMPLATE_DB" -c "ALTER SCHEMA public OWNER TO $DEMO_ROLE; ANALYZE;" >/dev/null
  psql_su -d postgres -c "REVOKE CONNECT ON DATABASE $TEMPLATE_DB FROM PUBLIC; GRANT CONNECT ON DATABASE $TEMPLATE_DB TO $DEMO_ROLE; ALTER DATABASE $TEMPLATE_DB WITH is_template = true ALLOW_CONNECTIONS = false;"
fi

# 6. Provision Runbot A/B and DEMO_SLOTS private slots using STRATEGY FILE_COPY
clone_db() {
  local db="$1"
  local url="$2"
  local secret
  secret=$(python3 -c 'import uuid; print(uuid.uuid4(), end="")')
  local t0 t1
  t0=$(date +%s%3N)
  docker exec -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d postgres -v ON_ERROR_STOP=1 \
    -c "SET statement_timeout = 0;" \
    -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" \
    -c "CREATE DATABASE $db WITH TEMPLATE $TEMPLATE_DB OWNER $DEMO_ROLE STRATEGY FILE_COPY;" >/dev/null
  docker exec -i -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h 127.0.0.1 -U "$DEMO_ROLE" -d "$db" -v ON_ERROR_STOP=1 \
    -v sec="$secret" -v url="$url" >/dev/null <<'SQL'
UPDATE ir_config_parameter SET value = :'sec' WHERE key = 'database.secret';
UPDATE ir_config_parameter SET value = :'url' WHERE key = 'web.base.url';
SQL
  t1=$(date +%s%3N)
  echo "  cloned $db -> $url ($((t1 - t0)) ms)"
}

if [ -n "$DUMP_FILE" ] || [ "${REBUILD_SLOTS:-0}" = "1" ]; then
  echo "provision_demo_pg: provisioning Runbot A/B and $DEMO_SLOTS private slots (STRATEGY FILE_COPY)..."
  clone_db "demo_runbot_a" "https://${RUNBOT_HOST}"
  clone_db "demo_runbot_b" "https://${RUNBOT_HOST}"
  for i in $(seq 1 "$DEMO_SLOTS"); do
    clone_db "demo_slot_${i}" "https://${SLOT_PREFIX}${i}.${BASE_DOMAIN}"
  done
fi

# 7. Verify TCP scram-sha-256 auth over docker network IP
docker exec -e PGPASSWORD="$DEMO_PASS" "$CONTAINER" psql -h "$IP_ADDR" -U "$DEMO_ROLE" -d demo_slot_1 -c "SELECT current_user, current_database(), datcollate, datctype FROM pg_database WHERE datname = current_database();"
echo "provision_demo_pg: $CONTAINER ($IP_ADDR) ready!"
